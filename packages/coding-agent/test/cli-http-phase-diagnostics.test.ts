import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

let tempDir: TempDir;
let authStorage: AuthStorage;

beforeAll(async () => {
	tempDir = await TempDir.create("@cli-http-phase-diagnostics-");
	authStorage = createInMemoryAuthStorage();
});

afterAll(async () => {
	authStorage.close();
	await tempDir.remove();
});

test("HTTP phase diagnostics require both JSON mode and explicit opt-in", async () => {
	const previous = process.env.OMP_HTTP_PHASE_DIAGNOSTICS;
	try {
		delete process.env.OMP_HTTP_PHASE_DIAGNOSTICS;
		expect(
			(
				await buildSessionOptions(
					parseArgs(["--mode", "json", "--no-session", "--no-tools"]),
					[],
					SessionManager.inMemory(),
					new ModelRegistry(authStorage, tempDir.join("models.yml")),
					Settings.isolated(),
				)
			).onOpenAIHttpPhase,
		).toBeUndefined();

		process.env.OMP_HTTP_PHASE_DIAGNOSTICS = "1";
		expect(
			(
				await buildSessionOptions(
					parseArgs(["--mode", "text"]),
					[],
					SessionManager.inMemory(),
					new ModelRegistry(authStorage, tempDir.join("models.yml")),
					Settings.isolated(),
				)
			).onOpenAIHttpPhase,
		).toBeUndefined();
		expect(
			typeof (
				await buildSessionOptions(
					parseArgs(["--mode", "json", "--no-session", "--no-tools"]),
					[],
					SessionManager.inMemory(),
					new ModelRegistry(authStorage, tempDir.join("models.yml")),
					Settings.isolated(),
				)
			).onOpenAIHttpPhase,
		).toBe("function");
	} finally {
		if (previous === undefined) {
			delete process.env.OMP_HTTP_PHASE_DIAGNOSTICS;
		} else {
			process.env.OMP_HTTP_PHASE_DIAGNOSTICS = previous;
		}
	}
});
