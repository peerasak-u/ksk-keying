// Fakes SequencerDeps throughout — never spawns a real `claude -p`. Exercises
// the orchestrator through its public API only (boot/enqueueRun/retryRun/
// getRun/subscribe), the same "test behavior, not implementation" standard
// as sequencer/logic.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { initialState, STAGES, type GateResult, type HumanStopEntry, type SequencerDeps, type StageOutcome } from "../sequencer/logic";
import { createOrchestrator } from "./orchestrator";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ksk-orchestrator-test-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function alwaysPassDeps(): SequencerDeps {
	return {
		runStageProcess: async () => ({ status: "success" }) as StageOutcome,
		runGate: async () => ({ exitCode: 0, stdout: "ok" }) as GateResult,
		checkHumanStop: async () => [] as HumanStopEntry[],
	};
}

/** Flush pending microtasks until `predicate()` is true or attempts run out —
 * every fake `deps` call here resolves same-tick, but the drive loop still
 * chains several `await`s per stage, so a handful of ticks are needed. */
async function waitUntil(predicate: () => boolean, attempts = 50) {
	for (let i = 0; i < attempts; i++) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 0));
	}
	throw new Error("waitUntil: condition never became true");
}

describe("enqueueRun — fresh run drives to done", () => {
	test("a client-month with no prior record runs every stage to done", async () => {
		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);
		const result = await orchestrator.enqueueRun("A/month-1");
		expect(result.ok).toBe(true);

		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");
		const run = orchestrator.getRun("A/month-1")!;
		expect(run.state.status).toBe("done");
		expect(run.active).toBe(false);
		expect(run.queued).toBe(false);
	});

	test("re-enqueuing an already-done run is rejected, not restarted", async () => {
		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);
		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");

		const again = await orchestrator.enqueueRun("A/month-1");
		expect(again.ok).toBe(false);
	});
});

describe("concurrency limit", () => {
	test("a second run stays queued while the first holds the only slot", async () => {
		let resolveFirstGate: ((r: GateResult) => void) | null = null;
		let firstGateCalled = false;
		const deps: SequencerDeps = {
			runStageProcess: async () => ({ status: "success" }),
			runGate: async (stage, targetDir) => {
				if (targetDir.endsWith("A/month-1") && !firstGateCalled) {
					firstGateCalled = true;
					return new Promise<GateResult>((resolve) => {
						resolveFirstGate = resolve;
					});
				}
				return { exitCode: 0, stdout: "ok" };
			},
			checkHumanStop: async () => [],
		};
		const orchestrator = createOrchestrator(deps);
		await orchestrator.boot(root, 1);

		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => firstGateCalled);
		await orchestrator.enqueueRun("B/month-1");
		// give B's enqueue a tick to settle into the queue
		await waitUntil(() => orchestrator.getRun("B/month-1")?.queued === true);

		expect(orchestrator.getRun("A/month-1")?.active).toBe(true);
		expect(orchestrator.getRun("B/month-1")?.active).toBe(false);
		expect(orchestrator.getRun("B/month-1")?.queued).toBe(true);

		resolveFirstGate!({ exitCode: 0, stdout: "ok" });
		await waitUntil(() => orchestrator.getRun("B/month-1")?.state.status === "done");
		expect(orchestrator.getRun("A/month-1")?.state.status).toBe("done");
	});
});

describe("retryRun", () => {
	test("a blocked run resumes forward on explicit retry and continues to done", async () => {
		let gateCalls = 0;
		const deps: SequencerDeps = {
			runStageProcess: async () => ({ status: "success" }),
			runGate: async () => {
				gateCalls++;
				return gateCalls === 1 ? { exitCode: 1, stdout: "missing thing" } : { exitCode: 0, stdout: "ok" };
			},
			checkHumanStop: async () => [],
		};
		const orchestrator = createOrchestrator(deps);
		await orchestrator.boot(root, 1);

		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "blocked");
		expect(orchestrator.getRun("A/month-1")?.active).toBe(false); // released its slot

		const retried = await orchestrator.retryRun("A/month-1");
		expect(retried.ok).toBe(true);
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");
	});

	test("retrying a run that isn't blocked/env-error is rejected", async () => {
		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);
		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");

		const result = await orchestrator.retryRun("A/month-1");
		expect(result.ok).toBe(false);
	});

	test("retrying a client-month with no run at all is rejected", async () => {
		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);
		const result = await orchestrator.retryRun("nonexistent/month");
		expect(result.ok).toBe(false);
	});
});

