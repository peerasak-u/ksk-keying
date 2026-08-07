// Spec §3, transition-for-transition. Each case below names the row it holds,
// so a change to the machine that the spec did not make shows up as a named
// failure rather than a diff nobody can grade.
import { describe, expect, test } from "bun:test";
import {
	allowedCommands,
	checkCommand,
	checkReviewWrite,
	isTerminal,
	MAX_RETRIES,
	noRunRecordState,
	observedStatus,
	retriesRemaining,
	RUN_COMMANDS,
	RUN_STATUSES,
	TERMINAL_STATUSES,
	TRANSIENT_STATUSES,
	TRANSITIONS,
	transition,
	type MachineState,
	type RunCommand,
	type RunStatus,
	type Trigger,
} from "./state-machine";
import { LAST_STAGE_INDEX, REPAIR_STAGE_INDEX, STAGE_COUNT } from "./stages";

function state(overrides: Partial<MachineState> = {}): MachineState {
	return {
		status: "idle",
		queued: false,
		active: false,
		hasRunRecord: true,
		stageIndex: 0,
		retryCount: 0,
		...overrides,
	};
}

describe("§3.1 the states", () => {
	test("carries exactly the ten sequencer statuses plan §9.3 lists", () => {
		expect([...RUN_STATUSES] as string[]).toEqual([
			"idle",
			"stage-running",
			"gate-running",
			"blocked",
			"env-error",
			"fatal-cleanup",
			"stopped",
			"stopped-for-human",
			"blocked-for-human",
			"done",
		]);
	});

	test("the terminal set is logic.ts:134's five, no more and no fewer", () => {
		expect(([...TERMINAL_STATUSES] as string[]).sort()).toEqual(
			["blocked-for-human", "done", "fatal-cleanup", "stopped", "stopped-for-human"].sort(),
		);
		for (const status of ["idle", "stage-running", "gate-running", "blocked", "env-error"] as RunStatus[]) {
			expect(isTerminal(status)).toBe(false);
		}
	});

	test("the two transient statuses are the ones [C-09] says are never persisted", () => {
		expect([...TRANSIENT_STATUSES] as string[]).toEqual(["stage-running", "gate-running"]);
	});

	test("observedStatus is toDisplayStatus(): queued wins, then active, then the raw status", () => {
		expect(observedStatus({ status: "idle", queued: true, active: false })).toBe("queued");
		expect(observedStatus({ status: "blocked", queued: true, active: false })).toBe("queued");
		expect(observedStatus({ status: "idle", queued: false, active: true })).toBe("stage-running");
		expect(observedStatus({ status: "blocked", queued: false, active: true })).toBe("stage-running");
		expect(observedStatus({ status: "stopped-for-human", queued: false, active: false })).toBe("stopped-for-human");
	});

	test("retriesRemaining follows logic.ts:184's policy and is null when not retryable", () => {
		expect(MAX_RETRIES).toEqual({ blocked: 2, "env-error": 1 });
		expect(retriesRemaining("blocked", 0)).toBe(2);
		expect(retriesRemaining("blocked", 1)).toBe(1);
		expect(retriesRemaining("blocked", 2)).toBe(0);
		expect(retriesRemaining("env-error", 0)).toBe(1);
		expect(retriesRemaining("env-error", 1)).toBe(0);
		for (const status of ["idle", "done", "stopped", "stopped-for-human", "blocked-for-human", "fatal-cleanup"] as RunStatus[]) {
			expect(retriesRemaining(status, 0)).toBeNull();
		}
	});

	test("a job with no run record reports idle at stage 0", () => {
		expect(noRunRecordState()).toEqual({
			status: "idle",
			queued: false,
			active: false,
			hasRunRecord: false,
			stageIndex: 0,
			retryCount: 0,
		});
	});
});

