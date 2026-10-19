import { describe, expect, test } from "bun:test";
import type { OpenAIHttpPhaseEvent } from "../src/types";
import { postOpenAIStream } from "../src/utils/openai-http";

const SSE = 'data: {"answer":"completion-marker"}\n\ndata: [DONE]\n\n';
const SSE_BYTES = new TextEncoder().encode(SSE);

function serve(fetch: (request: Request) => Response | Promise<Response>) {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
	return {
		url: new URL("/v1/chat/completions?private=endpoint-marker", server.url).toString(),
		stop: () => server.stop(true),
	};
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
	for await (const _event of events) {
		void _event;
	}
}

describe("opt-in OpenAI HTTP phase diagnostics", () => {
	test("records dispatch, delayed headers and first body byte without request content", async () => {
		const events: OpenAIHttpPhaseEvent[] = [];
		const requestReceived = Promise.withResolvers<void>();
		const releaseHeaders = Promise.withResolvers<void>();
		const server = serve(async () => {
			requestReceived.resolve();
			await releaseHeaders.promise;
			return new Response(SSE, { headers: { "content-type": "text/event-stream" } });
		});

		try {
			const request = postOpenAIStream({
				url: server.url,
				headers: { Authorization: "Bearer secret-marker" },
				body: { messages: [{ role: "user", content: "prompt-marker" }] },
				signal: new AbortController().signal,
				maxAttempts: 1,
				onHttpPhase: event => {
					events.push(event);
					if (event.phase === "request_dispatch") throw new Error("diagnostic callback marker");
				},
			});
			await requestReceived.promise;
			expect(events.map(event => event.phase)).toEqual(["request_dispatch"]);
			releaseHeaders.resolve();
			const handle = await request;
			expect(events.map(event => event.phase)).toEqual(["request_dispatch", "response_headers"]);
			const frames: unknown[] = [];
			for await (const frame of handle.events) frames.push(frame);

			expect(frames).toEqual([{ answer: "completion-marker" }]);
			expect(events.map(event => event.phase)).toEqual(["request_dispatch", "response_headers", "first_body_byte"]);
			const dispatch = events[0];
			expect(dispatch?.request_id).toMatch(/^[0-9a-f-]{36}$/);
			expect(events.every(event => event.request_id === dispatch?.request_id)).toBe(true);
			expect(events[1]?.status_code).toBe(200);

			const serialized = JSON.stringify(events);
			for (const marker of ["secret-marker", "prompt-marker", "completion-marker", "endpoint-marker", "127.0.0.1"])
				expect(serialized).not.toContain(marker);
		} finally {
			server.stop();
		}
	});
	test("records first body-byte timing separately from response headers", async () => {
		const events: OpenAIHttpPhaseEvent[] = [];
		let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
		const handle = await postOpenAIStream({
			url: "http://fake.invalid/v1/chat/completions",
			headers: {},
			body: {},
			signal: new AbortController().signal,
			maxAttempts: 1,
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							bodyController = controller;
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
			onHttpPhase: event => events.push(event),
		});

		expect(events.map(event => event.phase)).toEqual(["request_dispatch", "response_headers"]);
		const controller = bodyController;
		if (!controller) throw new Error("fake endpoint did not start its response body");
		const consumed = drain(handle.events);
		controller.enqueue(SSE_BYTES);
		controller.close();
		await consumed;

		expect(events.map(event => event.phase)).toEqual(["request_dispatch", "response_headers", "first_body_byte"]);
		expect(events[2]?.elapsed_ms).toBeGreaterThanOrEqual(events[1]?.elapsed_ms ?? 0);
	});

	test("records a terminal HTTP error without copying its body", async () => {
		const events: OpenAIHttpPhaseEvent[] = [];
		const server = serve(() => new Response("private-error-marker", { status: 503 }));

		try {
			const error = await postOpenAIStream({
				url: server.url,
				headers: {},
				body: {},
				signal: new AbortController().signal,
				maxAttempts: 1,
				onHttpPhase: event => events.push(event),
			}).then(
				() => undefined,
				(reason: unknown) => reason,
			);

			expect(error).toBeDefined();
			expect(events.map(event => event.phase)).toEqual(["request_dispatch", "response_headers", "request_error"]);
			expect(events[1]?.status_code).toBe(503);
			expect(events[2]?.error_category).toBe("http_status");
			expect(JSON.stringify(events)).not.toContain("private-error-marker");
		} finally {
			server.stop();
		}
	});

	test("records retry attempts under one local request ID", async () => {
		const events: OpenAIHttpPhaseEvent[] = [];
		let requests = 0;
		const server = serve(() => {
			requests++;
			if (requests === 1) {
				return new Response("retry-body-marker", {
					status: 503,
					headers: { "retry-after-ms": "0" },
				});
			}
			return new Response(SSE, { headers: { "content-type": "text/event-stream" } });
		});

		try {
			const handle = await postOpenAIStream({
				url: server.url,
				headers: {},
				body: {},
				signal: new AbortController().signal,
				maxAttempts: 2,
				onHttpPhase: event => events.push(event),
			});
			await drain(handle.events);

			expect(requests).toBe(2);
			expect(events.filter(event => event.phase === "request_dispatch").map(event => event.attempt)).toEqual([1, 2]);
			expect(events.filter(event => event.phase === "response_headers").map(event => event.status_code)).toEqual([
				503, 200,
			]);
			expect(new Set(events.map(event => event.request_id)).size).toBe(1);
			expect(JSON.stringify(events)).not.toContain("retry-body-marker");
		} finally {
			server.stop();
		}
	});

	test("reports an aborted body read without exposing stream content", async () => {
		const events: OpenAIHttpPhaseEvent[] = [];
		const controller = new AbortController();

		try {
			const handle = await postOpenAIStream({
				url: "http://fake.invalid/v1/chat/completions",
				headers: {},
				body: {},
				signal: controller.signal,
				maxAttempts: 1,
				fetch: async () =>
					new Response(new ReadableStream<Uint8Array>({ start() {} }), {
						headers: { "content-type": "text/event-stream" },
					}),
				onHttpPhase: event => events.push(event),
			});
			const consumed = drain(handle.events);
			controller.abort();
			expect(events.some(event => event.phase === "request_error" && event.error_category === "aborted")).toBe(true);
			await consumed;
		} finally {
			controller.abort();
		}
	});
});