describe("stopRun and shutdown", () => {
	test("aborts an active attempt and waits for its cancellation before returning", async () => {
		let started = false;
		let observedAbort = false;
		const deps: SequencerDeps = {
			runStageProcess: async (_stage, _targetDir, _context, signal) =>
				new Promise<StageOutcome>((resolve) => {
					started = true;
					signal?.addEventListener(
						"abort",
						() => {
							observedAbort = true;
							resolve({ status: "fail" });
						},
						{ once: true },
					);
				}),
			runGate: async () => ({ exitCode: 0, stdout: "ok" }),
			checkHumanStop: async () => [],
		};
		const orchestrator = createOrchestrator(deps);
		await orchestrator.boot(root, 1);
		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => started);

		const stopped = await orchestrator.stopRun("A/month-1");
		expect(stopped.ok).toBe(true);
		expect(observedAbort).toBe(true);
		expect(orchestrator.getRun("A/month-1")?.active).toBe(false);
		expect(orchestrator.getRun("A/month-1")?.state.status).toBe("stopped");
		expect(orchestrator.getRun("A/month-1")?.state.retryCount).toBe(0);
	});

	test("shutdown cancels active work and does not start queued work", async () => {
		let started = false;
		const deps: SequencerDeps = {
			runStageProcess: async (_stage, _targetDir, _context, signal) =>
				new Promise<StageOutcome>((resolve) => {
					started = true;
					signal?.addEventListener("abort", () => resolve({ status: "fail" }), { once: true });
				}),
			runGate: async () => ({ exitCode: 0, stdout: "ok" }),
			checkHumanStop: async () => [],
		};
		const orchestrator = createOrchestrator(deps);
		await orchestrator.boot(root, 1);
		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => started);
		await orchestrator.enqueueRun("B/month-1");
		await waitUntil(() => orchestrator.getRun("B/month-1")?.queued === true);

		await orchestrator.shutdown();
		expect(orchestrator.getRun("A/month-1")?.active).toBe(false);
		expect(orchestrator.getRun("A/month-1")?.state.status).toBe("stopped");
		expect(orchestrator.getRun("B/month-1")?.queued).toBe(false);
		expect(orchestrator.getRun("B/month-1")?.active).toBe(false);
		expect(orchestrator.getRun("B/month-1")?.state.status).toBe("stopped");
	});

	test("cleanup failure parks the whole queue and rejects new work until restart", async () => {
		const deps: SequencerDeps = {
			runStageProcess: async () => ({ status: "cleanup-failed" }),
			runGate: async () => ({ exitCode: 0, stdout: "must not run" }),
			checkHumanStop: async () => [],
		};
		const orchestrator = createOrchestrator(deps);
		await orchestrator.boot(root, 1);
		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "fatal-cleanup");

		const result = await orchestrator.enqueueRun("B/month-1");
		expect(result).toMatchObject({ ok: false, code: 503 });
		expect(orchestrator.getRun("B/month-1")).toBeUndefined();
	});

	test("restart clears only the process-local safety latch and explicit repair can recover the persisted run", async () => {
		const failing = createOrchestrator({
			runStageProcess: async () => ({ status: "cleanup-failed" }),
			runGate: async () => ({ exitCode: 0, stdout: "must not run" }),
			checkHumanStop: async () => [],
		});
		await failing.boot(root, 1);
		await failing.enqueueRun("A/month-1");
		await waitUntil(() => failing.getRun("A/month-1")?.state.status === "fatal-cleanup");
		expect((await failing.repairRun("A/month-1")).ok).toBe(false);

		const restarted = createOrchestrator(alwaysPassDeps());
		await restarted.boot(root, 1);
		expect(restarted.getRun("A/month-1")?.state.status).toBe("fatal-cleanup");
		const repaired = await restarted.repairRun("A/month-1");
		expect(repaired.ok).toBe(true);
		await waitUntil(() => restarted.getRun("A/month-1")?.state.status === "done");
	});
});