describe("§3.2 the transition table, row by row", () => {
	test("T1 — (no job) → registered, idle, hasRunRecord:false", () => {
		const result = transition(null, "register");
		expect(result?.transition.id).toBe("T1");
		expect(result?.next).toEqual(noRunRecordState());
		expect(result?.transition.events).toEqual(["job.created"]);
	});

	test("T2 — idle, not scheduled → queued", () => {
		const result = transition(state({ status: "idle" }), "start");
		expect(result?.transition.id).toBe("T2");
		expect(result?.next.queued).toBe(true);
		expect(result?.next.active).toBe(false);
		expect(result?.next.status).toBe("idle");
	});

	test("T3 — queued → active, when a slot frees", () => {
		const result = transition(state({ queued: true }), "admit");
		expect(result?.transition.id).toBe("T3");
		expect(result?.next).toMatchObject({ queued: false, active: true });
	});

	test("T4 — idle + active → stage-running, and it is never persisted ([C-09])", () => {
		const result = transition(state({ active: true }), "stage-begin");
		expect(result?.transition.id).toBe("T4");
		expect(result?.next.status).toBe("stage-running");
		expect(result?.transition.persisted).toBe(false);
	});

	test("T5 — stage-running → gate-running, also transient", () => {
		const result = transition(state({ status: "stage-running", active: true }), "settle-begin");
		expect(result?.transition.id).toBe("T5");
		expect(result?.next.status).toBe("gate-running");
		expect(result?.transition.persisted).toBe(false);
	});

	test("T6 — gate exit 0 on a non-final stage advances one stage and clears the retry count", () => {
		const result = transition(state({ status: "gate-running", active: true, stageIndex: 2, retryCount: 1 }), "gate-pass");
		expect(result?.transition.id).toBe("T6");
		expect(result?.next).toMatchObject({ status: "idle", stageIndex: 3, retryCount: 0 });
		// Only `idle` continues the drive loop, which is what makes a whole run
		// occupy one slot for its duration (§4.1).
		expect(result?.next.active).toBe(true);
		expect(result?.transition.events).toEqual(["run.progress_changed"]);
	});

	test("T7 — gate exit 0 on `final` is done, and the slot is released", () => {
		const result = transition(state({ status: "gate-running", active: true, stageIndex: LAST_STAGE_INDEX }), "gate-pass");
		expect(result?.transition.id).toBe("T7");
		expect(result?.next).toMatchObject({ status: "done", queued: false, active: false });
		expect(result?.transition.events).toEqual(["run.completed"]);
	});

	test("T8 — human-stop.yaml entries stop the run before the gate runs", () => {
		const result = transition(state({ status: "gate-running", active: true }), "human-stop-detected");
		expect(result?.transition.id).toBe("T8");
		expect(result?.next.status).toBe("stopped-for-human");
		expect(result?.transition.events).toEqual(["run.status_changed", "human_action.requested"]);
	});

	test("T9 — gate exit 1 with retries remaining is blocked", () => {
		for (const retryCount of [0, 1]) {
			const result = transition(state({ status: "gate-running", active: true, stageIndex: 2, retryCount }), "gate-exit-1");
			expect(result?.transition.id).toBe("T9");
			expect(result?.next.status).toBe("blocked");
			// A pause releases the slot immediately (§4.1).
			expect(result?.next.active).toBe(false);
		}
	});

	test("T10 — gate exit 1 with retries exhausted is blocked-for-human", () => {
		const result = transition(
			state({ status: "gate-running", active: true, stageIndex: 2, retryCount: MAX_RETRIES.blocked }),
			"gate-exit-1",
		);
		expect(result?.transition.id).toBe("T10");
		expect(result?.next.status).toBe("blocked-for-human");
		expect(result?.transition.events).toContain("human_action.requested");
	});

	test("T10 — a failing `final` gate is blocked-for-human at once, because final never retries", () => {
		const result = transition(
			state({ status: "gate-running", active: true, stageIndex: LAST_STAGE_INDEX, retryCount: 0 }),
			"final-gate-fail",
		);
		expect(result?.transition.id).toBe("T10");
		expect(result?.next.status).toBe("blocked-for-human");
	});

	test("T11 — gate exit 2 with a retry left is env-error", () => {
		const result = transition(state({ status: "gate-running", active: true, stageIndex: 2, retryCount: 0 }), "gate-exit-2");
		expect(result?.transition.id).toBe("T11");
		expect(result?.next.status).toBe("env-error");
	});

	test("T12 — gate exit 2 with retries exhausted is blocked-for-human", () => {
		const result = transition(
			state({ status: "gate-running", active: true, stageIndex: 2, retryCount: MAX_RETRIES["env-error"] }),
			"gate-exit-2",
		);
		expect(result?.transition.id).toBe("T12");
		expect(result?.next.status).toBe("blocked-for-human");
	});

	test("T13 — a stage process failure with a retry left is env-error", () => {
		const result = transition(state({ status: "stage-running", active: true, retryCount: 0 }), "stage-process-fail");
		expect(result?.transition.id).toBe("T13");
		expect(result?.next.status).toBe("env-error");
	});

	test("T14 — a stage process failure with retries exhausted is blocked-for-human", () => {
		const result = transition(
			state({ status: "stage-running", active: true, retryCount: MAX_RETRIES["env-error"] }),
			"stage-process-fail",
		);
		expect(result?.transition.id).toBe("T14");
		expect(result?.next.status).toBe("blocked-for-human");
	});

	test("T15 — an unprovable process-group death latches fatal-cleanup from either running status", () => {
		for (const status of ["stage-running", "gate-running"] as RunStatus[]) {
			const result = transition(state({ status, active: true }), "cleanup-failed");
			expect(result?.transition.id).toBe("T15");
			expect(result?.next.status).toBe("fatal-cleanup");
			// Every other active run is aborted, so the queue changes too.
			expect(result?.transition.events).toEqual(["run.failed", "queue.changed"]);
		}
	});

	test("T16 — the abort signal mid-attempt is stopped", () => {
		for (const status of ["stage-running", "gate-running"] as RunStatus[]) {
			const result = transition(state({ status, active: true }), "abort-signal");
			expect(result?.transition.id).toBe("T16");
			expect(result?.next.status).toBe("stopped");
		}
	});

	test("T17 — stop on a queued run removes it from the queue and marks it stopped", () => {
		const result = transition(state({ status: "idle", queued: true }), "stop");
		expect(result?.transition.id).toBe("T17");
		expect(result?.next).toMatchObject({ status: "stopped", queued: false, active: false });
		expect(result?.transition.events).toContain("queue.changed");
	});

	test("T18 — stop on an active run is stopped", () => {
		const result = transition(state({ status: "idle", active: true }), "stop");
		expect(result?.transition.id).toBe("T18");
		expect(result?.next).toMatchObject({ status: "stopped", active: false });
	});

	test("T19 — retry re-queues a blocked/env-error run without spending the retry at accept time", () => {
		for (const status of ["blocked", "env-error"] as RunStatus[]) {
			const result = transition(state({ status, retryCount: 1 }), "retry");
			expect(result?.transition.id).toBe("T19");
			expect(result?.next).toMatchObject({ status, queued: true });
			// §5.7: "retryCount increments when the attempt starts, not when the
			// command is accepted".
			expect(result?.next.retryCount).toBe(1);
			expect(result?.transition.events).toContain("human_action.resolved");
		}
	});

	test("T20 — repair is a full pipeline restart from Stage 1, not Stage 0", () => {
		const result = transition(state({ status: "blocked-for-human", stageIndex: 5, retryCount: 2 }), "repair");
		expect(result?.transition.id).toBe("T20");
		expect(result?.next).toMatchObject({
			status: "idle",
			stageIndex: REPAIR_STAGE_INDEX,
			retryCount: 0,
			queued: true,
			active: false,
		});
		expect(REPAIR_STAGE_INDEX).toBe(1);
	});

	test("T20 — repair works from every not-queued, not-active status, including a job with no run record", () => {
		for (const status of RUN_STATUSES) {
			const result = transition(state({ status }), "repair");
			expect(result?.transition.id).toBe("T20");
		}
		const fresh = transition(noRunRecordState(), "repair");
		expect(fresh?.next).toMatchObject({ hasRunRecord: true, stageIndex: REPAIR_STAGE_INDEX, queued: true });
	});

	test("T21 — the `keep` exclusion decision reaches the same place as T20", () => {
		const repair = transition(state({ status: "done", stageIndex: LAST_STAGE_INDEX }), "repair");
		const keep = transition(state({ status: "done", stageIndex: LAST_STAGE_INDEX }), "keep-decision");
		expect(keep?.transition.id).toBe("T21");
		expect(keep?.next).toEqual(repair!.next);
	});

	test("T22/T23 — graceful shutdown drains the queue and aborts active attempts", () => {
		const drained = transition(state({ queued: true }), "shutdown-drain");
		expect(drained?.transition.id).toBe("T22");
		expect(drained?.next.status).toBe("stopped");

		const aborted = transition(state({ active: true }), "shutdown-abort");
		expect(aborted?.transition.id).toBe("T23");
		expect(aborted?.next.status).toBe("stopped");
	});

	test("T24 — boot re-queues every persisted idle record, and only those", () => {
		const requeued = transition(state({ status: "idle", hasRunRecord: true }), "boot-requeue");
		expect(requeued?.transition.id).toBe("T24");
		expect(requeued?.next.queued).toBe(true);

		// §4.3: a paused run is not re-queued — "a restart must not paper over a
		// state that already requires a human".
		for (const status of ["blocked", "env-error", "stopped", "stopped-for-human", "blocked-for-human", "done", "fatal-cleanup"] as RunStatus[]) {
			expect(transition(state({ status }), "boot-requeue")).toBeNull();
		}
		// A job with nothing persisted has nothing to resume.
		expect(transition(noRunRecordState(), "boot-requeue")).toBeNull();
	});

	test("T25 — archiving human-stop.yaml out of band returns the run to idle", () => {
		const result = transition(state({ status: "stopped-for-human" }), "human-stop-archived");
		expect(result?.transition.id).toBe("T25");
		expect(result?.next.status).toBe("idle");
		// The sequencer never clears the file itself (logic.ts:64), and [C-13]
		// exposes no route for it — this row records the out-of-band act.
		expect(result?.transition.where).toContain("logic.ts:64");
	});

	test("the table carries every row T1..T25 the spec numbers", () => {
		const ids = new Set(TRANSITIONS.map((row) => row.id));
		for (let n = 1; n <= 25; n += 1) {
			expect(ids.has(`T${n}`)).toBe(true);
		}
		// T10 is the only id with two rows — "gate exit 1 exhausted" and "gate
		// exit 1/2 on final", which §3.2 states as one row with two clauses.
		expect(TRANSITIONS.length).toBe(26);
	});
});

