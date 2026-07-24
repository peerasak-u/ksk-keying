// PROTOTYPE — throwaway. See NOTES.md for the question this answers.
//
// The pure(ish) sequencer state machine: "spawn one stage -> run that
// stage's REAL deterministic completion check -> branch on the real result
// in code -> refuse to start the next stage under any code path if the check
// didn't pass." This is what console/engine.ts's move-2 sequencer would
// become if the answer is yes.
//
// Portable on purpose: the only I/O seams are the three functions in
// `SequencerDeps`, injected by the caller. tui.ts wires them to real
// Bun.spawns (ledger.ts / stage-shape-check.ts / claude -p / human-stop.yaml
// reads); nothing in this file touches the terminal, a process, or a clock.
//
// Structural invariant under test: there is no exported function that can
// move `stageIndex` forward except the internal `advance()`, and it is only
// ever called after a real completion-check exit-0. No key the TUI could
// bind would let an operator skip ahead — the verb simply doesn't exist,
// mirroring no-mistakes' axi surface (run/respond/abort, nothing that jumps
// the queue).

export type GateExit = 0 | 1 | 2;

export type GateResult = {
	exitCode: GateExit;
	stdout: string;
};

// Every stage now has a real completion check — no stage "advances on
// trust" anymore (the original gap this prototype's NOTES.md flagged).
// `kind: "ledger"` is ledger.ts's three real Page-Ledger gates; `kind:
// "shape"` is the new stage-shape-check.ts probe for stages with no Ledger
// Gate of their own; `kind: "categorize"` is the one chained pair
// (build-review-data.ts then review-groups.ts --force).
export type CompletionCheck =
	| { kind: "ledger"; name: "segment" | "interpret" | "final" }
	| { kind: "shape"; stage: "profile" | "link" | "group" }
	| { kind: "categorize" };

export type StageDef = {
	id: string;
	label: string;
	gate: CompletionCheck;
	// false only for "final" — there is no ksk-stage-final skill to spawn;
	// its completion check just re-examines whatever earlier stages left on
	// disk, so a failure there is never retried (see settle()).
	spawnsProcess: boolean;
};

// Real shape of the ksk-keying pipeline (SKILL.md's Stage 0-5 table), with
// a real completion check wired to every stage.
export const STAGES: StageDef[] = [
	{ id: "profile", label: "Stage 0 — profile", gate: { kind: "shape", stage: "profile" }, spawnsProcess: true },
	{ id: "segment", label: "Stage 1 — segment", gate: { kind: "ledger", name: "segment" }, spawnsProcess: true },
	{ id: "interpret", label: "Stage 2 — interpret", gate: { kind: "ledger", name: "interpret" }, spawnsProcess: true },
	{ id: "link", label: "Stage 3 — link", gate: { kind: "shape", stage: "link" }, spawnsProcess: true },
	{ id: "group", label: "Stage 4 — group", gate: { kind: "shape", stage: "group" }, spawnsProcess: true },
	{ id: "categorize", label: "Stage 5 — categorize", gate: { kind: "categorize" }, spawnsProcess: true },
	{ id: "final", label: "Completion — final", gate: { kind: "ledger", name: "final" }, spawnsProcess: false },
];

// The minimal hard-blocker flag (decision-policy.md's Stop rules, reified).
// Never cleared by the sequencer — only a human archiving the file clears it.
export type HumanStopEntry = {
	stage: string;
	unit: string | null;
	condition: string;
	reason: string;
};

export type StageOutcome = "success" | "fail";

// What a retry attempt knows about its own history — so a retry's prompt
// isn't identical to the first attempt's. Real finding from the first live
// run against a real client: a bare `/ksk-stage-profile <dir>` retry, with
// no feedback about what was missing, just reproduces the exact same
// truncated behavior every time (a fresh context has no reason to act
// differently on attempt 2 than attempt 1 unless told what attempt 1 missed).
export type StageAttemptContext = {
	retryCount: number;
	previousCheckOutput: string | null;
};

