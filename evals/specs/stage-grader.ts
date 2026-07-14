// StageGrader — the plugin interface for grading one pipeline stage's eval run.
//
// A stage eval (see stage-dispatch.ts) clones a frozen fixture N times and runs
// the stage skill on each clone in an independent top-level session. With no
// mid-stage answer key the N sessions are each other's reference; a per-stage
// expected set (`<fixture>.expected.*`), when one exists, adds ground truth.
//
// `stage-grade.ts` is a thin driver: it parses `<stage> --run <id>`, looks the
// stage up in the registry (stage-registry.ts), calls `grade(ctx)`, and writes
// the returned artifacts. ALL stage-specific logic lives in the grader module
// (`specs/<stage>-stage.ts`). This interface is deliberately minimal — three
// output buckets — but expressive enough for every stage's shape:
//
//   interpret  → per-session coverage/shape/ledger/claims + cross-session
//                doc-fact agreement + tier-B recall/value vs the answer-key docs
//   segment    → page→segment partition; ledger --gate segment; boundary agreement
//   link       → same-transaction clusters; member-set agreement (reuses
//                specs/sherlock.ts normalizeLinks + gradeLinks)
//   group      → category/VAT tree; group-skeleton completeness; per-bookable agreement
//   categorize → per-line account codes vs coa.csv; code agreement across sessions
//
// The three output buckets are stage-agnostic:
//   • sessionGrades — the full per-session record (→ grade-s<N>.json)
//   • summary       — the stage-specific body of summary.json (the driver wraps
//                     it in the standard schema/stage/run_id/fixture/sessions
//                     envelope), carrying `reliability`, `ground_truth`, and any
//                     cross-session agreement fields
//   • scoreboard    — the console lines, so each stage owns its terminal format

/** Parsed `run.json` written by stage-dispatch.ts (open — extra keys allowed). */
export interface StageRun {
	sessions: number;
	fixture: string;
	skill?: string;
	[k: string]: unknown;
}

/** Exit code + combined stdout/stderr of a bundled script invocation. */
export interface ScriptResult {
	code: number;
	out: string;
}

// Run a bundled ksk-keying workflow/gate script against a client dir. Builds
//   bun run --cwd <scripts> <cmd> -- <...argsBefore> <clientAbs>
// so the client dir is always the trailing arg (the scripts' convention) while
// `argsBefore` covers gate flags, e.g. script("ledger", client, ["--gate","interpret"]).
export type ScriptRunner = (cmd: string, clientAbs: string, argsBefore?: string[]) => ScriptResult;

/** Everything a grader needs about the recorded run it is grading. */
export interface StageRunContext {
	/** Stage key, e.g. "interpret" — also the fixtures/<stage>/ subdir. */
	stage: string;
	/** Run id (the run dir's basename). */
	runId: string;
	/** Absolute path to the run dir (holds run.json + s1/…/sN/ clones). */
	runDir: string;
	/** Parsed run.json. */
	run: StageRun;
	/** Absolute path to session S's client clone (runDir/s<S>/client). */
	clientDir: (session: number) => string;
	/** Run a bundled gate/workflow script against a client dir. */
	script: ScriptRunner;
}

/**
 * The full per-session grade record, written verbatim to grade-s<N>.json.
 * MUST carry `session` (1-based) and `pass` (did this session clear the stage's
 * tier-A structural bar); everything else is stage-specific tier-A detail.
 */
export interface SessionGrade {
	session: number;
	pass: boolean;
	[field: string]: unknown;
}

/**
 * The stage-specific body of summary.json. The driver prepends the standard
 * envelope { schema, stage, run_id, fixture, sessions }, then spreads this — so
 * declare the keys in the order you want them to appear after `sessions`.
 * MUST carry:
 *   • reliability   — "N/M" sessions passing tier-A (M = run.sessions)
 *   • ground_truth  — the tier-B result vs the expected set, or null when none
 *   • per_session   — the compact scoreboard view (one entry per session)
 * plus any cross-session agreement fields (e.g. interpret's value_agreement /
 * docs_compared / dropped_keys).
 */
export interface StageSummary {
	reliability: string;
	ground_truth: unknown | null;
	per_session: unknown[];
	[field: string]: unknown;
}

/** What a grader returns; the driver does the file I/O + console printing. */
export interface StageGradeResult {
	/** One per session, session 1..N in order → grade-s<N>.json. */
	sessionGrades: SessionGrade[];
	/** Body of summary.json (envelope added by the driver). */
	summary: StageSummary;
	/** Console lines, printed verbatim in order (leading "\n" allowed). */
	scoreboard: string[];
}

/** A stage grader plugin. One per pipeline stage, registered in stage-registry.ts. */
export interface StageGrader {
	/** The stage key this grader handles (must equal its registry key). */
	stage: string;
	/** Grade a recorded run. Pure w.r.t. the run dir except re-running gate scripts. */
	grade(ctx: StageRunContext): StageGradeResult;
}
