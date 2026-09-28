import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("headless CLI reports provider stream errors and exits nonzero", async () => {
	const root = mkdtempSync("/tmp/opencode/pr223-headless-error-");
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
	} finally {
		server.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