describe("§3.3 the transitions that do not exist", () => {
	test("a gate cannot pass from a state that never ran one", () => {
		for (const status of ["idle", "blocked", "env-error", "done", "stopped"] as RunStatus[]) {
			expect(transition(state({ status }), "gate-pass")).toBeNull();
		}
	});

	test("retry from a terminal human-pause state has no transition", () => {
		for (const status of ["stopped-for-human", "blocked-for-human", "done", "stopped", "fatal-cleanup"] as RunStatus[]) {
			expect(transition(state({ status }), "retry")).toBeNull();
		}
	});

	test("repair has no transition while the run is queued or active", () => {
		expect(transition(state({ queued: true }), "repair")).toBeNull();
		expect(transition(state({ active: true }), "repair")).toBeNull();
	});

	test("stop has no transition when the run is neither queued nor active", () => {
		for (const status of RUN_STATUSES) {
			expect(transition(state({ status }), "stop")).toBeNull();
		}
	});

	test("start has no transition once the run is already scheduled or past idle", () => {
		expect(transition(state({ queued: true }), "start")).toBeNull();
		expect(transition(state({ active: true }), "start")).toBeNull();
		for (const status of ["blocked", "env-error", "done", "stopped", "stopped-for-human", "blocked-for-human", "fatal-cleanup"] as RunStatus[]) {
			expect(transition(state({ status }), "start")).toBeNull();
		}
	});

	// The structural guarantee §3.3's penultimate row calls out: `advance()` is
	// private and reached only from an exit-0, so no verb can jump the queue.
	test("no trigger advances stageIndex except a passing completion check", () => {
		const triggers: Trigger[] = [
			"register",
			"start",
			"admit",
			"stage-begin",
			"settle-begin",
			"human-stop-detected",
			"gate-exit-1",
			"gate-exit-2",
			"final-gate-fail",
			"stage-process-fail",
			"cleanup-failed",
			"abort-signal",
			"stop",
			"retry",
			"repair",
			"keep-decision",
			"shutdown-drain",
			"shutdown-abort",
			"boot-requeue",
			"human-stop-archived",
		];
		for (const trigger of triggers) {
			for (const status of RUN_STATUSES) {
				for (const scheduling of [{}, { queued: true }, { active: true }]) {
					const before = state({ status, stageIndex: 3, retryCount: 1, ...scheduling });
					const result = transition(before, trigger);
					if (!result) continue;
					// `repair`/`keep` RESET the index to `segment`; nothing moves it
					// forward.
					expect(result.next.stageIndex).toBeLessThanOrEqual(before.stageIndex);
				}
			}
		}
	});

	test("a passing gate is the only way forward, and it moves exactly one stage", () => {
		for (let index = 0; index < LAST_STAGE_INDEX; index += 1) {
			const result = transition(state({ status: "gate-running", active: true, stageIndex: index }), "gate-pass");
			expect(result?.next.stageIndex).toBe(index + 1);
		}
		expect(STAGE_COUNT).toBe(7);
	});
});

