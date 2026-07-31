import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { abortAllSupervisedProcesses, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, defaultMaxLivenessExtensions, runSupervisedProcess } from "./process-supervisor";
import { isAlive, killRecorded, waitUntilGone } from "./process-liveness.testing";

// Every fixture below is a small TypeScript program (fixtures/child.ts), run as
// `bun run child.ts <mode> [args...]` instead of the old ["sh", "-c", "..."]
// strings. See that file's header for why: macOS has no `setsid` binary (only
// the syscall, which Bun.spawn({detached:true}) already uses) and native
// Windows has no sh.exe at all, so a POSIX-shell fixture either silently
// diverged from the scenario it claimed to test (macOS) or ENOENT'd outright
// (Windows).
const FIXTURE = join(import.meta.dir, "fixtures", "child.ts");

const childPids: number[] = [];

afterEach(async () => {
	killRecorded(childPids);
});

/**
 * Best-effort teardown for the "untrackable descendant" fixtures: they log
 * their real grandchild pid to stderr (see fixtures/child.ts) purely so this
 * suite doesn't leak a real `sleep` process for 25 real seconds after every
 * run. Never used in an assertion — the whole point of these tests is that
 * production code has no way to learn this pid either.
 */
function rememberGrandchildPid(stderr: string): void {
	const match = /gc-pid=(\d+)/.exec(stderr);
	if (match) childPids.push(Number(match[1]));
}