// The one seam for actually doing a stage's work. The fixture-driven TUI
// wires this to an instant canned outcome ([s]/[f] keys); spawn-stage.ts's
// real implementation shells out to `claude -p /ksk-stage-<name> <targetDir>`
// and maps the process exit code to success/fail — a process failure here is
// distinct from a completion check failing, because there's no fresh
// evidence to consult yet.
export type StageRunner = (stage: StageDef, targetDir: string, context: StageAttemptContext) => Promise<StageOutcome>;

// The one seam for a stage's completion check — dispatches on `stage.gate.kind`.
export type GateRunner = (stage: StageDef, targetDir: string) => Promise<GateResult>;

// The one seam for the hard-blocker flag: reads
// ข้อมูลระบบ/_pages/human-stop.yaml, returns [] when absent or empty.
export type HumanStopChecker = (targetDir: string) => Promise<HumanStopEntry[]>;

export type SequencerDeps = {
	runStageProcess: StageRunner;
	runGate: GateRunner;
	checkHumanStop: HumanStopChecker;
};

export type Status =
	| "idle" // waiting for the operator to run this stage
	| "stage-running" // the stage's own process (simulated or real) is running
	| "gate-running" // the completion check (human-stop + gate/shape/categorize) is running
	| "blocked" // completion check exit 1 — retries remain
	| "env-error" // completion check exit 2, or the stage process itself failed — retries remain
	| "stopped-for-human" // human-stop.yaml has entries — never auto-cleared, never retried
	| "blocked-for-human" // retries exhausted (or `final`, which is never retried)
	| "done"; // final gate passed

export type State = {
	stageIndex: number;
	status: Status;
	retryCount: number; // retries USED for the current stage
	lastGateStdout: string | null;
	humanStopEntries: HumanStopEntry[];
	log: string[];
};

export function initialState(): State {
	return {
		stageIndex: 0,
		status: "idle",
		retryCount: 0,
		lastGateStdout: null,
		humanStopEntries: [],
		log: [],
	};
}

export function currentStage(state: State): StageDef {
	return STAGES[state.stageIndex];
}

function withLog(state: State, line: string): State {
	return { ...state, log: [...state.log, line].slice(-8) };
}

function advance(state: State): State {
	const isLast = state.stageIndex >= STAGES.length - 1;
	return {
		...state,
		stageIndex: isLast ? state.stageIndex : state.stageIndex + 1,
		status: isLast ? "done" : "idle",
		retryCount: 0,
		humanStopEntries: [],
	};
}

// Bounded auto-retry policy: 2 retries (3 attempts) on a blocked completion
// check — generalizing this repo's existing "one more round, then park for a
// human, never loop further" convention (ksk-lestrade.md, ksk-stage-group's
// termination guard) from claim-level to stage-level, plus one round of
// slack since a whole-stage retry is coarser. 1 retry (2 attempts) on an env
// error / process failure — enough to absorb a one-off hiccup, not a real
// bug. `final` spawns no process, so a blocked final gate is never retried:
// it means an earlier stage left something incomplete, not that final itself
// needs re-running.
const MAX_RETRIES = { blocked: 2, "env-error": 1 } as const;