describe("repairRun", () => {
	test("a done run is reset to the segment stage and drives to done again", async () => {
		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);
		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");

		const result = await orchestrator.repairRun("A/month-1");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.run.state.stageIndex).toBe(STAGES.findIndex((s) => s.id === "segment"));
			expect(result.run.state.status).toBe("idle");
		}

		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");
		expect(orchestrator.getRun("A/month-1")?.state.status).toBe("done");
	});

	test("a blocked run can also be repaired, unlike retryRun's blocked/env-error-only restriction", async () => {
		let gateCalls = 0;
		const deps: SequencerDeps = {
			runStageProcess: async () => ({ status: "success" }),
			runGate: async () => {
				gateCalls++;
				return gateCalls === 1 ? { exitCode: 1, stdout: "missing thing" } : { exitCode: 0, stdout: "ok" };
			},
			checkHumanStop: async () => [],
		};
		const orchestrator = createOrchestrator(deps);
		await orchestrator.boot(root, 1);

		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "blocked");

		const result = await orchestrator.repairRun("A/month-1");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.run.state.stageIndex).toBe(STAGES.findIndex((s) => s.id === "segment"));
			expect(result.run.state.status).toBe("idle");
		}

		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");
	});

	test("rejects with 409 while the run is currently active", async () => {
		let resolveFirstGate: ((r: GateResult) => void) | null = null;
		let firstGateCalled = false;
		const deps: SequencerDeps = {
			runStageProcess: async () => ({ status: "success" }),
			runGate: async (stage, targetDir) => {
				if (targetDir.endsWith("A/month-1") && !firstGateCalled) {
					firstGateCalled = true;
					return new Promise<GateResult>((resolve) => {
						resolveFirstGate = resolve;
					});
				}
				return { exitCode: 0, stdout: "ok" };
			},
			checkHumanStop: async () => [],
		};
		const orchestrator = createOrchestrator(deps);
		await orchestrator.boot(root, 1);

		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => firstGateCalled);
		expect(orchestrator.getRun("A/month-1")?.active).toBe(true);

		const result = await orchestrator.repairRun("A/month-1");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe(409);

		resolveFirstGate!({ exitCode: 0, stdout: "ok" });
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");
	});

	test("rejects with 409 while the run is queued but not yet active", async () => {
		let resolveFirstGate: ((r: GateResult) => void) | null = null;
		let firstGateCalled = false;
		const deps: SequencerDeps = {
			runStageProcess: async () => ({ status: "success" }),
			runGate: async (stage, targetDir) => {
				if (targetDir.endsWith("A/month-1") && !firstGateCalled) {
					firstGateCalled = true;
					return new Promise<GateResult>((resolve) => {
						resolveFirstGate = resolve;
					});
				}
				return { exitCode: 0, stdout: "ok" };
			},
			checkHumanStop: async () => [],
		};
		const orchestrator = createOrchestrator(deps);
		await orchestrator.boot(root, 1);

		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => firstGateCalled);
		await orchestrator.enqueueRun("B/month-1");
		await waitUntil(() => orchestrator.getRun("B/month-1")?.queued === true);

		const result = await orchestrator.repairRun("B/month-1");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe(409);

		resolveFirstGate!({ exitCode: 0, stdout: "ok" });
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");
		await waitUntil(() => orchestrator.getRun("B/month-1")?.state.status === "done");
	});

	test("rejects with 404 when there is no run at all for that relPath", async () => {
		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);
		const result = await orchestrator.repairRun("nonexistent/month");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe(404);
	});

	test("a successful repairRun re-enters the same queue/concurrency-slot machinery", async () => {
		let resolveGate: ((r: GateResult) => void) | null = null;
		let gateHeld = false;
		const deps: SequencerDeps = {
			runStageProcess: async () => ({ status: "success" }),
			runGate: async (stage, targetDir) => {
				if (targetDir.endsWith("A/month-1") && !gateHeld) {
					gateHeld = true;
					return new Promise<GateResult>((resolve) => {
						resolveGate = resolve;
					});
				}
				return { exitCode: 0, stdout: "ok" };
			},
			checkHumanStop: async () => [],
		};
		const orchestrator = createOrchestrator(deps);
		await orchestrator.boot(root, 1);

		await orchestrator.enqueueRun("B/month-1");
		await waitUntil(() => orchestrator.getRun("B/month-1")?.state.status === "done");

		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => gateHeld);
		expect(orchestrator.getRun("A/month-1")?.active).toBe(true);

		const result = await orchestrator.repairRun("B/month-1");
		expect(result.ok).toBe(true);
		expect(orchestrator.getRun("B/month-1")?.queued).toBe(true);
		expect(orchestrator.getRun("B/month-1")?.active).toBe(false);

		resolveGate!({ exitCode: 0, stdout: "ok" });
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");
		await waitUntil(() => orchestrator.getRun("B/month-1")?.state.status === "done");
	});
});

