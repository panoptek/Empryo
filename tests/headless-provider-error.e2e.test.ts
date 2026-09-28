import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../src/core/sessions/manager.js";

test("headless CLI reports provider stream errors and exits nonzero", async () => {
	const root = mkdtempSync(join(tmpdir(), "headless-provider-error-"));
	const home = join(root, "home");
	const project = join(root, "project");
	const paths: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			paths.push(new URL(req.url).pathname);
			return new Response(null, { status: 307, headers: { Location: "/leak" } });
		},
	});

	try {
		mkdirSync(home);
		mkdirSync(join(project, ".soulforge"), { recursive: true });
		writeFileSync(join(project, ".soulforge", "config.json"), JSON.stringify({
			telemetry: false,
			repoMap: false,
			contextWindowOverrides: { "wire/claude-opus-4-8": 200_000 },
			providers: [{
				id: "wire", api: "anthropic", envVar: "WIRE_TEST_KEY",
				baseURL: `http://127.0.0.1:${server.port}/v1`,
				models: ["claude-opus-4-8"], modelsAPI: false,
			}],
		}));
		const proc = Bun.spawn([
			process.execPath, fileURLToPath(new URL("../src/boot.tsx", import.meta.url)),
			"--headless", "--cwd", project, "--model", "wire/claude-opus-4-8",
			"--json", "--no-repomap", "--max-steps", "2", "--timeout", "15000", "Say OK",
		], {
			cwd: project,
			env: {
				...process.env, HOME: home, WIRE_TEST_KEY: "synthetic-not-secret",
				SOULFORGE_NO_REPOMAP: "1", SOULFORGE_NO_PROMPT: "1", NO_COLOR: "1",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, , exitCode] = await Promise.all([
			new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
		]);
		expect(exitCode).toBe(1);
		expect(JSON.parse(stdout).error).toMatch(/redirect/i);
		expect(paths).toEqual(["/v1/messages"]);

		const chat = Bun.spawn([
			process.execPath, fileURLToPath(new URL("../src/boot.tsx", import.meta.url)),
			"--headless", "--chat", "--cwd", project, "--model", "wire/claude-opus-4-8",
			"--json", "--no-repomap", "--max-steps", "2", "--timeout", "15000",
		], {
			cwd: project,
			env: {
				...process.env, HOME: home, WIRE_TEST_KEY: "synthetic-not-secret",
				SOULFORGE_NO_REPOMAP: "1", SOULFORGE_NO_PROMPT: "1", NO_COLOR: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		chat.stdin.write("Say OK\n");
		chat.stdin.end();
		const [chatOutput, , chatExitCode] = await Promise.all([
			new Response(chat.stdout).text(), new Response(chat.stderr).text(), chat.exited,
		]);
		expect(chatExitCode).toBe(1);
		expect(JSON.parse(chatOutput.trim()).error).toMatch(/redirect/i);
		expect(paths).toEqual(["/v1/messages", "/v1/messages"]);
		const sessionId = readdirSync(join(project, ".soulforge", "sessions"))[0];
		expect(sessionId).toBeDefined();
		const saved = new SessionManager(project).loadSessionMessages(sessionId!);
		expect(saved?.messages.at(-1)).toEqual(expect.objectContaining({
			role: "system", showInChat: true, content: expect.stringMatching(/redirect/i),
		}));
	} finally {
		server.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
