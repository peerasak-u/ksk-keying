// Spec §3, as code: the states (§3.1), the transition table (§3.2, T1–T25), the
// illegal set (§3.3), and the command-legality matrix (§3.4).
//
// Pure. No filesystem, no clock, no process, no orchestrator — exactly the
// shape `console/sequencer/logic.ts` already uses, and testable the same way.
// The spec is emphatic that this machine "invents nothing: every transition
// below is traceable to a line of the runtime", so every row carries its
// runtime citation and `runtime-parity.test.ts` holds the status/stage lists to
// the sequencer's own.
//
// Wiring these decisions to the orchestrator is a later slice. What lives here
// is the decision and its error code; the execution is not.
import type { ErrorCode } from "../errors/codes";
import { LAST_STAGE_INDEX, REPAIR_STAGE_INDEX } from "./stages";

// ---------------------------------------------------------------------------
// §3.1 Axis A — sequencer status
// ---------------------------------------------------------------------------

export const RUN_STATUSES = [
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
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/** logic.ts:134. "Terminal" means the sequencer will not move on its own and a
 * restart will not resume it — it does NOT mean the run is finished with. */
export const TERMINAL_STATUSES: readonly RunStatus[] = [
	"done",
	"fatal-cleanup",
	"stopped",
	"stopped-for-human",
	"blocked-for-human",
] as const;

export function isTerminal(status: RunStatus): boolean {
	return TERMINAL_STATUSES.includes(status);
}

/** [C-09]: `stage-running` and `gate-running` exist only transiently inside one
 * in-flight `attempt()` call and are never persisted (run-store.ts:7-17). They
 * stay in the enum — plan §9.3 requires every current sequencer status to
 * survive in the neutral DTO — but v1 does not emit `gate-running`. */
export const TRANSIENT_STATUSES: readonly RunStatus[] = ["stage-running", "gate-running"] as const;

/** logic.ts:184. The whole retry policy, and the source of §1.7's
 * `retriesRemaining`. */
export const MAX_RETRIES = { blocked: 2, "env-error": 1 } as const;

/** §1.7: `null` when the current status is not retryable. */
export function retriesRemaining(status: RunStatus, retryCount: number): number | null {
	if (status === "blocked") return Math.max(0, MAX_RETRIES.blocked - retryCount);
	if (status === "env-error") return Math.max(0, MAX_RETRIES["env-error"] - retryCount);
	return null;
}

// ---------------------------------------------------------------------------
// §3.1 The machine's state: both axes plus existence
// ---------------------------------------------------------------------------

export type MachineState = {
	status: RunStatus;
	/** Axis B (orchestrator.ts:95-103). Never both true; both false means the
	 * run is at rest, whatever its status. */
	queued: boolean;
	active: boolean;
	/** Axis C: a job may be registered with no `run-state.yaml` at all. */
	hasRunRecord: boolean;
	stageIndex: number;
	/** Retries USED for the current stage (logic.ts:139). */
	retryCount: number;
};

/** §1.7's `observedStatus` — exactly `toDisplayStatus()`
 * (`console/app/dashboard.ts:79-84`), lifted into the contract so the platform
 * and the CLI do not each re-derive it. Additive: `status`, `queued` and
 * `active` are always present beside it. */
export type ObservedStatus = RunStatus | "queued";

export function observedStatus(state: Pick<MachineState, "status" | "queued" | "active">): ObservedStatus {
	if (state.queued) return "queued";
	if (state.active) return "stage-running";
	return state.status;
}

/** §1.7: a registered job with no run record reports `idle` at stage 0 — which
 * is already what the runtime reports (`dashboard.ts:80`). */
export function noRunRecordState(): MachineState {
	return { status: "idle", queued: false, active: false, hasRunRecord: false, stageIndex: 0, retryCount: 0 };
}

// ---------------------------------------------------------------------------
// §3.2 The transition table — T1..T25
// ---------------------------------------------------------------------------

export type Trigger =
	| "register" // T1
	| "start" // T2
	| "admit" // T3 — a slot frees and pump() admits the head of the queue
	| "stage-begin" // T4
	| "settle-begin" // T5
	| "gate-pass" // T6, T7
	| "human-stop-detected" // T8
	| "gate-exit-1" // T9, T10
	| "gate-exit-2" // T11, T12
	| "final-gate-fail" // T10's second clause
	| "stage-process-fail" // T13, T14
	| "cleanup-failed" // T15
	| "abort-signal" // T16
	| "stop" // T17, T18
	| "retry" // T19
	| "repair" // T20
	| "keep-decision" // T21
	| "shutdown-drain" // T22
	| "shutdown-abort" // T23
	| "boot-requeue" // T24
	| "human-stop-archived"; // T25

export type TransitionId = `T${number}`;

export type Transition = {
	id: TransitionId;
	/** The spec's own From/To wording, so a reviewer can read the table off the
	 * code without the document open. */
	from: string;
	to: string;
	trigger: Trigger;
	/** The runtime line §3.2 cites for this row. */
	where: string;
	/** The SSE events §6.2 emits. Carried as data only — SSE itself is a later
	 * slice, and this is the list it will read. */
	events: readonly string[];
	/** false for the two transient statuses [C-09]: they never reach disk. */
	persisted: boolean;
	matches: (state: MachineState | null) => boolean;
	apply: (state: MachineState) => MachineState;
};

/** Every transition that ends the drive loop releases the run's slot the moment
 * it lands (§4.1: "A run that pauses releases its slot immediately … One stuck
 * client-month can never hold the queue"). Only `idle` continues the loop. */
function atRest(state: MachineState, status: RunStatus): MachineState {
	return { ...state, status, queued: false, active: false };
}

function scheduled(state: MachineState): boolean {
	return state.queued || state.active;
}

const TRANSITION_LIST: Transition[] = [
	{
		id: "T1",
		from: "(no job)",
		to: "job registered, idle, hasRunRecord:false",
		trigger: "register",
		where: "job module",
		events: ["job.created"],
		persisted: true,
		matches: (state) => state === null,
		apply: () => noRunRecordState(),
	},
	{
		id: "T2",
		from: "idle, not scheduled",
		to: "(scheduler) queued:true",
		trigger: "start",
		where: "orchestrator.ts:184-190",
		events: ["run.queued", "queue.changed"],
		persisted: true,
		matches: (state) => state !== null && state.status === "idle" && !scheduled(state),
		apply: (state) => ({ ...state, queued: true }),
	},
	{
		id: "T3",
		from: "queued:true",
		to: "(scheduler) active:true",
		trigger: "admit",
		where: "orchestrator.ts:121-141",
		events: ["run.started", "queue.changed"],
		persisted: true,
		matches: (state) => state !== null && state.queued,
		apply: (state) => ({ ...state, queued: false, active: true }),
	},
	{
		id: "T4",
		from: "idle + active",
		to: "stage-running (transient)",
		trigger: "stage-begin",
		where: "logic.ts:301-304",
		events: ["run.status_changed"],
		persisted: false,
		matches: (state) => state !== null && state.status === "idle" && state.active,
		apply: (state) => ({ ...state, status: "stage-running" }),
	},
	{
		id: "T5",
		from: "stage-running",
		to: "gate-running (transient)",
		trigger: "settle-begin",
		where: "logic.ts:190-204",
		events: ["run.status_changed"],
		persisted: false,
		matches: (state) => state !== null && state.status === "stage-running",
		apply: (state) => ({ ...state, status: "gate-running" }),
	},
	{
		id: "T6",
		from: "gate-running",
		to: "idle, stageIndex+1, retryCount:0",
		trigger: "gate-pass",
		where: "logic.ts:164-173,215",
		events: ["run.progress_changed"],
		persisted: true,
		matches: (state) => state !== null && state.status === "gate-running" && state.stageIndex < LAST_STAGE_INDEX,
		// The drive loop continues on `idle`, which is what makes a whole run
		// occupy one slot for its duration without re-queuing between stages
		// (§4.1) — so `active` is deliberately left alone here.
		apply: (state) => ({ ...state, status: "idle", stageIndex: state.stageIndex + 1, retryCount: 0 }),
	},
	{
		id: "T7",
		from: "gate-running",
		to: "done",
		trigger: "gate-pass",
		where: "logic.ts:164-173",
		events: ["run.completed"],
		persisted: true,
		matches: (state) => state !== null && state.status === "gate-running" && state.stageIndex >= LAST_STAGE_INDEX,
		apply: (state) => atRest(state, "done"),
	},
	{
		id: "T8",
		from: "gate-running",
		to: "stopped-for-human",
		trigger: "human-stop-detected",
		where: "logic.ts:195-202",
		events: ["run.status_changed", "human_action.requested"],
		persisted: true,
		matches: (state) => state !== null && state.status === "gate-running",
		apply: (state) => atRest(state, "stopped-for-human"),
	},
	{
		id: "T9",
		from: "gate-running",
		to: "blocked",
		trigger: "gate-exit-1",
		where: "logic.ts:227-232",
		events: ["run.status_changed"],
		persisted: true,
		matches: (state) =>
			state !== null &&
			state.status === "gate-running" &&
			state.stageIndex < LAST_STAGE_INDEX &&
			state.retryCount < MAX_RETRIES.blocked,
		apply: (state) => atRest(state, "blocked"),
	},
	{
		id: "T10",
		from: "gate-running",
		to: "blocked-for-human",
		trigger: "gate-exit-1",
		where: "logic.ts:217-224,233-236",
		events: ["run.status_changed", "human_action.requested"],
		persisted: true,
		// Retries exhausted. The `final` half of T10 is the separate
		// `final-gate-fail` row below, because "gate exit 1 or 2 on final" is a
		// different trigger reaching the same state.
		matches: (state) => state !== null && state.status === "gate-running",
		apply: (state) => atRest(state, "blocked-for-human"),
	},
	{
		id: "T10",
		from: "gate-running (stage `final`, which never retries)",
		to: "blocked-for-human",
		trigger: "final-gate-fail",
		where: "logic.ts:217-224",
		events: ["run.status_changed", "human_action.requested"],
		persisted: true,
		matches: (state) => state !== null && state.status === "gate-running",
		apply: (state) => atRest(state, "blocked-for-human"),
	},
	{
		id: "T11",
		from: "gate-running",
		to: "env-error",
		trigger: "gate-exit-2",
		where: "logic.ts:240-244",
		events: ["run.status_changed"],
		persisted: true,
		matches: (state) =>
			state !== null &&
			state.status === "gate-running" &&
			state.stageIndex < LAST_STAGE_INDEX &&
			state.retryCount < MAX_RETRIES["env-error"],
		apply: (state) => atRest(state, "env-error"),
	},
	{
		id: "T12",
		from: "gate-running",
		to: "blocked-for-human",
		trigger: "gate-exit-2",
		where: "logic.ts:245-248",
		events: ["run.status_changed", "human_action.requested"],
		persisted: true,
		matches: (state) => state !== null && state.status === "gate-running",
		apply: (state) => atRest(state, "blocked-for-human"),
	},
	{
		id: "T13",
		from: "stage-running",
		to: "env-error",
		trigger: "stage-process-fail",
		where: "logic.ts:283-287",
		events: ["run.status_changed"],
		persisted: true,
		matches: (state) =>
			state !== null && state.status === "stage-running" && state.retryCount < MAX_RETRIES["env-error"],
		apply: (state) => atRest(state, "env-error"),
	},
	{
		id: "T14",
		from: "stage-running",
		to: "blocked-for-human",
		trigger: "stage-process-fail",
		where: "logic.ts:288-291",
		events: ["run.status_changed", "human_action.requested"],
		persisted: true,
		matches: (state) => state !== null && state.status === "stage-running",
		apply: (state) => atRest(state, "blocked-for-human"),
	},
	{
		id: "T15",
		from: "stage-running or gate-running",
		to: "fatal-cleanup",
		trigger: "cleanup-failed",
		where: "logic.ts:207-212,268-273",
		// Every other active run is aborted, which is why queue.changed is here.
		events: ["run.failed", "queue.changed"],
		persisted: true,
		matches: (state) => state !== null && (state.status === "stage-running" || state.status === "gate-running"),
		apply: (state) => atRest(state, "fatal-cleanup"),
	},
	{
		id: "T16",
		from: "stage-running or gate-running",
		to: "stopped",
		trigger: "abort-signal",
		where: "logic.ts:192,196,213,260,274",
		events: ["run.stopped"],
		persisted: true,
		matches: (state) => state !== null && (state.status === "stage-running" || state.status === "gate-running"),
		apply: (state) => atRest(state, "stopped"),
	},
	{
		id: "T17",
		from: "queued:true, any status",
		to: "stopped",
		trigger: "stop",
		where: "orchestrator.ts:280-295",
		events: ["run.stopped", "queue.changed"],
		persisted: true,
		matches: (state) => state !== null && state.queued,
		apply: (state) => atRest(state, "stopped"),
	},
	{
		id: "T18",
		from: "active:true",
		to: "stopped",
		trigger: "stop",
		where: "orchestrator.ts:298-300",
		events: ["run.stopped"],
		persisted: true,
		matches: (state) => state !== null && state.active,
		apply: (state) => atRest(state, "stopped"),
	},
	{
		id: "T19",
		from: "blocked or env-error",
		to: "(scheduler) queued:true",
		trigger: "retry",
		where: "orchestrator.ts:241-250, logic.ts:311-322",
		events: ["run.queued", "human_action.resolved"],
		persisted: true,
		matches: (state) => state !== null && (state.status === "blocked" || state.status === "env-error"),
		// §5.7 is explicit that "`retryCount` increments when the attempt starts,
		// not when the command is accepted", so this scheduler transition leaves
		// the counter alone; §3.2's "retryCount+1" describes what retryStage()
		// then does inside the attempt (logic.ts:313).
		apply: (state) => ({ ...state, queued: true }),
	},
	{
		id: "T20",
		from: "any not-queued, not-active status",
		to: "idle at stageIndex = segment(1), retryCount:0, then queued",
		trigger: "repair",
		where: "orchestrator.ts:252-274",
		events: ["run.status_changed", "run.queued"],
		persisted: true,
		matches: (state) => state !== null && !scheduled(state),
		// A fresh initialState() at `segment` — a full pipeline restart from
		// Stage 1, not from Stage 0 (§5.8).
		apply: (state) => ({
			...state,
			status: "idle",
			stageIndex: REPAIR_STAGE_INDEX,
			retryCount: 0,
			hasRunRecord: true,
			queued: true,
			active: false,
		}),
	},
	{
		id: "T21",
		from: "any not-queued, not-active status",
		to: "as T20",
		trigger: "keep-decision",
		where: "server.ts:512-530",
		events: ["run.status_changed", "run.queued"],
		persisted: true,
		matches: (state) => state !== null && !scheduled(state),
		apply: (state) => ({
			...state,
			status: "idle",
			stageIndex: REPAIR_STAGE_INDEX,
			retryCount: 0,
			hasRunRecord: true,
			queued: true,
			active: false,
		}),
	},
	{
		id: "T22",
		from: "queued:true",
		to: "stopped",
		trigger: "shutdown-drain",
		where: "orchestrator.ts:306-317",
		events: ["run.stopped"],
		persisted: true,
		matches: (state) => state !== null && state.queued,
		apply: (state) => atRest(state, "stopped"),
	},
	{
		id: "T23",
		from: "active:true",
		to: "stopped",
		trigger: "shutdown-abort",
		where: "orchestrator.ts:318-323",
		events: ["run.stopped"],
		persisted: true,
		matches: (state) => state !== null && state.active,
		apply: (state) => atRest(state, "stopped"),
	},
	{
		id: "T24",
		from: "idle (persisted), not scheduled",
		to: "(scheduler) queued:true",
		trigger: "boot-requeue",
		where: "orchestrator.ts:201-207",
		events: ["run.queued"],
		persisted: true,
		// Boot re-queues every persisted `idle` record. A job with no run record
		// has nothing persisted to resume, so it is not re-queued.
		matches: (state) => state !== null && state.hasRunRecord && state.status === "idle" && !scheduled(state),
		apply: (state) => ({ ...state, queued: true }),
	},
	{
		id: "T25",
		from: "stopped-for-human",
		to: "idle",
		trigger: "human-stop-archived",
		where: "logic.ts:64 (never cleared by the sequencer)",
		events: ["run.status_changed"],
		persisted: true,
		// Out of band: a human archives human-stop.yaml, then issues `repair`
		// (T20). [C-13] — Core exposes no route for the archive itself.
		matches: (state) => state !== null && state.status === "stopped-for-human",
		apply: (state) => ({ ...state, status: "idle" }),
	},
];

export const TRANSITIONS: readonly Transition[] = TRANSITION_LIST;

export type TransitionResult = { transition: Transition; next: MachineState };

/** The pure transition function. Returns `null` for a move the machine does not
 * have — §3.3's illegal set is exactly "no row matched", not a check somebody
 * remembered to write. */
export function transition(state: MachineState | null, trigger: Trigger): TransitionResult | null {
	for (const candidate of TRANSITION_LIST) {
		if (candidate.trigger !== trigger) continue;
		if (!candidate.matches(state)) continue;
		// T1 is the only row whose `from` is "(no job)"; every other row needs a
		// state to apply to, and `matches` already refused a null one.
		const base = state ?? noRunRecordState();
		return { transition: candidate, next: candidate.apply(base) };
	}
	return null;
}

// ---------------------------------------------------------------------------
// §3.4 Command legality
// ---------------------------------------------------------------------------

/** The four run commands, in the order `allowedCommands[]` reports them. */
export const RUN_COMMANDS = ["start", "retry", "repair", "stop"] as const;
export type RunCommand = (typeof RUN_COMMANDS)[number];

/** The matrix's fifth column — the exclusion decision (§5.17) and the group
 * PATCH (§5.18). It is not a run command and never appears in
 * `allowedCommands[]`, which §2.4 defines as "the row of §3.4's matrix". */
export type ReviewWrite = "review-write";

export type CommandContext = {
	/** Process-local and cleared by a restart (`orchestrator.ts:196-198`); the
	 * run's persisted `fatal-cleanup` status is not. Both halves are
	 * deliberate (§4.3). */
	fatalCleanupLatched: boolean;
};

export type CommandLegality =
	| { ok: true; effect: "enqueue" | "already-queued" | "reset-and-enqueue" | "cancel" }
	| { ok: false; code: ErrorCode };

const NO_LATCH: CommandContext = { fatalCleanupLatched: false };

/** §3.4, one row at a time. The `409` codes come straight from §3.3's response
 * column; the `503` is §3.3's last-but-two row.
 *
 * The latch is an input, not a status, because §5.8 is explicit that a
 * persisted `fatal-cleanup` survives the restart that clears the latch — "so
 * after the restart `repair` is exactly the command that clears it". §3.4's
 * `fatal-cleanup` row annotates its three ❌ with `503`, which is the latched
 * case; unlatched, that row behaves like the other terminal statuses. */
export function checkCommand(
	state: MachineState,
	command: RunCommand,
	context: CommandContext = NO_LATCH,
): CommandLegality {
	// §5.9: `stop` is never refused for the latch — "stopping is exactly what
	// one wants to be able to do when the latch is set".
	if (context.fatalCleanupLatched && command !== "stop") {
		return { ok: false, code: "halted_fatal_cleanup" };
	}

	switch (command) {
		case "start":
			// [C-12]: a start for a run already in the queue is a success that
			// enqueues nothing — exactly what the runtime does
			// (orchestrator.ts:186 de-duplicates), and what makes the
			// double-clicked เริ่มรัน safe before the idempotency key is consulted.
			if (state.queued) return { ok: true, effect: "already-queued" };
			if (state.active) return { ok: false, code: "run_not_startable" };
			if (!state.hasRunRecord || state.status === "idle") return { ok: true, effect: "enqueue" };
			return { ok: false, code: "run_not_startable" };

		case "retry":
			// Only `blocked`/`env-error` are retryable: retryStage() no-ops on
			// every other status (logic.ts:312) and the orchestrator refuses
			// before reaching it. `stopped-for-human`/`blocked-for-human` are
			// deliberately terminal — a human must intervene first
			// (logic.ts:309-310).
			if (state.status !== "blocked" && state.status !== "env-error") {
				return { ok: false, code: "run_not_retryable" };
			}
			// A run re-queued by an earlier `retry` keeps its `blocked` status
			// until the attempt begins, so "queued and blocked" is a real
			// condition. §5.7's table answers it directly — 202 with
			// `alreadyQueued: true`, nothing enqueued — and the runtime agrees
			// (enqueueForProcessing de-duplicates at orchestrator.ts:186).
			if (state.queued) return { ok: true, effect: "already-queued" };
			// An active run holds a slot and is re-running the stage right now;
			// §3.4's `active` row refuses every command but `stop`.
			if (state.active) return { ok: false, code: "run_not_retryable" };
			return { ok: true, effect: "enqueue" };

		case "repair":
			// Repair rewrites run-state.yaml, so it may not run under a live
			// writer. Note this is a statement about the state machine only: when
			// there is human review work to lose, §5.8's [C-40] additionally
			// requires `acknowledgeDiscard: true`, and `repair` still appears in
			// allowedCommands (§3.4's note).
			if (scheduled(state)) return { ok: false, code: "run_not_repairable" };
			return { ok: true, effect: "reset-and-enqueue" };

		case "stop":
			if (state.queued || state.active) return { ok: true, effect: "cancel" };
			// [C-18]: `stop` on an already-stopped run is 409, not a success —
			// it matches the runtime (orchestrator.ts:296), and returning 200
			// would tell a caller it cancelled something it did not.
			return { ok: false, code: "run_not_running" };
	}
}

export type ReviewWriteLegality =
	| { ok: true }
	/** `code` is `null` for the one cell §3.4 marks ❌ without naming a code —
	 * "no run record … (nothing to review)". The concrete 404 there falls out of
	 * artifact resolution in §5.17/§5.18, which is a later slice. */
	| { ok: false; code: ErrorCode | null; reason: string };

export function checkReviewWrite(state: MachineState, context: CommandContext = NO_LATCH): ReviewWriteLegality {
	// §3.4's last row: reads and review writes are unaffected by the latch.
	void context;
	if (state.queued || state.active) return { ok: false, code: "run_busy", reason: "run_scheduled" };
	if (!state.hasRunRecord) return { ok: false, code: null, reason: "no_run_record" };
	return { ok: true };
}

/** §2.4: "`allowedCommands[]` is the row of §3.4's matrix for the run's current
 * state. It exists so a platform can grey a button without re-implementing the
 * matrix." Derived from checkCommand so the two can never disagree. */
export function allowedCommands(state: MachineState, context: CommandContext = NO_LATCH): RunCommand[] {
	return RUN_COMMANDS.filter((command) => checkCommand(state, command, context).ok);
}