// Runs after a stage's own process (real or simulated) has completed — the
// one place completion is decided, and the ONLY place that ever reads
// human-stop.yaml or a gate/shape-check exit code. Never consults any
// transcript or prose.
async function settle(state: State, targetDir: string, deps: SequencerDeps, retryCount: number): Promise<State> {
	const stage = currentStage(state);
	let next = withLog({ ...state, status: "gate-running", retryCount }, `${stage.id}: checking human-stop.yaml`);

	const humanStopEntries = await deps.checkHumanStop(targetDir);
	if (humanStopEntries.length > 0) {
		return withLog(
			{ ...next, status: "stopped-for-human", humanStopEntries },
			`${stage.id}: human-stop.yaml has ${humanStopEntries.length} entr${humanStopEntries.length === 1 ? "y" : "ies"} — STOPPED FOR HUMAN`,
		);
	}

	next = withLog(next, `${stage.id}: running completion check`);
	const result = await deps.runGate(stage, targetDir);
	next = { ...next, lastGateStdout: result.stdout };

	if (result.exitCode === 0) return advance(withLog(next, `${stage.id}: completion check PASS`));

	if (!stage.spawnsProcess) {
		// final: no process to retry — an earlier stage left something
		// incomplete. Surface it, but retrying final itself would fail
		// identically forever.
		return withLog(
			{ ...next, status: "blocked-for-human" },
			`${stage.id}: completion check exit ${result.exitCode} — nothing to retry here, BLOCKED FOR HUMAN`,
		);
	}

	if (result.exitCode === 1) {
		if (retryCount < MAX_RETRIES.blocked)
			return withLog(
				{ ...next, status: "blocked" },
				`${stage.id}: completion check exit 1 — BLOCKED (retry ${retryCount}/${MAX_RETRIES.blocked} used)`,
			);
		return withLog(
			{ ...next, status: "blocked-for-human" },
			`${stage.id}: completion check exit 1 — retries exhausted, BLOCKED FOR HUMAN`,
		);
	}

	// exitCode === 2
	if (retryCount < MAX_RETRIES["env-error"])
		return withLog(
			{ ...next, status: "env-error" },
			`${stage.id}: completion check exit 2 — ENV ERROR (retry ${retryCount}/${MAX_RETRIES["env-error"]} used)`,
		);
	return withLog(
		{ ...next, status: "blocked-for-human" },
		`${stage.id}: completion check exit 2 — retries exhausted, BLOCKED FOR HUMAN`,
	);
}

async function attempt(
	state: State,
	targetDir: string,
	deps: SequencerDeps,
	retryCount: number,
	verb: string,
): Promise<State> {
	const stage = currentStage(state);
	let next = withLog({ ...state, status: "stage-running", retryCount }, `${stage.id}: ${verb}`);

	if (stage.spawnsProcess) {
		const outcome = await deps.runStageProcess(stage, targetDir, {
			retryCount,
			previousCheckOutput: state.lastGateStdout,
		});
		if (outcome === "fail") {
			next = withLog(next, `${stage.id}: process FAILED before completion check`);
			if (retryCount < MAX_RETRIES["env-error"])
				return withLog(
					{ ...next, status: "env-error" },
					`${stage.id}: process failure — ENV ERROR (retry ${retryCount}/${MAX_RETRIES["env-error"]} used)`,
				);
			return withLog(
				{ ...next, status: "blocked-for-human" },
				`${stage.id}: process failure — retries exhausted, BLOCKED FOR HUMAN`,
			);
		}
		next = withLog(next, `${stage.id}: process completed`);
	}

	return settle(next, targetDir, deps, retryCount);
}

// The only legal way to make progress from "idle". Everything else in this
// module either no-ops on an illegal status or is a read.
export async function runStage(state: State, targetDir: string, deps: SequencerDeps): Promise<State> {
	if (state.status !== "idle") return state;
	return attempt(state, targetDir, deps, state.retryCount, "starting");
}

// Re-invokes the CURRENT stage from scratch (fresh context, no --resume —
// every ksk-stage-* skill is self-sufficient from on-disk artifacts) —
// proves a blocked/env-error stage can be cleared by new evidence without
// re-running any earlier stage. No-ops from "stopped-for-human" or
// "blocked-for-human": those are terminal, a human must intervene first.
export async function retryStage(state: State, targetDir: string, deps: SequencerDeps): Promise<State> {
	if (state.status !== "blocked" && state.status !== "env-error") return state;
	const nextRetryCount = state.retryCount + 1;
	return attempt(
		state,
		targetDir,
		deps,
		nextRetryCount,
		`retrying (attempt ${nextRetryCount + 1}) — re-invoking from scratch, fresh context`,
	);
}

export function reset(): State {
	return initialState();
}