describe("boot() crash-resume", () => {
	test("re-enqueues an idle (mid-run) record found on disk without an explicit enqueueRun call", async () => {
		const targetDir = join(root, "A", "month-1");
		mkdirSync(join(targetDir, "ข้อมูลระบบ", "_pages"), { recursive: true });
		const midRunState = { ...initialState(), stageIndex: 3 }; // "link", idle
		writeFileSync(
			join(targetDir, "ข้อมูลระบบ", "_pages", "run-state.yaml"),
			yamlStringify({
				schema: "ksk_run_state.v1",
				started_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
				finished_at: null,
				state: midRunState,
			}),
			"utf8",
		);

		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);

		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");
		expect(orchestrator.getRun("A/month-1")?.state.status).toBe("done");
	});

	test("does NOT auto-resume a blocked/terminal record — that still needs an explicit human action", async () => {
		const targetDir = join(root, "A", "month-1");
		mkdirSync(join(targetDir, "ข้อมูลระบบ", "_pages"), { recursive: true });
		const blockedState = { ...initialState(), status: "blocked" as const };
		writeFileSync(
			join(targetDir, "ข้อมูลระบบ", "_pages", "run-state.yaml"),
			yamlStringify({
				schema: "ksk_run_state.v1",
				started_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
				finished_at: null,
				state: blockedState,
			}),
			"utf8",
		);

		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);
		await new Promise((r) => setTimeout(r, 20));
		expect(orchestrator.getRun("A/month-1")?.state.status).toBe("blocked");
		expect(orchestrator.getRun("A/month-1")?.active).toBe(false);
	});
});

describe("subscribe", () => {
	test("receives a notification as the run progresses", async () => {
		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);
		const seen: string[] = [];
		const unsubscribe = orchestrator.subscribe("A/month-1", (summary) => seen.push(summary.state.status));
		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");
		unsubscribe();
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[seen.length - 1]).toBe("done");
	});
});