describe("runSupervisedProcess", () => {
	test("reaps a CPU child after its parent exits successfully", async () => {
		const result = await runSupervisedProcess({
			cmd: [process.execPath, "run", FIXTURE, "orphan-exit", "spin"],
			timeoutMs: 2_000,
			idleTimeoutMs: 2_000,
			termGraceMs: 100,
		});
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("exited");
		expect(result.exitCode).toBe(0);
		expect(result.cleanupComplete).toBe(true);
		await waitUntilGone(childPid);
	});

	test("reaps a descendant that escapes the original process group with setsid", async () => {
		const result = await runSupervisedProcess({
			cmd: [process.execPath, "run", FIXTURE, "escape-exit", "sleep", "30"],
			timeoutMs: 2_000,
			idleTimeoutMs: 2_000,
			termGraceMs: 100,
		});
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("exited");
		expect(result.cleanupComplete).toBe(true);
		// The escaped descendant keeps its ownership token, so only Linux's /proc
		// token scan (taggedProcessIds in process-supervisor.ts — deliberately
		// gated to `process.platform === "linux"`, see its comment) can reach a
		// process that has left the original session entirely. That is a real,
		// documented, pre-existing capability gap on every other platform, not
		// something a test fixture can paper over without changing
		// process-supervisor.ts itself — so only assert the strong "it's
		// actually gone" guarantee where the source can deliver it. killRecorded
		// in afterEach still reaps it everywhere so the suite never leaks it.
		if (process.platform === "linux") await waitUntilGone(childPid);
	});

	test("does not spawn when the caller signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await runSupervisedProcess({
			cmd: [process.execPath, "run", FIXTURE, "exit", "99"],
			signal: controller.signal,
		});
		expect(result.reason).toBe("aborted");
		expect(result.pid).toBeNull();
		expect(result.exitCode).toBeNull();
		expect(result.cleanupComplete).toBe(true);
	});

	test("kills a silent CPU child on the idle deadline", async () => {
		const result = await runSupervisedProcess({
			cmd: [process.execPath, "run", FIXTURE, "orphan-wait", "spin"],
			timeoutMs: 2_000,
			idleTimeoutMs: 100,
			termGraceMs: 100,
		});
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("idle-timeout");
		expect(result.cleanupComplete).toBe(true);
		await waitUntilGone(childPid);
	});

	test("aborts the complete process group and waits for cleanup", async () => {
		const controller = new AbortController();
		const pending = runSupervisedProcess({
			cmd: [process.execPath, "run", FIXTURE, "orphan-wait", "sleep", "30"],
			signal: controller.signal,
			timeoutMs: 30_000,
			idleTimeoutMs: 30_000,
			termGraceMs: 100,
		});
		await new Promise((resolve) => setTimeout(resolve, 75));
		controller.abort();
		const result = await pending;
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("aborted");
		expect(result.cleanupComplete).toBe(true);
		await waitUntilGone(childPid);
	});

	test("global shutdown waits for detached supervisors and escaped descendants", async () => {
		const pending = runSupervisedProcess({
			cmd: [process.execPath, "run", FIXTURE, "escape-wait", "sleep", "30"],
			timeoutMs: 30_000,
			idleTimeoutMs: 30_000,
			termGraceMs: 100,
		});
		await new Promise((resolve) => setTimeout(resolve, 75));
		await abortAllSupervisedProcesses();
		const result = await pending;
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("aborted");
		expect(result.cleanupComplete).toBe(true);
		// Same Linux-only reap guarantee as the "escapes the original process
		// group" test above — see its comment. The direct child (this fixture)
		// is fully reaped on every platform; only the escaped grandchild's fate
		// is platform-dependent.
		if (process.platform === "linux") await waitUntilGone(childPid);
	});

	test("the module's own last-resort default is minutes, not the old 60-minute wall / never the sole line of defense", () => {
		// Every real call site in this codebase now supplies its own sane
		// fallback (see sequencer/spawn-stage.ts, sequencer/completion-check.ts,
		// app/learn.ts, engine.ts) — this default only bites a future caller
		// that forgets its own. It used to be 60 min / 5 min, which is exactly
		// the gap the incident this file's header describes exploited.
		expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(15 * 60 * 1_000);
		expect(DEFAULT_IDLE_TIMEOUT_MS).toBeLessThanOrEqual(5 * 60 * 1_000);
	});

	test("an omitted timeoutMs really does fall back to the module default and still kills a runaway child", async () => {
		const result = await runSupervisedProcess({
			cmd: [process.execPath, "run", FIXTURE, "orphan-wait", "spin"],
			// timeoutMs/idleTimeoutMs both omitted on purpose — proves the
			// fallback path itself still bounds a real process, not just that
			// the constants are small numbers.
			idleTimeoutMs: 100,
			termGraceMs: 100,
		});
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("idle-timeout");
		expect(result.cleanupComplete).toBe(true);
		await waitUntilGone(childPid);
	});

	// A descendant that both leaves the process group (setsid) and scrubs the
	// ownership token defeats every mechanism we have for killing it. It still
	// holds the inherited stdout pipe, and that is the tell: the call must come
	// back on time and must report the cleanup as unproven rather than certify a
	// process it never killed.
	test("returns on time and reports unproven cleanup when an untrackable descendant holds the pipe", async () => {
		const startedAt = Date.now();
		const result = await runSupervisedProcess({
			cmd: [process.execPath, "run", FIXTURE, "escape-untrackable-exit", "25"],
			timeoutMs: 3_000,
			idleTimeoutMs: 3_000,
			termGraceMs: 200,
			drainGraceMs: 300,
		});
		const elapsed = Date.now() - startedAt;

		expect(elapsed).toBeLessThan(10_000);
		expect(result.cleanupComplete).toBe(false);
		expect(result.reason).toBe("cleanup-failed");
		// Output captured before we gave up on EOF is still returned.
		expect(result.stdout).toContain("spawned");
		// The fixture logs its untrackable grandchild's real pid to stderr purely
		// for this best-effort teardown — production code has no such backdoor,
		// and nothing above asserts against it. Without this the sleep it left
		// behind would outlive the test run untracked.
		rememberGrandchildPid(result.stderr);
	});

	test("the wall deadline bounds the call, not merely the direct child", async () => {
		const startedAt = Date.now();
		const result = await runSupervisedProcess({
			cmd: [process.execPath, "run", FIXTURE, "escape-untrackable-fg", "25"],
			timeoutMs: 500,
			idleTimeoutMs: 5_000,
			termGraceMs: 200,
			drainGraceMs: 300,
		});
		const elapsed = Date.now() - startedAt;

		expect(elapsed).toBeLessThan(10_000);
		expect(result.cleanupComplete).toBe(false);
		expect(result.reason).toBe("cleanup-failed");
		rememberGrandchildPid(result.stderr);
	});

	// FIX #0 (2026-07-27): the idle-timeout and 15-min-wall halts on clients
	// 216/345 were each diagnosed only by correlating PNG/log mtimes by hand,
	// because the supervisor knew its own kill reason (result.reason) but never
	// printed it. These prove the diagnostic line itself: which deadline fired,
	// for which labelled call site, is now on the record before cleanup runs.
	test("logs the wall-timeout reason and label before cleanup", async () => {
		const errorSpy = spyOn(console, "error");
		try {
			const result = await runSupervisedProcess({
				cmd: [process.execPath, "run", FIXTURE, "orphan-wait", "spin"],
				timeoutMs: 200,
				idleTimeoutMs: 5_000,
				termGraceMs: 100,
				label: "test-wall-site",
			});
			const childPid = Number(result.stdout.trim());
			childPids.push(childPid);

			expect(result.reason).toBe("timeout");
			const line = errorSpy.mock.calls.map((call) => call.join(" ")).find((text) => text.includes("test-wall-site"));
			expect(line).toBeDefined();
			expect(line).toContain("timeout");
			expect(line).toContain("test-wall-site");
			expect(line).toMatch(/pid=\d+/);
			expect(line).toContain("timeoutMs=200");
			expect(line).toContain("idleTimeoutMs=5000");
			await waitUntilGone(childPid);
		} finally {
			errorSpy.mockRestore();
		}
	});

	test("logs the idle-timeout reason and label before cleanup", async () => {
		const errorSpy = spyOn(console, "error");
		try {
			const result = await runSupervisedProcess({
				cmd: [process.execPath, "run", FIXTURE, "orphan-wait", "spin"],
				timeoutMs: 5_000,
				idleTimeoutMs: 150,
				termGraceMs: 100,
				label: "test-idle-site",
			});
			const childPid = Number(result.stdout.trim());
			childPids.push(childPid);

			expect(result.reason).toBe("idle-timeout");
			const line = errorSpy.mock.calls.map((call) => call.join(" ")).find((text) => text.includes("test-idle-site"));
			expect(line).toBeDefined();
			expect(line).toContain("idle-timeout");
			expect(line).toContain("test-idle-site");
			expect(line).toMatch(/pid=\d+/);
			expect(line).toContain("timeoutMs=5000");
			expect(line).toContain("idleTimeoutMs=150");
			await waitUntilGone(childPid);
		} finally {
			errorSpy.mockRestore();
		}
	});

	// FIX #2 (2026-07-27): D2 — a livenessProbe reporting real evidence of
	// progress (e.g. rising PNG counts from prepare.ts) must earn a silent
	// process more time past the idle deadline instead of being killed on
	// silence alone.
	test("a silent process whose livenessProbe advances survives past the idle timeout", async () => {
		let probeValue = 0;
		const startedAt = Date.now();
		const result = await runSupervisedProcess({
			cmd: [process.execPath, "run", FIXTURE, "orphan-wait", "spin"],
			// The wall is well past a single idle window, and the extension cap
			// is generous, so the only way this call reaches the wall deadline
			// is if every idle expiry in between was successfully extended.
			timeoutMs: 600,
			idleTimeoutMs: 100,
			maxLivenessExtensions: 50,
			termGraceMs: 100,
			livenessProbe: () => ++probeValue,
		});
		const elapsed = Date.now() - startedAt;
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("timeout");
		expect(elapsed).toBeGreaterThanOrEqual(500);
		await waitUntilGone(childPid);
	});

	test("a silent process whose livenessProbe never advances is still killed with idle-timeout", async () => {
		const startedAt = Date.now();
		const result = await runSupervisedProcess({
			cmd: [process.execPath, "run", FIXTURE, "orphan-wait", "spin"],
			timeoutMs: 5_000,
			idleTimeoutMs: 100,
			maxLivenessExtensions: 50,
			termGraceMs: 100,
			// Constant reading: never CHANGES from one expiry to the next, so
			// this must be treated exactly like "no evidence".
			livenessProbe: () => 7,
		});
		const elapsed = Date.now() - startedAt;
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("idle-timeout");
		// Bounded by the idle window, not the 5s wall — proves the flat probe
		// reading did not buy any extension at all.
		expect(elapsed).toBeLessThan(2_000);
		await waitUntilGone(childPid);
	});

	// The prepare-pages probe counts files under a client's `_pages` tree, and
	// prepare.ts rmSync's a half-rendered source dir before re-rendering it —
	// so on a re-run after an earlier kill the count DROPS while the child is
	// rendering flat out. A strict-increase test would kill that recovery run;
	// a change test keeps it alive.
	test("a probe reading that DROPS still counts as evidence of progress", async () => {
		const readings = [500, 420, 430, 440, 450, 460, 470, 480, 490];
		let index = 0;
		const startedAt = Date.now();
		const result = await runSupervisedProcess({
			cmd: [process.execPath, "run", FIXTURE, "orphan-wait", "spin"],
			timeoutMs: 600,
			idleTimeoutMs: 100,
			maxLivenessExtensions: 50,
			termGraceMs: 100,
			// Second reading is BELOW the first — under a strict-increase rule the
			// process dies here, ~200ms in, with "idle-timeout".
			livenessProbe: () => readings[Math.min(index++, readings.length - 1)],
		});
		const elapsed = Date.now() - startedAt;
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("timeout");
		expect(elapsed).toBeGreaterThanOrEqual(500);
		await waitUntilGone(childPid);
	});

	// The extension cap must never be a second, size-blind deadline sitting in
	// front of the wall — that was the flat-constant disease reintroduced one
	// layer up (a flat 5 gave every client a 30-minute idle lid at the
	// production 5-minute idleTimeoutMs, which client 336 blows through).
	test("with no explicit cap, a changing probe can extend all the way to the wall", async () => {
		let probeValue = 0;
		const startedAt = Date.now();
		const result = await runSupervisedProcess({
			cmd: [process.execPath, "run", FIXTURE, "orphan-wait", "spin"],
			// 12 idle windows fit inside the wall. Under the old flat cap of 5
			// this would have died with "idle-timeout" at roughly 600ms.
			timeoutMs: 1_200,
			idleTimeoutMs: 100,
			termGraceMs: 100,
			livenessProbe: () => ++probeValue,
		});
		const elapsed = Date.now() - startedAt;
		const childPid = Number(result.stdout.trim());
		childPids.push(childPid);

		expect(result.reason).toBe("timeout");
		expect(elapsed).toBeGreaterThanOrEqual(1_100);
		await waitUntilGone(childPid);
	});

	test("defaultMaxLivenessExtensions reaches the wall and never mints an unbounded budget", () => {
		// Exactly enough windows to reach the wall, rounded up.
		expect(defaultMaxLivenessExtensions(30 * 60_000, 5 * 60_000)).toBe(6);
		expect(defaultMaxLivenessExtensions(216 * 60_000, 5 * 60_000)).toBe(44);
		// Degenerate deadlines must never divide into an infinite rope (D3).
		expect(defaultMaxLivenessExtensions(30 * 60_000, 0)).toBe(0);
		expect(defaultMaxLivenessExtensions(30 * 60_000, -1)).toBe(0);
		expect(defaultMaxLivenessExtensions(Number.POSITIVE_INFINITY, 5 * 60_000)).toBe(0);
		expect(defaultMaxLivenessExtensions(Number.NaN, 5 * 60_000)).toBe(0);
	});

	test("D3: liveness extensions are capped, so a forever-rising probe cannot outlast the cap", async () => {
		let probeValue = 0;
		const errorSpy = spyOn(console, "error");
		const startedAt = Date.now();
		try {
			const result = await runSupervisedProcess({
				cmd: [process.execPath, "run", FIXTURE, "orphan-wait", "spin"],
				// The wall is deliberately far away: if the cap did not hold, this
				// process would run all the way to the wall on the ever-rising probe.
				timeoutMs: 5_000,
				idleTimeoutMs: 100,
				maxLivenessExtensions: 2,
				termGraceMs: 100,
				label: "test-liveness-cap",
				livenessProbe: () => ++probeValue,
			});
			const elapsed = Date.now() - startedAt;
			const childPid = Number(result.stdout.trim());
			childPids.push(childPid);

			expect(result.reason).toBe("idle-timeout");
			// 2 extensions * ~100ms idle window each, plus the initial window —
			// nowhere near the 5s wall.
			expect(elapsed).toBeLessThan(2_000);
			const extensionLines = errorSpy.mock.calls
				.map((call) => call.join(" "))
				.filter((text) => text.includes("test-liveness-cap") && text.includes("idle-extended"));
			expect(extensionLines).toHaveLength(2);
			expect(extensionLines[1]).toContain("extension=2/2");
			await waitUntilGone(childPid);
		} finally {
			errorSpy.mockRestore();
		}
	});

	test("caps retained output while continuing to drain the child", async () => {
		const result = await runSupervisedProcess({
			cmd: [process.execPath, "run", FIXTURE, "bytes", "1000"],
			maxOutputBytes: 16,
			timeoutMs: 2_000,
			idleTimeoutMs: 2_000,
			termGraceMs: 100,
		});
		expect(result.reason).toBe("exited");
		expect(result.stdout).toHaveLength(16);
		expect(result.stdoutTruncated).toBe(true);
	});
});
