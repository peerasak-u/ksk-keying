// win32 counterpart to process-supervisor.test.ts.
//
// That file proves the supervisor's teardown contract using POSIX primitives —
// `sh -c`, `setsid`, background jobs, process groups — none of which exist (or
// mean anything) on Windows, so it cannot speak for this platform at all. What
// it did do, before the win32 branch in process-supervisor.ts, was hide a real
// hole: `process.kill()` with a negative pid throws ESRCH on Windows, so every
// liveness probe answered "already dead" and every teardown path certified
// success while killing nothing. A supervised child outlived both its own wall
// deadline and its own abort(), and the console's stop button leaked a live
// `claude -p` — still spending, still writing to a client folder.
//
// These tests therefore assert the two guarantees the console actually depends
// on, against a real spawned process, on the platform where they were broken:
// a deadline kills the child, and abort() (what the stop button calls) kills
// the child. Both must also report the kill honestly rather than as unproven
// cleanup, since `cleanupComplete: false` is deliberately fatal downstream.
import { describe, expect, test } from "bun:test";
import { runSupervisedProcess } from "./process-supervisor";
import { isAlive, killRecorded, waitUntilGone } from "./process-liveness.testing";

// A child that announces its pid and then refuses to leave on its own.
const STUBBORN = ["bun", "-e", "console.log(process.pid); setTimeout(() => {}, 600000)"];

// Generous relative to the ~0.6s a taskkill tree-walk costs, but far below the
// 10-minute child: the point is "the deadline is what ended this", not a
// microbenchmark. Spawning `bun` on a Defender-scanned Windows box is itself
// measured in seconds, so these cannot be tight.
const CALL_BUDGET_MS = 30_000;

describe.skipIf(process.platform !== "win32")("runSupervisedProcess on win32", () => {
	test("the wall deadline really kills the child, and says so honestly", async () => {
		const childPids: number[] = [];
		try {
			const startedAt = Date.now();
			const result = await runSupervisedProcess({
				cmd: STUBBORN,
				timeoutMs: 2_000,
				idleTimeoutMs: 60_000,
				termGraceMs: 1_500,
				label: "win32-timeout",
			});
			const childPid = Number(result.stdout.trim());
			childPids.push(childPid);

			expect(Date.now() - startedAt).toBeLessThan(CALL_BUDGET_MS);
			// Before the fix: "cleanup-failed" with the child still running.
			expect(result.reason).toBe("timeout");
			expect(result.cleanupComplete).toBe(true);
			await waitUntilGone(childPid);
			expect(isAlive(childPid)).toBe(false);
		} finally {
			killRecorded(childPids);
		}
	});

	test("abort() — what the console's stop button calls — really kills the child", async () => {
		const childPids: number[] = [];
		try {
			const controller = new AbortController();
			const pending = runSupervisedProcess({
				cmd: STUBBORN,
				signal: controller.signal,
				timeoutMs: 60_000,
				idleTimeoutMs: 60_000,
				termGraceMs: 1_500,
				label: "win32-abort",
			});
			// Long enough for the child to have really started and printed its pid;
			// the assertion below would be vacuous against a process that never ran.
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			const startedAt = Date.now();
			controller.abort();
			const result = await pending;
			const childPid = Number(result.stdout.trim());
			childPids.push(childPid);

			expect(Date.now() - startedAt).toBeLessThan(CALL_BUDGET_MS);
			expect(result.reason).toBe("aborted");
			expect(result.cleanupComplete).toBe(true);
			await waitUntilGone(childPid);
			expect(isAlive(childPid)).toBe(false);
		} finally {
			killRecorded(childPids);
		}
	});

	test("a child that exits on its own is still reported as a clean exit", async () => {
		// The teardown branch runs unconditionally, including after a normal exit.
		// It must not turn an ordinary successful command into a cleanup failure.
		const result = await runSupervisedProcess({
			cmd: ["bun", "-e", "console.log('done')"],
			timeoutMs: 30_000,
			idleTimeoutMs: 15_000,
			termGraceMs: 1_500,
			label: "win32-clean-exit",
		});

		expect(result.reason).toBe("exited");
		expect(result.exitCode).toBe(0);
		expect(result.cleanupComplete).toBe(true);
		expect(result.stdout).toContain("done");
	});
});