describe("stageStartedAt stamping (dashboard ticket #2's per-stage elapsed)", () => {
	test("stays fixed across a retry within the same stageIndex, and only moves when stageIndex actually advances", async () => {
		// Regression guard for the validator's finding: the stamping condition
		// in drive() is `record.stageStartedAt == null || nextState.stageIndex
		// !== record.state.stageIndex` — if that had instead been written to
		// stamp on every settle, "ขั้นนี้ N นาที" would always read ~0 and every
		// OTHER existing test would still pass, since none of them assert on
		// stageStartedAt at all. This test drives a real blocked -> retry ->
		// advance sequence and checks the stamp at each point.
		// Fails the gate check twice (retryCount 0 then 1, both < MAX_RETRIES.blocked
		// of 2) before passing on the third call — this gives TWO persisted
		// "blocked" states at the SAME stageIndex (retryCount 0 and 1), which is
		// what lets the test observe "unchanged across a retry" as a real
		// transition rather than inferring it from a single sample.
		let gateCalls = 0;
		const deps: SequencerDeps = {
			runStageProcess: async () => ({ status: "success" }),
			runGate: async () => {
				gateCalls++;
				return gateCalls <= 2 ? { exitCode: 1, stdout: "missing thing" } : { exitCode: 0, stdout: "ok" };
			},
			checkHumanStop: async () => [],
		};
		const orchestrator = createOrchestrator(deps);
		await orchestrator.boot(root, 1);

		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "blocked");
		const blockedStageIndex = orchestrator.getRun("A/month-1")!.state.stageIndex;
		const stampAtBlocked = orchestrator.getRun("A/month-1")!.stageStartedAt;
		expect(stampAtBlocked).not.toBeNull();
		expect(orchestrator.getRun("A/month-1")?.state.retryCount).toBe(0);

		// Real elapsed time between the two ISO-timestamp captures, so a
		// same-millisecond false negative can never masquerade as "the stamp
		// didn't change" (or vice versa).
		await new Promise((r) => setTimeout(r, 5));

		await orchestrator.retryRun("A/month-1");
		// Second gate call also fails (gateCalls === 2) — still blocked, same
		// stageIndex, retryCount now 1. The stamp must not have moved just
		// because an attempt was retried.
		await waitUntil(() => (orchestrator.getRun("A/month-1")?.state.retryCount ?? -1) === 1);
		expect(orchestrator.getRun("A/month-1")?.state.stageIndex).toBe(blockedStageIndex);
		expect(orchestrator.getRun("A/month-1")?.stageStartedAt).toBe(stampAtBlocked);

		await new Promise((r) => setTimeout(r, 5));
		await orchestrator.retryRun("A/month-1");
		// Third gate call passes (gateCalls === 3) — stageIndex advances, and
		// the drive loop runs the rest of STAGES to done automatically.
		await waitUntil(() => (orchestrator.getRun("A/month-1")?.state.stageIndex ?? -1) > blockedStageIndex);
		// stageIndex moved forward — the stamp MUST have moved with it.
		expect(orchestrator.getRun("A/month-1")?.stageStartedAt).not.toBe(stampAtBlocked);

		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");
	});
});

describe("subscribeAll", () => {
	test("fires for every relPath, not just one — the dashboard's global SSE stream needs all of them", async () => {
		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 2);
		const seen: string[] = [];
		const unsubscribe = orchestrator.subscribeAll((summary) => seen.push(summary.relPath));
		await orchestrator.enqueueRun("A/month-1");
		await orchestrator.enqueueRun("B/month-1");
		await waitUntil(
			() => orchestrator.getRun("A/month-1")?.state.status === "done" && orchestrator.getRun("B/month-1")?.state.status === "done",
		);
		unsubscribe();
		expect(seen).toContain("A/month-1");
		expect(seen).toContain("B/month-1");
	});

	test("unsubscribing stops further notifications", async () => {
		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);
		const seen: string[] = [];
		const unsubscribe = orchestrator.subscribeAll((summary) => seen.push(summary.state.status));
		unsubscribe();
		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");
		expect(seen.length).toBe(0);
	});

	test("subscribeAll and subscribe(relPath) both fire for the same change", async () => {
		const orchestrator = createOrchestrator(alwaysPassDeps());
		await orchestrator.boot(root, 1);
		const seenAll: string[] = [];
		const seenOne: string[] = [];
		const unsubAll = orchestrator.subscribeAll((summary) => {
			if (summary.relPath === "A/month-1") seenAll.push(summary.state.status);
		});
		const unsubOne = orchestrator.subscribe("A/month-1", (summary) => seenOne.push(summary.state.status));
		await orchestrator.enqueueRun("A/month-1");
		await waitUntil(() => orchestrator.getRun("A/month-1")?.state.status === "done");
		unsubAll();
		unsubOne();
		expect(seenAll.length).toBeGreaterThan(0);
		expect(seenAll).toEqual(seenOne);
	});
});