describe("§3.4 the command-legality matrix", () => {
	// The matrix, transcribed from the spec's own table. `review` is the fifth
	// column (exclusion decision / group PATCH), which is not a run command and
	// never appears in allowedCommands (§2.4).
	type Row = {
		label: string;
		state: MachineState;
		start: boolean;
		retry: boolean;
		repair: boolean;
		stop: boolean;
		review: boolean;
	};

	const ROWS: Row[] = [
		{ label: "no run record", state: noRunRecordState(), start: true, retry: false, repair: true, stop: false, review: false },
		{ label: "idle, not scheduled", state: state({ status: "idle" }), start: true, retry: false, repair: true, stop: false, review: true },
		{ label: "queued", state: state({ status: "idle", queued: true }), start: true, retry: false, repair: false, stop: true, review: false },
		{ label: "active", state: state({ status: "idle", active: true }), start: false, retry: false, repair: false, stop: true, review: false },
		{ label: "blocked", state: state({ status: "blocked" }), start: false, retry: true, repair: true, stop: false, review: true },
		{ label: "env-error", state: state({ status: "env-error" }), start: false, retry: true, repair: true, stop: false, review: true },
		{ label: "stopped", state: state({ status: "stopped" }), start: false, retry: false, repair: true, stop: false, review: true },
		{ label: "stopped-for-human", state: state({ status: "stopped-for-human" }), start: false, retry: false, repair: true, stop: false, review: true },
		{ label: "blocked-for-human", state: state({ status: "blocked-for-human" }), start: false, retry: false, repair: true, stop: false, review: true },
		{ label: "done", state: state({ status: "done", stageIndex: LAST_STAGE_INDEX }), start: false, retry: false, repair: true, stop: false, review: true },
	];

	for (const row of ROWS) {
		test(`row "${row.label}" matches the matrix`, () => {
			expect(checkCommand(row.state, "start").ok).toBe(row.start);
			expect(checkCommand(row.state, "retry").ok).toBe(row.retry);
			expect(checkCommand(row.state, "repair").ok).toBe(row.repair);
			expect(checkCommand(row.state, "stop").ok).toBe(row.stop);
			expect(checkReviewWrite(row.state).ok).toBe(row.review);
		});
	}

	test("allowedCommands is exactly the row, in RUN_COMMANDS order", () => {
		for (const row of ROWS) {
			const expected: RunCommand[] = RUN_COMMANDS.filter((command) => row[command]);
			expect(allowedCommands(row.state)).toEqual(expected);
		}
	});

	test("§5.5's own example: a blocked run allows retry and repair", () => {
		expect(allowedCommands(state({ status: "blocked" }))).toEqual(["retry", "repair"]);
	});

	test("§2.4's own example: an active run allows only stop", () => {
		expect(allowedCommands(state({ active: true }))).toEqual(["stop"]);
	});

	test("§3.5: a human-paused run's way forward is repair, and only repair", () => {
		for (const status of ["stopped-for-human", "blocked-for-human"] as RunStatus[]) {
			expect(allowedCommands(state({ status }))).toEqual(["repair"]);
		}
	});

	test("[C-12] start on a queued run succeeds as a no-op rather than conflicting", () => {
		const result = checkCommand(state({ queued: true }), "start");
		expect(result).toEqual({ ok: true, effect: "already-queued" });
	});

	test("[C-18] stop on an already-stopped run is run_not_running, not a success", () => {
		expect(checkCommand(state({ status: "stopped" }), "stop")).toEqual({ ok: false, code: "run_not_running" });
	});

	test("each refusal carries the §3.3 code for that command", () => {
		expect(checkCommand(state({ status: "done" }), "start")).toEqual({ ok: false, code: "run_not_startable" });
		expect(checkCommand(state({ status: "blocked" }), "start")).toEqual({ ok: false, code: "run_not_startable" });
		expect(checkCommand(state({ status: "done" }), "retry")).toEqual({ ok: false, code: "run_not_retryable" });
		expect(checkCommand(state({ queued: true }), "repair")).toEqual({ ok: false, code: "run_not_repairable" });
		expect(checkCommand(state({ active: true }), "repair")).toEqual({ ok: false, code: "run_not_repairable" });
	});

	test("a review write is run_busy while the run is queued or active", () => {
		expect(checkReviewWrite(state({ queued: true }))).toMatchObject({ ok: false, code: "run_busy" });
		expect(checkReviewWrite(state({ active: true }))).toMatchObject({ ok: false, code: "run_busy" });
	});

	test("§5.7: a retry for a run already re-queued by an earlier retry is a no-op success", () => {
		expect(checkCommand(state({ status: "blocked", queued: true }), "retry")).toEqual({
			ok: true,
			effect: "already-queued",
		});
	});
});

describe("§3.4's fatal-cleanup row and §4.3's latch", () => {
	const latched = { fatalCleanupLatched: true };

	test("start/retry/repair are 503 halted_fatal_cleanup while the latch is set", () => {
		for (const command of ["start", "retry", "repair"] as RunCommand[]) {
			expect(checkCommand(state({ status: "blocked" }), command, latched)).toEqual({
				ok: false,
				code: "halted_fatal_cleanup",
			});
		}
	});

	test("stop is never refused for the latch — §5.9 says so in as many words", () => {
		expect(checkCommand(state({ active: true }), "stop", latched)).toEqual({ ok: true, effect: "cancel" });
	});

	test("reads and review writes are unaffected by the latch", () => {
		expect(checkReviewWrite(state({ status: "fatal-cleanup" }), latched).ok).toBe(true);
	});

	test("after a restart clears the latch, repair is what clears a persisted fatal-cleanup (§5.8)", () => {
		expect(checkCommand(state({ status: "fatal-cleanup" }), "repair")).toEqual({
			ok: true,
			effect: "reset-and-enqueue",
		});
		expect(allowedCommands(state({ status: "fatal-cleanup" }))).toEqual(["repair"]);
	});
});
