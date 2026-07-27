// Real spawned processes, not mocks — same style as
// sequencer/process-supervisor.test.ts, proving this file's newly-supervised
// spawn site (previously a bare Bun.spawn with no process-group ownership,
// see the incident this repo's CLAUDE.md / process-supervisor.ts describe)
// gives the exact same guarantees every sequencer stage spawn already has.
import { afterEach, describe, expect, test } from "bun:test";
import { classifyEngineOutcome, runSupervisedEngine } from "./engine";
import type { SupervisedProcessResult } from "./sequencer/process-supervisor";
import { isAlive, killRecorded, waitUntilGone } from "./sequencer/process-liveness.testing";

const childPids: number[] = [];

afterEach(async () => {
	killRecorded(childPids);
});

function fakeResult(overrides: Partial<SupervisedProcessResult> = {}): SupervisedProcessResult {
	return { pid: 1, exitCode: 0, reason: "exited", stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false, cleanupComplete: true, ...overrides };
}

describe("runSupervisedEngine", () => {
	test("reaps a descendant that escapes the process group with setsid — same guarantee as every sequencer stage spawn", async () => {
		const chunks: string[] = [];
		const result = await runSupervisedEngine(
			["sh", "-c", "setsid sleep 30 >/dev/null 2>&1 & child=$!; echo $child; wait"],
			process.cwd(),
			new AbortController().signal,
			(chunk) => chunks.push(Buffer.from(chunk).toString()),
			() => {},
			{ timeoutMs: 2_000, idleTimeoutMs: 100, termGraceMs: 100 },
		);
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("idle-timeout");
		expect(result.cleanupComplete).toBe(true);
		await waitUntilGone(childPid);
		// engine.ts's own line-splitter reads real output off this exact
		// callback — prove it actually receives the child's stdout, not just
		// that the underlying primitive (already proven in
		// sequencer/process-supervisor.test.ts) works in isolation.
		expect(chunks.join("")).toContain(String(childPid));
	});

	test("stop() (AbortController.abort(), what spawnClaude()'s returned handle now calls) tears down the whole process group", async () => {
		const controller = new AbortController();
		const pending = runSupervisedEngine(
			["sh", "-c", "sleep 30 & child=$!; echo $child; wait"],
			process.cwd(),
			controller.signal,
			() => {},
			() => {},
			{ timeoutMs: 30_000, idleTimeoutMs: 30_000, termGraceMs: 100 },
		);
		await new Promise((resolve) => setTimeout(resolve, 75));
		controller.abort();
		const result = await pending;
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("aborted");
		expect(result.cleanupComplete).toBe(true);
		await waitUntilGone(childPid);
	});

	test("a chatty-but-stuck process is bounded by the real wall clock, not just idle detection (idle resets on every chunk)", async () => {
		const result = await runSupervisedEngine(
			["sh", "-c", "while :; do printf x; sleep 0.01; done"],
			process.cwd(),
			new AbortController().signal,
			() => {},
			() => {},
			{ timeoutMs: 150, idleTimeoutMs: 30_000, termGraceMs: 100 },
		);
		expect(result.reason).toBe("timeout");
		expect(result.cleanupComplete).toBe(true);
	});

	test("KSK_ENGINE_TIMEOUT_MS overrides the default wall clock, following the same env-var convention as sequencer/spawn-stage.ts", async () => {
		process.env.KSK_ENGINE_TIMEOUT_MS = "150";
		try {
			const result = await runSupervisedEngine(
				["sh", "-c", "while :; do :; done"],
				process.cwd(),
				new AbortController().signal,
				() => {},
				() => {},
				{ idleTimeoutMs: 30_000, termGraceMs: 100 },
			);
			expect(result.reason).toBe("timeout");
			expect(result.cleanupComplete).toBe(true);
		} finally {
			delete process.env.KSK_ENGINE_TIMEOUT_MS;
		}
	});
});

describe("classifyEngineOutcome", () => {
	test("an unproven cleanup is always the fatal case, regardless of the process's own exit code", () => {
		const outcome = classifyEngineOutcome(fakeResult({ reason: "cleanup-failed", cleanupComplete: false, exitCode: 0 }));
		expect(outcome.kind).toBe("error");
		expect((outcome as any).cleanupFatal).toBe(true);
		expect(typeof (outcome as any).note).toBe("string");
	});

	test("a clean exit 0 with proven cleanup settles normally (hands off to maybeAutoContinue)", () => {
		expect(classifyEngineOutcome(fakeResult())).toEqual({ kind: "settle" });
	});

	test("a non-zero exit with proven cleanup is a plain error, never latched fatal", () => {
		expect(classifyEngineOutcome(fakeResult({ exitCode: 1 }))).toEqual({ kind: "error", cleanupFatal: false });
	});

	test("a timeout/aborted reason with proven cleanup is a plain error too", () => {
		expect(classifyEngineOutcome(fakeResult({ reason: "timeout", exitCode: null }))).toEqual({ kind: "error", cleanupFatal: false });
		expect(classifyEngineOutcome(fakeResult({ reason: "aborted", exitCode: null }))).toEqual({ kind: "error", cleanupFatal: false });
	});
});
