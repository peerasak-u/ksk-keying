// Pure state-machine tests — no filesystem, no process, no clock. Every
// SequencerDeps function is a fake here; logic.ts's docstring promises this
// is the only way it needs to be tested.
import { describe, expect, test } from "bun:test";
import {
	currentStage,
	initialState,
	retryStage,
	runStage,
	STAGES,
	type GateResult,
	type HumanStopEntry,
	type SequencerDeps,
	type StageOutcome,
} from "./logic";

function deps(overrides: Partial<SequencerDeps> = {}): SequencerDeps {
	return {
		runStageProcess: async () => ({ status: "success" }) as StageOutcome,
		runGate: async () => ({ exitCode: 0, stdout: "ok" }) as GateResult,
		checkHumanStop: async () => [] as HumanStopEntry[],
		...overrides,
	};
}

describe("initialState", () => {
	test("starts idle at the first stage", () => {
		const state = initialState();
		expect(state.status).toBe("idle");
		expect(state.stageIndex).toBe(0);
		expect(currentStage(state).id).toBe("profile");
	});
});

describe("runStage — happy path", () => {
	test("advances to the next stage on a clean process + gate pass", async () => {
		const state = await runStage(initialState(), "/tmp/x", deps());
		expect(state.status).toBe("idle");
		expect(state.stageIndex).toBe(1);
		expect(currentStage(state).id).toBe("segment");
		expect(state.retryCount).toBe(0);
	});

	test("walks every stage through to done", async () => {
		let state = initialState();
		const d = deps();
		// STAGES.length transitions needed: one runStage per stage, "final" has
		// no process but still goes through settle().
		for (let i = 0; i < STAGES.length; i++) {
			state = await runStage(state, "/tmp/x", d);
		}
		expect(state.status).toBe("done");
		expect(currentStage(state).id).toBe("final");
	});

	test("no-ops when not idle", async () => {
		const busy = { ...initialState(), status: "done" as const };
		const state = await runStage(busy, "/tmp/x", deps());
		expect(state).toEqual(busy);
	});
});

describe("human-stop.yaml short-circuit", () => {
	test("stopped-for-human wins over a passing gate, and is never auto-cleared", async () => {
		const entries: HumanStopEntry[] = [
			{ stage: "interpret", unit: "seg-004", condition: "unreadable_required_source", reason: "corrupt pdf" },
		];
		const state = await runStage(initialState(), "/tmp/x", deps({ checkHumanStop: async () => entries }));
		expect(state.status).toBe("stopped-for-human");
		expect(state.humanStopEntries).toEqual(entries);
		expect(state.stageIndex).toBe(0); // never advanced

		// retryStage refuses to touch a stopped-for-human state.
		const after = await retryStage(state, "/tmp/x", deps());
		expect(after).toEqual(state);
	});
});

describe("blocked (gate exit 1) retry policy — 2 retries, 3 attempts total", () => {
	function blockedDeps(): SequencerDeps {
		return deps({ runGate: async () => ({ exitCode: 1, stdout: "missing thing" }) });
	}

	test("first failure is blocked, retryable", async () => {
		const state = await runStage(initialState(), "/tmp/x", blockedDeps());
		expect(state.status).toBe("blocked");
		expect(state.retryCount).toBe(0);
	});

	test("exhausts after 2 retries into blocked-for-human", async () => {
		const d = blockedDeps();
		let state = await runStage(initialState(), "/tmp/x", d);
		expect(state.status).toBe("blocked");
		state = await retryStage(state, "/tmp/x", d);
		expect(state.status).toBe("blocked");
		expect(state.retryCount).toBe(1);
		state = await retryStage(state, "/tmp/x", d);
		expect(state.status).toBe("blocked-for-human");
		expect(state.retryCount).toBe(2);
	});

	test("retryStage no-ops once terminal", async () => {
		const d = blockedDeps();
		let state = await runStage(initialState(), "/tmp/x", d);
		state = await retryStage(state, "/tmp/x", d);
		state = await retryStage(state, "/tmp/x", d); // now blocked-for-human
		const after = await retryStage(state, "/tmp/x", d);
		expect(after).toEqual(state);
	});
});

describe("env-error (gate exit 2) retry policy — 1 retry, 2 attempts total", () => {
	function envErrorDeps(): SequencerDeps {
		return deps({ runGate: async () => ({ exitCode: 2, stdout: "malformed" }) });
	}

	test("first failure is env-error, retryable once", async () => {
		const state = await runStage(initialState(), "/tmp/x", envErrorDeps());
		expect(state.status).toBe("env-error");
	});

	test("exhausts after 1 retry into blocked-for-human", async () => {
		const d = envErrorDeps();
		let state = await runStage(initialState(), "/tmp/x", d);
		state = await retryStage(state, "/tmp/x", d);
		expect(state.status).toBe("blocked-for-human");
		expect(state.retryCount).toBe(1);
	});
});

describe("stage process failure (before any gate runs)", () => {
	test("process failure counts against the env-error budget", async () => {
		const d = deps({ runStageProcess: async () => ({ status: "fail" }) as StageOutcome });
		const state = await runStage(initialState(), "/tmp/x", d);
		expect(state.status).toBe("env-error");
	});

	test("cleanup failure is terminal and never consumes retry budget", async () => {
		const d = deps({ runStageProcess: async () => ({ status: "cleanup-failed" }) });
		const state = await runStage(initialState(), "/client", d);
		expect(state.status).toBe("fatal-cleanup");
		expect(state.retryCount).toBe(0);
		expect(await retryStage(state, "/client", d)).toBe(state);
	});

	test("a fail outcome's detail reaches the log, not just a bare 'process FAILED'", async () => {
		const d = deps({
			runStageProcess: async () => ({ status: "fail", detail: "audit report claims a page that was never claimed: บิลซื้อ.pdf#p6" }),
		});
		const state = await runStage(initialState(), "/tmp/x", d);
		expect(state.status).toBe("env-error");
		expect(state.log[state.log.length - 1]).toContain("audit report claims a page that was never claimed: บิลซื้อ.pdf#p6");
	});

	test("a cleanup-failed outcome's detail reaches the log too", async () => {
		const d = deps({
			runStageProcess: async () => ({ status: "cleanup-failed", detail: "supervisor could not clean process group 1234" }),
		});
		const state = await runStage(initialState(), "/client", d);
		expect(state.status).toBe("fatal-cleanup");
		expect(state.log[state.log.length - 1]).toContain("supervisor could not clean process group 1234");
	});

	test("cleanup failure wins over a simultaneous stop signal", async () => {
		const controller = new AbortController();
		const d = deps({
			runStageProcess: async () => {
				controller.abort();
				return { status: "cleanup-failed" };
			},
		});
		const state = await runStage(initialState(), "/client", d, controller.signal);
		expect(state.status).toBe("fatal-cleanup");
	});
});

describe("gate cleanup failure", () => {
	test("is terminal rather than a retryable environment error", async () => {
		const d = deps({
			runGate: async () => ({
				exitCode: 2,
				stdout: "gate timed out; cleanup incomplete",
				cleanupFailed: true,
			}),
		});
		const state = await runStage(initialState(), "/client", d);
		expect(state.status).toBe("fatal-cleanup");
		expect(state.retryCount).toBe(0);
		expect(await retryStage(state, "/client", d)).toBe(state);
	});

	test("cleanup failure wins over a simultaneous stop signal", async () => {
		const controller = new AbortController();
		const d = deps({
			runGate: async () => {
				controller.abort();
				return { exitCode: 2, stdout: "cleanup incomplete", cleanupFailed: true };
			},
		});
		const state = await runStage(initialState(), "/client", d, controller.signal);
		expect(state.status).toBe("fatal-cleanup");
	});
});

describe("cancellation", () => {
	test("does not consume a retry or turn an intentional abort into env-error", async () => {
		const controller = new AbortController();
		const deps: SequencerDeps = {
			runStageProcess: async (_stage, _target, _context, signal) => {
				signal?.addEventListener("abort", () => undefined, { once: true });
				controller.abort();
				return { status: "fail" };
			},
			runGate: async () => ({ exitCode: 0, stdout: "should not run" }),
			checkHumanStop: async () => [],
		};
		const state = await runStage(initialState(), "/tmp/x", deps, controller.signal);
		expect(state.status).toBe("stopped");
		expect(state.retryCount).toBe(0);
	});
});

describe("final stage — no process, never retried", () => {
	function atFinal(): ReturnType<typeof initialState> {
		return { ...initialState(), stageIndex: STAGES.length - 1 };
	}

	test("a blocked final gate goes straight to blocked-for-human", async () => {
		const d = deps({ runGate: async () => ({ exitCode: 1, stdout: "unit unaccounted" }) });
		const state = await runStage(atFinal(), "/tmp/x", d);
		expect(state.status).toBe("blocked-for-human");
	});

	test("retryStage refuses to touch it (spawnsProcess: false, nothing to re-invoke)", async () => {
		const d = deps({ runGate: async () => ({ exitCode: 1, stdout: "unit unaccounted" }) });
		const blocked = await runStage(atFinal(), "/tmp/x", d);
		const after = await retryStage(blocked, "/tmp/x", d);
		expect(after).toEqual(blocked);
	});
});
