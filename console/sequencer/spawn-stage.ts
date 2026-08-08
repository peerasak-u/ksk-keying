// Real per-stage `claude -p` spawn: one bounded,
// fresh-context headless invocation of `/ksk-stage-<id>`, per the R&D
// decision that each ksk-stage-* skill becomes a standalone entry point —
// the actual fix for context bloat, since no single session accumulates all
// 6 stages anymore.
//
// StageOutcome ({status: "success" | "fail" | "cleanup-failed"}, carrying the
// failure `detail` so the operator sees the real error) is decided from the stream-json
// protocol's OWN structured result event (`is_error`) plus the process exit
// code — never by regexing the assistant's prose, which is how the removed
// console/engine.ts used to decide the same question. Whether the STAGE
// itself actually finished is a separate question, answered afterward by
// completion-check.ts's real gate/shape check against on-disk evidence —
// this function only answers "did the process complete without erroring."
//
// Real finding from the first live run against samples/clients/216 (see the
// prototype's NOTES.md in git history, commit 6782210): a bare
// `/ksk-stage-profile <dir>` prompt stopped after the
// agent-dispatch/policy-gate portion of the skill and never reached its own
// "0.5 Inventory" deterministic-script step, identically across all 3
// attempts (a fresh context has no reason to behave differently on a retry
// unless told what the previous attempt missed). The headless directive and
// retry-context appendage below exist because of that — folded directly
// into the `-p` prompt text (not `--append-system-prompt`) so this works the
// same under a subscription plan as any normal interactive prompt would.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse as yamlParse } from "yaml";
import type { StageAttemptContext, StageDef, StageOutcome, StageRunner } from "./logic";
import { DEFAULT_INTERPRET_CONCURRENCY, executeInterpretPlan, isUsageLimitText, validateUnitArtifacts, type LeafInvocation, type LeafRunResult, type UnitValidator } from "./interpret-executor";
import { createInterpretPlan, type Disposition, type Inventory, type InterpretPlan, type InterpretUnit, type SegmentsManifest } from "./interpret-plan";
import { runSupervisedProcess, type SupervisedProcessOptions, type SupervisedProcessResult } from "./process-supervisor";

const HERE = dirname(new URL(import.meta.url).pathname);
const PREPARE_SHEET_SCRIPT = resolve(HERE, "prepare-sheet.ts");
// `claude` walks UP from cwd looking for .claude/ — on a bare-host run two
// levels up from HERE lands on the repo root, which is correct. In the
// ksk-app Docker image only console/'s own contents get copied to /app, so
// the same guess lands on "/" and .claude is never found (silent no-op: the
// process "completes" having never actually run /ksk-stage-*). The real
// scripts are bind-mounted at $KSK_WORKSPACE_ROOT/.claude there — see
// docker-compose.yml's KSK_APP_SKILLS_HOST — so cwd must be
// $KSK_WORKSPACE_ROOT in that case, not "/".
const HOST_GUESS = resolve(HERE, "../..");
const REPO_ROOT =
	existsSync(resolve(HOST_GUESS, ".claude")) || !process.env.KSK_WORKSPACE_ROOT
		? HOST_GUESS
		: resolve(process.env.KSK_WORKSPACE_ROOT);

// Per CLAUDE.md's "Agent teams — model tiers": a stage's own top-level
// session here does mechanical rule-following (dispatch the skill's named
// subagents, resolve Decision Policy rules, run deterministic scripts) —
// sonnet-tier work, never the reserved opus tier. Pinned explicitly so every
// stage runs on a deliberate choice rather than whatever `claude`'s ambient
// default happens to resolve to on a given machine. (The subagents each
// stage dispatches — ksk-magnum/columbo, ksk-watson/sherlock/poirot/marple,
// ksk-lestrade — already pin their own model via their own frontmatter,
// independent of this.)
const STAGE_MODEL = "sonnet";

// The removed console/engine.ts carried a differently-scoped directive of the
// same name, about not abandoning IN-FLIGHT BACKGROUND WAVES within one long
// multi-stage session. This one addresses a failure mode specific to
// single-stage standalone invocation: a ksk-stage-* skill's instructions
// were written assuming an orchestrating parent keeps going across several
// actions in one session — a bare one-shot invocation can end its turn once
// the judgment/agent-dispatch part feels "done", never reaching that same
// skill's own later deterministic-script steps. Sent as part of the `-p`
// message itself, appended after the slash command (which must lead the
// message for Claude Code to recognize it as the skill invocation).
const HEADLESS_DIRECTIVE =
	"HEADLESS RUN (claude -p, ONE stage, no orchestrator): this process exits the moment " +
	"you end your turn, and nothing else will nudge it forward afterward — no parent " +
	"session, no follow-up turn, no human watching this attempt. You must complete EVERY " +
	"step the invoked skill instructs before ending your turn, including any deterministic " +
	"script it tells the parent to run — in this mode YOU are the parent, so do not stop " +
	"once the agent-dispatch/judgment portion feels complete if the skill lists further " +
	"steps after it (e.g. a census/inventory/build script). Never dispatch background or " +
	"async work you will not wait for — anything still in flight when your turn ends is " +
	"simply lost, not resumed. If you genuinely hit one of decision-policy.md's Stop rules, " +
	"follow its instruction to append an entry to ข้อมูลระบบ/_pages/human-stop.yaml before " +
	"ending your turn — that is a legitimate stopping point, detected from that file, never " +
	"from what you say.";

function buildPrompt(stage: StageDef, targetDir: string, context: StageAttemptContext): string {
	const command = `/ksk-stage-${stage.id} ${targetDir}`;
	const parts = [command, HEADLESS_DIRECTIVE];
	if (context.retryCount > 0) {
		parts.push(
			`This is retry ${context.retryCount} of this stage within the same run — a previous ` +
				`attempt ended without this stage's completion check passing. Previous completion-check ` +
				`output:\n${context.previousCheckOutput ?? "(none captured)"}\n\n` +
				`Read that output carefully and make sure whatever it reports missing or incomplete ` +
				`actually gets done this time before you end your turn.`,
		);
	}
	return parts.join("\n\n");
}

function parseLine(line: string): any {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

// E — root cause fixed here, not just re-thresholded: `--output-format
// stream-json --verbose` puts every event on one line, including `user`
// events that wrap a tool_result — so a stage that Reads or Writes a large
// artifact puts that artifact's ENTIRE content on one physical line. Fix D
// (256 KB -> 4 MiB) was still chasing that: it bought headroom for the two
// artifacts measured at the time (502,229 / 398,854 bytes) but line size is
// bounded by "the largest artifact a stage happens to touch", which we do
// not control and which only grows with client size — there is no threshold
// that wins for good.
//
// The actual fix: this consumer only ever needs ONE event type,
// `{"type":"result",...}`, which is small by construction. So instead of
// buffering every line hoping it might be that one, classify each line from
// a bounded PREFIX before committing to buffer it at all:
//   - if the prefix proves the line is something other than `result`, skip
//     straight to the next newline WITHOUT retaining the body and WITHOUT
//     tainting the attempt — we were never going to read it anyway, so
//     losing it costs nothing;
//   - if the prefix proves it, or fails to disprove it before running out of
//     scan budget, keep the existing (now rare) discard-and-taint behaviour,
//     because in that case we genuinely cannot rule out this being the lost
//     result event — the safety property from fix D (a lost result event can
//     never certify success) is preserved exactly, just narrowed to the
//     cases that actually need it.
//
// CLASSIFICATION RULE, stated once so every branch below can be checked
// against it: a line is the `result` event iff its OWN TOP-LEVEL `type` key
// (depth 1 — a key of the line's own outermost object, never a key belonging
// to some value nested inside it) resolves to exactly `result`, and that key
// appears within `headScanBytes` of the line's start. This deliberately does
// NOT assume `type` is the FIRST top-level key — nothing in JSON or in this
// protocol guarantees key order — only that SOME top-level key appears within
// `headScanBytes` of the line's start, which holds for every event this
// pipeline has ever produced (a handful of short id/role fields precede it,
// never a multi-KB body). It DOES, necessarily, assume the key is top-level:
// a `type` key belonging to a NESTED object (e.g. `{"meta":{"type":"text"},
// "type":"result",...}`) must never be mistaken for the line's own — see
// classifyHead's depth tracking below, added after a validator caught exactly
// this case silently misclassifying a genuine `result` event as "other". A
// line whose top-level `type` key genuinely sits behind more than the scan
// budget (or whose value is itself large enough to push it there — see
// classifyDeferBytes below for how that case is now handled) is a shape this
// pipeline has never seen; rather than guess, it falls into the same "cannot
// rule out result" branch as a truly ambiguous line.
//
// Exported for direct unit coverage of the classify/discard/skip behaviour
// above (see spawn-stage.test.ts) — not a second entry point, still only
// ever called from createSpawnStage below.
export function resultEventConsumer(
	label: string,
	onResultEvent: (evt: any) => void,
	onDiscard: () => void,
): (chunk: Uint8Array) => void {
	const decoder = new TextDecoder();
	// Everything received since the last complete (newline-terminated) line
	// was consumed — i.e. the still-growing, not-yet-classified-or-decided
	// current line.
	let buf = "";
	// Once a line has been decided NOT to be worth buffering — either because
	// its head proved it isn't a `result` event ("silent"), or because it
	// could not be classified/safely captured and must taint the attempt
	// ("tainted") — this tracks that decision until the line's own
	// terminating newline is found, so the loop below stops re-deciding on
	// every chunk and (critically) stops retaining bytes it has already
	// given up on. `null` means "still in the ordinary classify-or-parse
	// path for the current line".
	let skipMode: "silent" | "tainted" | null = null;

	// A bounded PREFIX scanned to decide a line's `type`, without ever
	// buffering the whole line just to find out. "A few tens of KB" per the
	// design ask: comfortably larger than every real event's own preamble
	// (session/message ids, roles, tool names, …) while tiny next to the
	// multi-hundred-KB-to-multi-MB bodies this fix exists to stop buffering.
	const headScanBytes = 64 * 1024;
	// Still needed even with head-scan classification: (a) a broken/malicious
	// child that never emits a newline at all must not defeat the
	// supervisor's own bounded-retention memory bound regardless of what its
	// content looks like, and (b) a *genuinely* huge `result` event (say,
	// `is_error` with a large embedded message) still has to be fully
	// assembled to be parsed — something must stop that from growing
	// forever too. Same 4 MiB value fix D measured in against (502,229 /
	// 398,854 bytes) — kept as the hard ceiling on what we'll ever hold for a
	// line we intend to actually parse.
	const maxPendingLineBytes = 4 * 1024 * 1024;
	// BLOCKER FIX: below this size, a still-incomplete line is left to keep
	// growing rather than being handed to classifyHead at all — see the "no
	// newline yet" branch below for why. 1/8 of maxPendingLineBytes (512 KiB),
	// matching a validator's own suggested fix: comfortably above every real
	// artifact measured in this pipeline so far (502,229 / 398,854 bytes), so
	// it should never actually bind on real traffic — it exists to keep the
	// two parsing paths (whole-line-in-one-chunk vs. split-across-chunks)
	// PROVABLY IDENTICAL for every size this pipeline has ever produced,
	// rather than only "probably" agreeing on realistic inputs.
	const classifyDeferBytes = maxPendingLineBytes / 8;
	// Matches a `"type":"<value>"` pair anywhere in the given text — see
	// classifyHead below for why "anywhere" is deliberately NOT what this
	// function alone decides; a raw exec() of this regex over the whole head
	// would match a NESTED `type` key (e.g. `{"meta":{"type":"text"},"type":
	// "result",...}`) before ever reaching the line's own top-level one.
	// Values in this protocol are always plain identifiers (result, system,
	// user, assistant, …) — no escaping to worry about.
	const typeKeyRe = /^"type"\s*:\s*"([a-zA-Z0-9_.-]*)"/;

	// BLOCKER FIX: classifyHead used to run a single regex `.exec()` over the
	// head and take whichever `"type":"<value>"` pair it found FIRST, which is
	// only correct if `type` is guaranteed to be the line's own top-level key
	// — the header comment above already disclaimed relying on key ORDER, but
	// said nothing about key DEPTH, and the implementation silently depended
	// on there being no nested `type` key ahead of the real one. Verified
	// against the real consumer: `{"meta":{"type":"text"},"type":"result",
	// "is_error":true,...}` classified as "other" (matching the NESTED key)
	// and silently dropped a genuine `result` event with no discard and no
	// taint — a silent regression from the pre-fix-E code, which simply
	// buffered and parsed the whole line correctly.
	//
	// Fixed by tracking JSON object depth (and string state, so braces/quotes
	// inside string VALUES don't miscount) across the head and only accepting
	// a `"type":"<value>"` match whose opening quote sits at depth 1 — i.e. a
	// key of the line's own top-level object, never a key belonging to some
	// value nested inside it. A stream-json line is always one top-level
	// object, so depth is exactly 1 from just after the opening `{` until that
	// object closes.
	function classifyHead(head: string): "result" | "other" | "unknown" {
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let i = 0; i < head.length; i++) {
			const ch = head[i];
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') {
				if (depth === 1) {
					const match = typeKeyRe.exec(head.slice(i));
					if (match) return match[1] === "result" ? "result" : "other";
				}
				inString = true;
				continue;
			}
			if (ch === "{") depth++;
			else if (ch === "}") depth--;
		}
		return "unknown";
	}

	return (chunk: Uint8Array) => {
		buf += decoder.decode(chunk, { stream: true });
		for (;;) {
			if (skipMode) {
				const idx = buf.indexOf("\n");
				if (idx === -1) {
					// Nothing here is ever going to be read — whether we're
					// skipping it silently or because it was too ambiguous to
					// trust, we still don't want to RETAIN any of it while we
					// wait for the terminating newline (that would just move
					// fix D's memory-growth problem into this branch instead of
					// solving it). Drop it every chunk; the classification
					// decision (and, for "tainted", the taint itself) already
					// happened once and does not need repeating.
					buf = "";
					return;
				}
				buf = buf.slice(idx + 1); // drop the rest of the skipped line, keep whatever follows
				skipMode = null;
				continue;
			}
			const newlineIdx = buf.indexOf("\n");
			if (newlineIdx !== -1) {
				// Fast path: a complete line arrived in one go — the overwhelming
				// common case, since most stream-json events are small. No need
				// for head-scan classification when the whole thing is already
				// in hand; parse and check `type` directly, exactly as before.
				const line = buf.slice(0, newlineIdx);
				buf = buf.slice(newlineIdx + 1);
				if (line.trim()) {
					const evt = parseLine(line);
					if (evt?.type === "result") onResultEvent(evt);
				}
				continue;
			}
			// BLOCKER FIX: a still-growing, incomplete line under classifyDeferBytes
			// is left ALONE here — no classification attempt at all — so it keeps
			// accumulating until either its newline shows up (next iteration takes
			// the fast path above, identically to a line that happened to arrive
			// whole) or it actually grows past classifyDeferBytes. Verified against
			// the real consumer: without this, the SAME bytes (a ~70 KB line whose
			// `type` key sits past the 64 KB head-scan window) took the fast path
			// and parsed cleanly when delivered in ONE chunk, but were discarded
			// and forced the whole attempt to "fail" when the identical bytes
			// arrived as TWO chunks — a retry could flip pass/fail on a byte-for-
			// byte-identical child output depending only on `reader.read()`'s
			// arbitrary chunk boundaries. Deferring classification until a line is
			// actually large enough for buffering it to matter (classifyDeferBytes,
			// 512 KiB — comfortably above every real artifact measured in this
			// pipeline, 502,229 / 398,854 bytes) makes the two delivery paths
			// PROVABLY agree for every line this pipeline has ever produced; only a
			// line that grows past 512 KiB without a newline reaches the classify-
			// or-discard logic below at all, and only THAT residual case can still
			// see chunk-boundary-dependent behaviour.
			if (buf.length <= classifyDeferBytes) return;
			// Classify it from its head — across however many chunks it took to
			// reach classifyDeferBytes; searching the cumulative `buf` (not the
			// newly-arrived chunk alone) is what makes this correct even when the
			// literal token `"type":"result"` itself straddles a chunk boundary,
			// since the full accumulated text is re-scanned each time rather than
			// each chunk in isolation.
			const head = buf.length > headScanBytes ? buf.slice(0, headScanBytes) : buf;
			const kind = classifyHead(head);
			if (kind === "other") {
				// Proven NOT a result event — we do not care about its body no
				// matter how large. Drop what we have and fast-forward to the
				// next newline without ever buffering the rest of it, and
				// without tainting the attempt: losing bytes we were never
				// going to read is not a loss of signal.
				buf = "";
				skipMode = "silent";
				continue;
			}
			if (kind === "result") {
				// This line IS (or claims to be) the one event this consumer
				// exists to read. Keep accumulating it in full so it can be
				// parsed once complete — bounded by maxPendingLineBytes so a
				// pathological "result" line still can't grow forever.
				if (buf.length > maxPendingLineBytes) {
					console.error(
						`${label}: a "result"-typed stream-json line exceeded the ${maxPendingLineBytes}-byte ` +
							`parser limit (${buf.length} bytes buffered with no newline) before it could be ` +
							"assembled — discarding it and the rest of the same line; this attempt's result " +
							"signal can no longer be trusted",
					);
					onDiscard();
					buf = "";
					skipMode = "tainted";
					continue;
				}
				return; // wait for more chunks to complete this line
			}
			// kind === "unknown": no top-level `type` key found anywhere in the
			// scanned head. By construction we only reach classifyHead at all once
			// buf.length > classifyDeferBytes (512 KiB, itself > headScanBytes,
			// 64 KiB — see the check above) — so the head has always already
			// scanned its full headScanBytes budget by this point, and there is no
			// "keep waiting for more of the head" sub-case left to distinguish: a
			// still-unknown classification here always means the full scan budget
			// was searched and found nothing, a shape this pipeline has never
			// produced. Per the classification rule above we cannot safely assume
			// that means "not result", so — exactly like the oversized-and-
			// already-classified-as-result case — we discard and taint rather than
			// guess.
			console.error(
				`${label}: stream-json line's head exceeded the ${headScanBytes}-byte classification scan ` +
					`with no "type" key found (${buf.length} bytes buffered) — cannot rule out this being the ` +
					'"result" event, discarding it and the rest of the same line; this attempt\'s result ' +
					"signal can no longer be trusted",
			);
			onDiscard();
			buf = "";
			skipMode = "tainted";
		}
	};
}

function envDuration(name: string): number | undefined {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

// D — OPERATOR POLICY DECISION, not a measurement and not a fit: no single
// supervised process spawned by this file may EVER be granted a wall longer
// than 2 hours, full stop. Every CEILING constant below must be <= this value
// (enforced at module load — see the guard right after the last ceiling is
// declared).
//
// Reasoning: this runs on a 4-core Raspberry Pi with no swap headroom, and up
// to KSK_INTERPRET_CONCURRENCY (default 4) of these processes can be alive at
// once. A process that genuinely needs more than 2 hours of wall time is a
// WORK-DECOMPOSITION problem (the unit of work handed to one supervised call
// is too big), not a deadline problem — raising the ceiling further papers
// over that rather than fixing it.
//
// Honest consequence, accepted rather than hidden: client 336's WORST SINGLE
// MONTH's stage-spawn weighted budget (see STAGE_SPAWN_TIMEOUT_CEILING_MS
// below — a stage spawn targets one client-MONTH run root, never the whole
// client folder) computes to ~6.3h at the current per-page rate — this policy
// CLAMPS that month's stage-spawn wall down to 2h regardless. That clamp is
// deliberately accepted here, not an oversight; it is only safe to accept
// because prepare-pages (that same month's ~1.15h of genuine render work) is
// separately being chunked so no single invocation of it can approach 2h
// either — the ceiling and the chunking are a paired fix, not this constant
// alone.
//
// `KSK_STAGE_TIMEOUT_MS` remains the operator's escape hatch for a one-off
// run that genuinely needs to exceed this policy — it overrides the computed
// wall entirely (see deadlines() below), this constant only bounds the
// UNOVERRIDDEN, computed default.
export const MAX_SUPERVISED_WALL_MS = 2 * 60 * 60 * 1_000;

// Per-site deadline fallbacks used whenever KSK_STAGE_TIMEOUT_MS /
// KSK_STAGE_IDLE_TIMEOUT_MS are unset (same shared override knob as
// runScript() above — an operator can still raise every one of them at once
// in an emergency). Before this, all four leaf/stage spawns below fell
// straight through to process-supervisor.ts's bare module default (60 min
// wall / 5 min idle) — the exact gap the incident this file's header
// describes exploited. Sized for a 4-core Raspberry Pi with no swap
// headroom: a stuck leaf must die in minutes, and up to
// KSK_INTERPRET_CONCURRENCY (default 4) of these can run at once, so a
// generous default here is also a memory-pressure risk, not just a CPU one.
//
// Idle timeouts remain a secondary defense only — a chatty-but-stuck
// `--output-format stream-json` process resets its idle timer on every
// event, so the WALL clock (timeoutMs) is what actually bounds it; every
// value below is chosen to be a real bound on its own, not to rely on idle
// detection catching what wall-clock coverage already handles.
export const AUDIT_LEAF_TIMEOUT_MS = 8 * 60 * 1_000;
export const AUDIT_LEAF_IDLE_TIMEOUT_MS = 3 * 60 * 1_000;
// The main interpret leaf (watson/marple) and the audit-repair leaf invoke
// the identical per-unit worker command/args (see runLeaf in
// executeInterpretPlan) — same weight class, same fallback. Both call sites
// deliberately share INTERPRET_LEAF_IDLE_TIMEOUT_MS below, NOT the separate,
// tighter AUDIT_LEAF_IDLE_TIMEOUT_MS above: that constant belongs to a
// different, smaller job — the bounded ksk-lestrade exclusion-audit call in
// auditUnit() (one short, fixed-shape prompt, no per-unit page weight) — and
// is unaffected by this change. The audit-repair leaf is a full interpret
// leaf re-run, same weight class as the main leaf, so it gets the same
// weighted wall and the same backstop idle, not the audit leaf's tighter one.
//
// D1 — this used to be one flat wall (15 min) for every unit. Two incidents
// (see this file's header) proved a flat wall is simply wrong here: client
// 216's seg-001 (13 pages, one unit) was killed twice at 15 min while the
// median 1-page unit finishes in ~40s — INTERPRET_PAGE_CAP (15 pages/unit,
// interpret-plan.ts) legally permits a unit the flat wall cannot cover even
// once.
//
// D2 — idle is NO LONGER a liveness check for an interpret leaf; it is a
// coarse backstop only, and this is a deliberate demotion, not an oversight.
// From outside the process there is no usable liveness signal that
// distinguishes "waiting on a slow model call" from "hung": partial-message
// streaming only covers token generation, not time-to-first-token; the
// on-disk session transcript has the same granularity as the stream-json
// events already read here; CPU time sits at ~0 in both cases. Measured
// proof this matters: client 216's seg-001, run with IDENTICAL inputs and
// the identical 5-minute idle setting twice — attempt 1 was killed by idle at
// exactly 300s of silence (process-supervisor log: `interpret-leaf:seg-001
// idle-timeout ... sinceOutputMs=300004`); attempt 2 produced no such gap and
// completed in ~1531s. Same unit, same settings, opposite outcome — the long
// silence is INTERMITTENT, not a property of large units, so a short idle
// timer cannot tell "slow" from "stuck" and was killing live work. The real
// bound is now the WEIGHTED WALL (computeInterpretLeafTimeoutMs below) — this
// is what the block header above already claims the design is; this constant
// is what makes the behaviour finally match that claim, rather than removing
// a protection. 20 minutes is itself a GUESS — about how long a genuinely
// dead (zero-byte-forever) process should be allowed to sit before the
// backstop reaps it. HONESTY: the only measured silence in the evidence is
// the 300s (5-minute) gap that attempt 1's idle timer itself killed — that is
// a LOWER BOUND on how long a live leaf can go quiet, not an upper one, since
// the kill happened at exactly that instant. Attempt 2 ran to completion under
// the identical 5-minute idle setting, so every gap IT had is only known to be
// <5 min — there is no measured data point anywhere above 300s. 20 minutes is
// therefore a ~4x pad over the one observed lower bound, chosen with no
// evidence of what the true ceiling on a live silence is. The first stage-spawn
// or leaf run that survives a silence longer than 5 min should have its actual
// max gap logged so this guess can eventually be replaced with a real fit.
export const INTERPRET_LEAF_IDLE_TIMEOUT_MS = 20 * 60 * 1_000;
// Floor: a 1-page unit needs headroom above the measured ~40s median (model
// start-up + tool round trips vary run to run), but D1 still asks for a
// "short leash" so a genuinely hung common-case unit is caught in minutes,
// not tens of minutes — 5 min is ~7.5x the measured median, generous without
// being long.
export const INTERPRET_LEAF_FLOOR_MS = 5 * 60 * 1_000;
// REFITTED (client 216, 2026-07-27): the large-unit data point this comment
// used to wait on has now been observed. seg-001 (13 pages), run a second
// time under the same 5-minute idle setting as attempt 1 — the long silence
// simply did not recur that time (see the D2 comment above; this is NOT
// evidence the new 20-minute backstop was in effect, it was not) — completed
// in ~1531s
// (~25.5 min) — under this budget's 44-minute allowance (floor 5 min +
// 3 min/page * 13). The two real data points are now (1 page, ~40s) and
// (13 pages, 1531s completed, not a lower bound). A straight line through
// them gives (1531-40)/12 ≈ 124 s/page (~2.1 min/page) — the fit itself has
// moved, but the constant below has NOT: at 3 min/page it produced a 44-min
// budget against a 25.5-min actual, a ~1.7x margin, which is healthy and
// deliberately kept rather than tightened. This value has now been reviewed
// against real data, not left un-rechecked. The earlier note that scaling
// "looks super-linear" is NEITHER confirmed NOR refuted by this one point —
// two data points can only fit a straight line, and a 2-point fit cannot
// distinguish linear from super-linear; a third, larger real unit is needed
// before that claim can be settled either way. Re-fit this again (and
// re-examine the super-linear question) once such a unit is observed.
export const INTERPRET_LEAF_PER_PAGE_MS = 3 * 60 * 1_000;
// Ceiling: interpret-plan.ts's INTERPRET_PAGE_CAP bounds a legal unit at 15
// pages+sheets, so floor + perPage*15 (50 min) is the worst legal budget this
// formula should ever produce; 90 min is a sanity backstop in case that
// invariant is ever violated or a unit's weight is computed wrong — it is a
// guess sized to sit comfortably above the legal-cap case, not a measurement,
// and per D3 exists so this fix cannot regress into an unbounded wait.
//
// This is a SITE-SPECIFIC ceiling tighter than the global MAX_SUPERVISED_WALL_MS
// policy (2h) above — that is fine and deliberate (an interpret leaf never
// legally needs anywhere near 2h). It must never be RAISED past
// MAX_SUPERVISED_WALL_MS, though: wrapped in Math.min against it so a future
// edit that bumps 90 min upward cannot silently cross the 2h policy without
// the module-load guard (below the other two ceilings) catching it.
export const INTERPRET_LEAF_TIMEOUT_CEILING_MS = Math.min(90 * 60 * 1_000, MAX_SUPERVISED_WALL_MS);

/**
 * D1 weighted wall-clock budget for one interpret leaf (main leaf or
 * audit-repair leaf — see call sites below), sized by the unit's own work
 * (pages + sheets) rather than one flat constant for every unit regardless
 * of size. See the constants above for the evidence behind floor/per-page/
 * ceiling.
 */
export function computeInterpretLeafTimeoutMs(unit: Pick<InterpretUnit, "pages" | "sheets">): number {
	const weight = unit.pages.length + unit.sheets.length;
	const budget = INTERPRET_LEAF_FLOOR_MS + INTERPRET_LEAF_PER_PAGE_MS * weight;
	return clampWeightedBudgetMs(budget, INTERPRET_LEAF_FLOOR_MS, INTERPRET_LEAF_TIMEOUT_CEILING_MS);
}

// D2 — shared clamp for every weighted-budget helper in this file
// (computeInterpretLeafTimeoutMs, computeScriptRunTimeoutMs,
// computeStageSpawnTimeoutMs). `budget` is always >= floorMs by construction
// at every call site (floorMs + perPageMs * weight, weight >= 0), so the
// previous `Math.min(Math.max(budget, floorMs), ceilingMs)` form's inner
// Math.max was dead code — and worse, that shape is not TOTAL: if ceilingMs
// were ever misconfigured below floorMs (a bug — nobody sets this
// deliberately, but nothing stopped it), Math.max(budget, floorMs) still
// evaluates to something >= floorMs > ceilingMs, so the outer Math.min would
// return ceilingMs — a wall SHORTER than the function's own floor fallback,
// silently. Guard against that directly: widen an inverted ceiling back up
// to the floor before clamping, so the result can never fall below floorMs
// no matter how the floor/ceiling pair is configured.
// `logContext`, when given, makes an actual clamp OBSERVABLE at the moment it
// happens rather than only reconstructible after the fact from constants: a
// large client's stage-spawn or runScript() wall gets silently clamped to the
// 2h policy ceiling today, and a kill at exactly that elapsedMs then looks
// identical in the logs to a genuine hang (the same shape of incident this
// whole file exists to fix — see STAGE_SPAWN_TIMEOUT_CEILING_MS's comment).
// Every call site that can name what it's computing a budget FOR (a client
// directory, a chunk size) should pass one; computeInterpretLeafTimeoutMs
// deliberately does not, since its ceiling (90 min, itself well under the
// legal 15-page/unit cap's 50-min worst case) should essentially never bind
// in practice and a clamp there would indicate a different kind of bug
// (an out-of-range unit weight), not an expected large-client policy trade-off.
// Exported for direct unit coverage of the inverted-floor/ceiling guard (see
// spawn-stage.test.ts's D2 describe block) — a test calling only the public
// compute*TimeoutMs wrappers can never actually supply an inverted pair,
// since every real call site's own floor/ceiling constants are correctly
// ordered by construction; only a test that reaches this function directly
// can exercise the branch it exists to fix.
export function clampWeightedBudgetMs(budgetMs: number, floorMs: number, ceilingMs: number, logContext?: string): number {
	const safeCeilingMs = Math.max(ceilingMs, floorMs);
	const clamped = Math.min(budgetMs, safeCeilingMs);
	if (logContext && budgetMs > safeCeilingMs) {
		console.error(
			`${logContext}: computed wall budget ${budgetMs}ms exceeds the ${safeCeilingMs}ms policy ceiling — ` +
				`clamping to ${safeCeilingMs}ms (see MAX_SUPERVISED_WALL_MS's comment); a kill at exactly this ` +
				"elapsedMs is POLICY, not a hang",
		);
	}
	return clamped;
}
// The top-level per-stage spawn (profile/segment/link/group/categorize): a
// whole `/ksk-stage-<id>` skill invocation, potentially dispatching its own
// subagent wave — heavier than a single leaf, so given the same order of
// magnitude as runScript()'s existing 30 min fallback above rather than the
// leaf-scale budget.
//
// D1 — client 216/April's group stage (Stage 4: doc-group skeleton + its own
// ksk-marple subagent wave over 96 ledger units / 38 source files / largest
// segment 47 pages) was killed by this exact flat wall while still emitting
// output 10.6s before death (process-supervisor log:
// `stage-spawn:group timeout pid=729 elapsedMs=1800010 sinceOutputMs=10604`).
// It was NOT hung — 30 min is a LOWER BOUND on what that stage genuinely
// needed, not a measurement of what it needed. This is the same D1 flat-wall
// defect already fixed for interpret leaves and for runScript(); the stage
// spawn was the one site missed. Kept as the FLOOR and as the fallback for a
// client whose size can't be determined yet (see computeStageSpawnTimeoutMs)
// so small clients and the earliest stages behave exactly as before.
export const STAGE_SPAWN_TIMEOUT_MS = 30 * 60 * 1_000;
// D2, applied here too: this call site runs the identical `claude -p
// --output-format stream-json` binary as the interpret leaf above, so the
// same argument applies — from outside the process there is no way to tell
// "waiting on a slow model call" from "hung", and the leaf measurement
// (INTERPRET_LEAF_IDLE_TIMEOUT_MS's comment) proves that binary can go quiet
// for at least 300s while still doing live work. A stage spawn additionally
// dispatches its own subagent wave (e.g. ksk-marple batches, per
// SKILL.md's "one batch of <=20 populate groups"), which plausibly has its
// OWN silent gaps while a batch is in flight, with no parent-level stdout
// event to reset the clock. HONESTY: the only stage-spawn data point on hand
// is `stage-spawn:group ... sinceOutputMs=10604` from the incident that
// motivated this file's D1 fix — that sample was taken AT a wall-clock kill,
// so it says the stage was chatty at that one instant, not that it never has
// a longer gap; no distribution of stage-spawn output gaps has been measured.
// Raised to the SAME 20-minute backstop as the leaf (rather than a separately
// guessed number) purely because there is no stage-spawn-specific evidence to
// size it any differently — re-fit this the moment a stage spawn's actual max
// silence is ever logged.
export const STAGE_SPAWN_IDLE_TIMEOUT_MS = 20 * 60 * 1_000;
// HONESTY: the only real evidence is "96 units / 38 files needed MORE than
// 1800000ms" — a lower bound on duration, not a duration. Client 216's
// inventory.yaml total page count was not recorded alongside that incident,
// so unlike SCRIPT_RUN_PER_PAGE_MS (which has two independent per-page
// timings agreeing on ~4.0 s/page) there is NO per-page fit possible here —
// none of the fit's inputs exist. This rate is therefore a bare, deliberately
// padded GUESS, not a measurement dressed up as one.
//
// It is picked smaller than INTERPRET_LEAF_PER_PAGE_MS (3 min/page) on
// purpose: that rate prices ONE model call over one leaf's own pages, while a
// stage-spawn's per-page cost here is amortized across the whole client's
// pages and the marple wave's own internal batching (SKILL.md: "one batch of
// ≤20 populate groups sharing a source interpretation") — many pages' worth
// of judgment can land in one subagent call, not one call per page. It is
// picked larger than SCRIPT_RUN_PER_PAGE_MS (6s/page), which prices a
// deterministic pdftoppm render with no model call at all. 20s/page sits
// between those two known rates by construction, not by any timing of a
// group stage itself.
//
// Re-fit this the moment ANY group stage (or any other stage spawn this
// formula covers) is observed running to completion under this budget:
// record that client's total inventory.yaml page count alongside the actual
// wall time, and replace this guess with a real fit — exactly as
// INTERPRET_LEAF_PER_PAGE_MS is waiting on its own first completed large
// unit.
export const STAGE_SPAWN_PER_PAGE_MS = 20 * 1_000;
// Ceiling: OPERATOR POLICY (see MAX_SUPERVISED_WALL_MS above), not a fit and
// not "comfortably above the largest real client's weighted budget" the way
// this comment used to argue. It IS below that budget, on purpose, and that
// tradeoff is knowingly accepted, not hidden:
//
// The actual arithmetic, restated at the scope a stage spawn actually runs at
// (one client-MONTH run root, never the whole multi-month client folder — see
// the REFITTED note below): MEASURED (samples/clients/336, 2026-07-27, via
// `pdfinfo` over every source PDF, per month) — 03-69/04-69/05-69 hold
// 920/1,039/840 PDF pages respectively (1,056 PDFs total across all three,
// largest single PDF 218 pages), plus 320 ready .jpg/.jpeg and 30 .xlsx files
// costed at 1 page each by prepare.ts (100/11, 105/9, 115/9 per month). Worst
// single month (04-69, 1,039 PDF pages + ~9 ready ≈ 1,048 inventory pages) has
// a weighted stage-spawn budget of 30 min floor + 1,048 * 20s/page = 30 + 349
// = 379 min (~6.3h). This 2-hour ceiling clamps that month's stage-spawn wall
// down to 2h regardless — a flat, size-blind wall for that one run, which is
// exactly the shape of defect this file used to argue against widening the
// ceiling to avoid. Under the current policy the operator has explicitly
// ACCEPTED that clamp for stage-spawn: a process needing >2h is treated as a
// work-decomposition problem, not solved by a longer deadline. (An EARLIER
// version of this constant was 24h, sized specifically to clear the
// then-stated 16.05h whole-client-folder figure without clamping it — that
// approach was rejected by the operator as unsafe on this hardware, AND that
// 16.05h figure was itself wrong-scope, see below; do not revert to 24h.)
//
// REFITTED (2026-07-27): an earlier version of this comment, and of
// PREPARE_PAGES_CHUNK_PAGES's fix-F comment below, stated "336 = 2,799
// inventory pages" and derived 16.05h/5.17h/~3.1h figures from it. That
// pdfinfo count is honest for the PDF-page total of client 336's WHOLE
// three-month folder (samples/clients/336/{03-69,04-69,05-69}), but
// runInterpretStage/runPreparePagesChunked/a stage spawn are always handed one
// MONTH run root, never the client root — so a real invocation faces at most
// ~1,048 inventory pages (04-69, the worst month), not 2,799. The error
// direction was conservative (over-stated work, so nothing was operationally
// unsafe), but a future re-fit of PREPARE_PAGES_CHUNK_PAGES or this ceiling
// against "336 = 2,799 pages per run" would be reasoning off a ~2.7x-inflated
// premise. This comment and PREPARE_PAGES_CHUNK_PAGES's below are corrected to
// the per-month scope the code actually runs at; the 2h ceiling stands either
// way (~6.3h and ~1.15h are both still meaningfully >2h and ≤2h respectively,
// the same policy conclusion as before).
//
// STAGE_SPAWN_TIMEOUT_CEILING_MS is currently the one call site fix F's
// prepare-pages chunking does NOT compensate: a `/ksk-stage-*` spawn is a
// single `claude -p` process with its own subagent wave and no decomposition
// available yet. A client whose worst month's honest stage-spawn budget
// exceeds 2h (04-69 above already does, at ~6.3h) is silently clamped with no
// in-band signal beyond the console.error clampWeightedBudgetMs now emits when
// a computed budget exceeds this ceiling (see clampWeightedBudgetMs's
// comment) — decomposition work for stage-spawn itself is still owed, this
// round only makes the clamp observable rather than closing it.
//
// KSK_STAGE_TIMEOUT_MS remains the operator's per-run override for a client
// that genuinely needs longer than this policy allows.
export const STAGE_SPAWN_TIMEOUT_CEILING_MS = MAX_SUPERVISED_WALL_MS;
// runScript(): a bundled Bun script (ledger, prelink, prepare-pages, …). Same
// weight class as a whole stage invocation, and historically the site the
// shared KSK_STAGE_* knob was named after.
//
// D1 — this used to be one flat wall regardless of client size (client 345 is
// 253 inventory pages, client 336's worst single month is ~1,048; a flat
// 30-minute wall is sized for neither — see the REFITTED note on
// STAGE_SPAWN_TIMEOUT_CEILING_MS above for why "336" means one month run
// root, not the whole client folder, everywhere in this file). It is also
// both the FLOOR of the weighted budget below and the fallback used whenever
// the client's inventory can't be read yet — see computeScriptRunTimeoutMs.
export const SCRIPT_RUN_TIMEOUT_MS = 30 * 60 * 1_000;
export const SCRIPT_RUN_IDLE_TIMEOUT_MS = 5 * 60 * 1_000;
// Per-page weight. prepare-pages (the runScript() call site this matters most
// for) is a pdftoppm render per Inventory page. TWO INDEPENDENT MEASUREMENTS
// OF THE SAME CLIENT AGREE ON ~4.0 s/page at 300 DPI: (a) client 345's
// incident — its prepare-pages had written 75 pages by the moment the 5-minute
// idle timer killed it while still rendering, so ≤ 5*60/75 = 4.0 s/page; and
// (b) the same client's full prepare-pages run took ~17 min for 253 inventory
// pages = 4.03 s/page. So 4 s/page is a real rate for client 345's document
// mix, not a hand-wave.
//
// The constant is nonetheless set at 6 s/page = that measurement x1.5, ON
// PURPOSE. Per D1 this number sizes a BUDGET, not an expectation: it must not
// bind on a healthy client whose scans are simply heavier than the one client
// we have timed. The 1.5 factor is a chosen safety margin, NOT a measurement —
// re-fit it (downwards, ideally) once a second client of a different document
// mix has been timed end to end.
export const SCRIPT_RUN_PER_PAGE_MS = 6_000;
// Ceiling: OPERATOR POLICY (see MAX_SUPERVISED_WALL_MS above), not a fit.
// This USED to be sized to clear every real client's honest weighted budget
// (8 hours, chosen to clear 336's runScript()-side budget without clamping
// it, back when "336" was mistakenly read as its whole 3-month, 2,799-page
// folder rather than one ~1,048-page month run root — see the REFITTED note
// on STAGE_SPAWN_TIMEOUT_CEILING_MS above) — that approach is no longer the
// policy either way. At the per-page rate above, 336's worst single month
// (04-69, ~1,048 inventory pages) has a weighted runScript() budget of 30 min
// + 1,048 * 6s = 30 + 105 = 135 min (~2.25h); this 2-hour ceiling DOES clamp
// that just below its honest budget, and that is accepted, not hidden. The
// compensating fix is prepare-pages (that same month's ~1.15h of genuine
// render work at the real 4.0 s/page rate, the actual driver of the 2.25h
// budgeted figure) being chunked so no single invocation of it needs anywhere
// near 2h — see fix F. `KSK_STAGE_TIMEOUT_MS` remains the operator's per-run
// override for a one-off client that still needs longer.
export const SCRIPT_RUN_TIMEOUT_CEILING_MS = MAX_SUPERVISED_WALL_MS;

// D1 durable guard: every declared ceiling above must obey the 2-hour policy.
// Checked once at module load (not merely in a test) so any future edit that
// raises a ceiling past MAX_SUPERVISED_WALL_MS fails loudly the moment this
// module is imported by anything — the console server, a script, or a test —
// rather than silently drifting the policy apart from the code.
const DECLARED_CEILINGS_MS: Record<string, number> = {
	INTERPRET_LEAF_TIMEOUT_CEILING_MS,
	STAGE_SPAWN_TIMEOUT_CEILING_MS,
	SCRIPT_RUN_TIMEOUT_CEILING_MS,
};
for (const [name, ms] of Object.entries(DECLARED_CEILINGS_MS)) {
	if (ms > MAX_SUPERVISED_WALL_MS) {
		throw new Error(
			`policy violation: ${name} (${ms}ms) exceeds MAX_SUPERVISED_WALL_MS ` +
				`(${MAX_SUPERVISED_WALL_MS}ms) — see this file's MAX_SUPERVISED_WALL_MS comment; ` +
				"no supervised wall may exceed the operator's 2-hour policy.",
		);
	}
}

/**
 * D1 weighted wall-clock budget for one runScript() invocation, sized by the
 * client's total Inventory page count rather than one flat constant for
 * every client regardless of size.
 *
 * THE CEILING IS NON-NEGOTIABLE: a corrupt, absent, or hostile inventory.yaml
 * must never mint an unbounded deadline. Both "file does not exist yet"
 * (Stage 2 runs this before some inventories exist) and "file exists but
 * fails to parse" fall back to the flat SCRIPT_RUN_TIMEOUT_MS — never to "no
 * limit" and never to a thrown error.
 */
// Shared "how big is this client, right now" probe: both computeScriptRunTimeoutMs
// and computeStageSpawnTimeoutMs weight their budget off the SAME total
// Inventory page count, read the SAME way — one client is one size, and a
// second, differently-behaved reader here would just be a second place for
// that number to drift from reality. Returns null (never throws) whenever
// the size can't be determined yet: inventory.yaml absent (true early in a
// run — Stage 2 runs this before some inventories exist) or unparseable.
// Callers fall back to their own flat constant in that case, never to "no
// limit".
function readInventoryTotalPages(targetDir: string): number | null {
	let inventory: Inventory | null;
	try {
		inventory = parseYamlFile<Inventory>(join(targetDir, "ข้อมูลระบบ", "_pages", "inventory.yaml"), false);
	} catch {
		inventory = null; // corrupt inventory.yaml: fall back below, never crash and never mint an unbounded deadline.
	}
	if (!inventory || !Array.isArray(inventory.files)) return null;
	let totalPages = 0;
	for (const file of inventory.files) {
		if (file && typeof file.page_count === "number" && Number.isFinite(file.page_count) && file.page_count > 0) totalPages += file.page_count;
	}
	return totalPages;
}

// Extracted so fix F's per-chunk prepare-pages deadline (a page count we
// already know, not one read from targetDir's inventory.yaml) can reuse the
// exact same floor/per-page-rate/ceiling formula as the whole-client budget
// below, rather than a second, drift-prone copy of the arithmetic.
export function computeScriptRunTimeoutMsForPages(pageCount: number, logContext?: string): number {
	const budget = SCRIPT_RUN_TIMEOUT_MS + SCRIPT_RUN_PER_PAGE_MS * pageCount;
	return clampWeightedBudgetMs(budget, SCRIPT_RUN_TIMEOUT_MS, SCRIPT_RUN_TIMEOUT_CEILING_MS, logContext);
}

export function computeScriptRunTimeoutMs(targetDir: string): number {
	const totalPages = readInventoryTotalPages(targetDir);
	if (totalPages === null) return SCRIPT_RUN_TIMEOUT_MS;
	return computeScriptRunTimeoutMsForPages(totalPages, `computeScriptRunTimeoutMs(${basename(targetDir)}, ${totalPages}pp)`);
}

/**
 * D1 weighted wall-clock budget for one top-level stage spawn (profile/
 * segment/link/group/categorize). See the constants above for the honesty
 * caveat: the per-page rate here is a deliberately padded GUESS, not a fit —
 * client 216's incident proves only a lower bound, and its total inventory
 * page count was never recorded.
 *
 * Weight basis: total Inventory pages (readInventoryTotalPages, the same
 * reader computeScriptRunTimeoutMs uses), NOT ledger units/segments — chosen
 * because inventory.yaml is written by Stage 0 (profile) itself and so is
 * readable at every LATER stage-spawn call site (segment, link, group,
 * categorize), whereas the segment manifest / ledger units this incident is
 * actually described in terms of (96 units) don't exist until AFTER the
 * segment stage runs — that basis would still be blind for segment's own
 * spawn, one stage later than inventory pages are blind for. Neither basis
 * is available at profile's OWN spawn (it is the stage that produces
 * inventory.yaml in the first place) — that case, like an unreadable
 * inventory anywhere else, falls back to the flat STAGE_SPAWN_TIMEOUT_MS
 * floor, exactly as before this fix.
 */
export function computeStageSpawnTimeoutMs(targetDir: string): number {
	const totalPages = readInventoryTotalPages(targetDir);
	if (totalPages === null) return STAGE_SPAWN_TIMEOUT_MS;
	const budget = STAGE_SPAWN_TIMEOUT_MS + STAGE_SPAWN_PER_PAGE_MS * totalPages;
	return clampWeightedBudgetMs(
		budget,
		STAGE_SPAWN_TIMEOUT_MS,
		STAGE_SPAWN_TIMEOUT_CEILING_MS,
		`computeStageSpawnTimeoutMs(${basename(targetDir)}, ${totalPages}pp)`,
	);
}
// Spreadsheet materialization is a small deterministic conversion, not a
// model call — it gets its own, much tighter knob.
export const SHEET_PREPARE_TIMEOUT_MS = 5 * 60 * 1_000;
export const SHEET_PREPARE_IDLE_TIMEOUT_MS = 60 * 1_000;

/**
 * Deadline knobs for one supervised call site. The site's own fallback applies
 * unless an operator overrides it; `envPrefix` selects which override knob,
 * since spreadsheet preparation is deliberately tuned separately from the
 * model-call sites that share KSK_STAGE_*. Assembling these by hand at each
 * call site let the values drift apart — a missed fallback is what left one
 * leaf inheriting the bare 60-minute module default.
 */
function deadlines(
	timeoutMs: number,
	idleTimeoutMs: number,
	envPrefix: "KSK_STAGE" | "KSK_SHEET_PREPARE" = "KSK_STAGE",
): Pick<SupervisedProcessOptions, "timeoutMs" | "idleTimeoutMs" | "maxOutputBytes"> {
	return {
		timeoutMs: envDuration(`${envPrefix}_TIMEOUT_MS`) ?? timeoutMs,
		idleTimeoutMs: envDuration(`${envPrefix}_IDLE_TIMEOUT_MS`) ?? idleTimeoutMs,
		maxOutputBytes: envDuration("KSK_PROCESS_MAX_OUTPUT_BYTES"),
	};
}

type SupervisedRunner = (options: SupervisedProcessOptions) => Promise<SupervisedProcessResult>;

class CleanupFailure extends Error {}

export type SpawnStageDeps = {
	repoRoot: string;
	runSupervised: SupervisedRunner;
};

function scriptsDir(repoRoot: string) {
	return join(repoRoot, ".claude", "skills", "ksk-keying", "scripts");
}

function parseYamlFile<T>(path: string, required: boolean): T | null {
	if (!existsSync(path)) {
		if (required) throw new Error(`required Stage-2 input is missing: ${path}`);
		return null;
	}
	try {
		return yamlParse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		throw new Error(`failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function loadInterpretPlan(targetDir: string): InterpretPlan {
	const manifest = parseYamlFile<SegmentsManifest>(join(targetDir, "ข้อมูลระบบ", "_segments", "manifest.yaml"), true)!;
	const inventory = parseYamlFile<Inventory>(join(targetDir, "ข้อมูลระบบ", "_pages", "inventory.yaml"), true)!;
	const dispositions = parseYamlFile<{ entries?: Disposition[] }>(join(targetDir, "ข้อมูลระบบ", "_pages", "dispositions.yaml"), false) ?? {};
	return createInterpretPlan({ runRoot: targetDir, manifest, inventory, dispositions });
}

function processOutput(result: SupervisedProcessResult) {
	return `${result.stdout}${result.stderr}`.trim();
}

function successful(result: SupervisedProcessResult) {
	return result.reason === "exited" && result.exitCode === 0 && result.cleanupComplete;
}

function hasErrorResult(output: string) {
	for (const line of output.split(/\r?\n/)) {
		const event = parseLine(line);
		if (event?.type === "result" && event.is_error) return true;
	}
	return false;
}

// BLOCKER FIX: every interpret-leaf / audit-repair-leaf / exclusion-audit call
// site used to derive is_error and usage-limit classification by calling
// hasErrorResult()/isUsageLimitText() on processOutput(result) — the joined
// stdout+stderr TEXT the supervisor retained. But process-supervisor.ts's
// captureStream keeps only the HEAD of each stream up to maxOutputBytes
// (default 1,000,000) and the stream-json `result` event is always the LAST
// line of a leaf's transcript: interpret leaves run for many minutes (seg-001
// attempt 2: ~1531s) with stdout far past 1 MB, and single stream-json lines
// of 502,229 / 398,854 bytes are already measured in this pipeline. So
// hasErrorResult(processOutput(result)) essentially never sees the actual
// result event on a real leaf — a leaf that exits 0 while reporting
// `is_error: true` was silently accepted as success, and isUsageLimitText
// never saw text that arrived after the 1 MB cut.
//
// Fixed the same way fix E fixed the stage-spawn path: attach a
// resultEventConsumer to the leaf's OWN stdout so the result event is
// captured INCREMENTALLY as bytes arrive — a bound entirely independent of
// process-supervisor's separate, head-retained processOutput() buffer.
// Exported for direct unit coverage (see spawn-stage.test.ts) — not a second
// entry point, still only ever called from the three leaf call sites above.
export function captureLeafResult(label: string) {
	let event: any = null;
	let discarded = false;
	const onStdoutChunk = resultEventConsumer(
		label,
		(evt) => {
			event = evt;
		},
		() => {
			discarded = true;
		},
	);
	return {
		onStdoutChunk,
		// `event` is the parsed `result` event iff one was captured intact.
		// `discarded` mirrors the stage-spawn path's `discardedLine` — a line
		// that could not be safely classified/captured, so whatever signal it
		// carried (possibly the result event itself) is lost and must not be
		// read either way.
		get: () => ({ event, discarded }),
	};
}

/**
 * Classifies one leaf run's is_error / usage-limit status from its CAPTURED
 * result event (see captureLeafResult) rather than from processOutput(result)
 * text — see captureLeafResult's comment for why that text essentially never
 * contains a leaf's own result event. Falls back to the old prose/line scan
 * over processOutput ONLY when no result event was captured and nothing was
 * discarded either (the leaf's own stdout genuinely never carried one — e.g.
 * it crashed before finishing a turn); that shape predates this fix and is
 * unaffected by it.
 *
 * `signalLost` is true whenever a stdout line was discarded, or the stream
 * was truncated without ever yielding a captured event — i.e. the case a
 * validator's finding named directly: `result.stdoutTruncated === true` must
 * be treated as "the error signal was not observable", never as "no error".
 * Callers treat `signalLost` as `isError` (fail-safe), never as success.
 */
export function classifyLeafResult(result: SupervisedProcessResult, capture: { event: any; discarded: boolean }) {
	const output = processOutput(result);
	if (capture.event) {
		return {
			isError: Boolean(capture.event.is_error),
			isUsageLimit: isUsageLimitText(output) || isUsageLimitText(JSON.stringify(capture.event)),
			signalLost: false,
		};
	}
	const signalLost = capture.discarded || result.stdoutTruncated;
	if (signalLost) {
		console.error(
			`leaf result signal lost (discarded=${capture.discarded}, stdoutTruncated=${result.stdoutTruncated}) — ` +
				"treating as an error rather than certifying a silent success",
		);
	}
	return { isError: signalLost ? true : hasErrorResult(output), isUsageLimit: isUsageLimitText(output), signalLost };
}

async function runScript(
	runSupervised: SupervisedRunner,
	repoRoot: string,
	script: string,
	args: string[],
	signal?: AbortSignal,
	options?: Pick<SupervisedProcessOptions, "livenessProbe" | "maxLivenessExtensions"> & {
		// D1 wiring: the client run root, used to size the wall via
		// computeScriptRunTimeoutMs() instead of the flat SCRIPT_RUN_TIMEOUT_MS
		// fallback. Explicit rather than inferred from `args` because not every
		// call site's last positional arg is the client run root (e.g.
		// validate-interpretation's is a single interpretation file path) — an
		// inferred guess here would silently mis-size the budget.
		targetDir?: string;
		// Overrides the basename-derived label below. Required wherever that
		// derivation is not distinguishing: interpret-plan.ts's outputPaths()
		// names every single-window unit's result `interpretation.json`, so the
		// per-unit canonical validator would otherwise log the SAME label for
		// every unit in the run — precisely the "a process died, but which one?"
		// blind spot the label exists to close.
		labelSuffix?: string;
	},
) {
	// The target dir is usually the last positional arg (see call sites below);
	// falling back to the script name alone still beats no label at all.
	const target = args[args.length - 1];
	const derived = options?.labelSuffix ?? (target ? basename(target) : null);
	const label = derived ? `runScript:${script}:${derived}` : `runScript:${script}`;
	const { targetDir, labelSuffix: _labelSuffix, ...livenessOptions } = options ?? {};
	const timeoutMs = targetDir ? computeScriptRunTimeoutMs(targetDir) : SCRIPT_RUN_TIMEOUT_MS;
	return runSupervised({
		cmd: ["bun", "run", "--cwd", scriptsDir(repoRoot), script, "--", ...args],
		cwd: repoRoot,
		signal,
		label,
		...deadlines(timeoutMs, SCRIPT_RUN_IDLE_TIMEOUT_MS),
		...livenessOptions,
	});
}

// D2 evidence probe for `prepare-pages`: prepare.ts (see interpret-plan.ts's
// CreateInterpretPlanOptions.preparedPagesRoot comment, and prepare.ts's own
// sourceOutputDir) writes into `<targetDir>/_pages/<source parent>/<source
// stem>/` — a plain sibling of the client's source tree, NOT under
// `ข้อมูลระบบ/_pages` (that path holds a different thing: the deterministic
// pipeline's own inventory.yaml/dispositions.yaml/fragments, written by
// earlier stages, not prepare.ts's renders). Client 345's incident (see this
// file's header) was exactly one process writing pages here while the
// supervisor, unable to see them, killed it as "idle".
//
// COUNTS EVERY FILE, not just `*.png`, on purpose. Only prepare.ts's PDF path
// produces PNGs; prepareReadyFile copies a ready image/workbook through
// verbatim as `page-001<ext>` (.jpg/.jpeg/.xlsx/…), and each finished source
// also gets a manifest.yaml. A `.png`-only filter reads a flat 0 forever on a
// JPEG-or-workbook-only client — inert in a way that is indistinguishable
// from "working", which is the worst possible failure mode for a health
// check. Counting everything under the tree also picks up pdftoppm's
// `_render_t*-NN.png` temporaries, so the reading rises DURING a tier rather
// than only when a tier finishes renaming.
//
// Must never throw: a directory that does not exist yet (rendering has not
// started) or that disappears mid-walk reads as 0, never an exception. The
// count is NOT monotonic — prepare.ts rmSync's a source's output dir before
// re-rendering it, so a re-run after an earlier kill makes it drop; the
// supervisor treats any CHANGE as progress for exactly this reason (see
// SupervisedProcessOptions.livenessProbe). One shallow-recursive walk is cheap
// even at client 336's ~2,800 pages, and it runs only at an idle expiry.
function countPreparedPageArtifacts(targetDir: string): number {
	const root = join(targetDir, "_pages");
	let count = 0;
	const walk = (dir: string) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) walk(join(dir, entry.name));
			else if (entry.isFile()) count += 1;
		}
	};
	walk(root);
	return count;
}

// F — chunk prepare-pages (see .claude/skills/ksk-keying/scripts/prepare.ts's
// --max-pages) so no single invocation can approach MAX_SUPERVISED_WALL_MS.
// This is the compensating fix that makes the D1 policy above safe for a
// client the size of 336: without it, its worst single month's ~1.15h of
// genuine render work gets clamped to 2h by SCRIPT_RUN_TIMEOUT_CEILING_MS and
// killed mid-render (see STAGE_SPAWN_TIMEOUT_CEILING_MS's REFITTED note for
// why this is stated per-month, not per whole client folder).
//
// MEASURED (samples/clients/336, 2026-07-27, via `pdfinfo` over every source
// PDF, per client-month run root — the scope one runPreparePagesChunked
// invocation actually targets): 03-69/04-69/05-69 hold 920/1,039/840 PDF
// pages respectively (1,056 PDFs / 2,799 pages across all three MONTHS
// combined, not one run); the single LARGEST source PDF anywhere in the
// client is only 218 pages
// (04-69/เอกสารค่าใช้จ่าย/เอกสารประกอบรายงานภาษีซื้อ ภาษีขาย.pdf). At the real
// ~4.0 s/page render rate (see SCRIPT_RUN_PER_PAGE_MS's comment), even that
// one largest source is only ~14.5 minutes of render work — nowhere near the
// threshold that would force chunking WITHIN a source (i.e. splitting one
// PDF's own page range across two invocations). Whole-SOURCE chunking —
// prepare.ts's --max-pages, which never splits a single source's pages across
// two invocations, built directly on its existing skip-if-exists idempotency —
// is therefore sufficient for every client measured so far.
//
// The real threshold, restated against what this call site actually enforces
// (not against the 2h MAX_SUPERVISED_WALL_MS policy, which is not the deadline
// any one chunk is granted): every chunk gets the SAME fixed
// computeScriptRunTimeoutMsForPages(PREPARE_PAGES_CHUNK_PAGES) = 80-minute
// deadline (see PREPARE_PAGES_MAX_CHUNKS's comment below), regardless of how
// many pages actually land in it — and selectChunk() (prepare.ts) always
// admits the first pending source even when its cost alone exceeds the
// --max-pages budget, so one chunk can carry up to (PREPARE_PAGES_CHUNK_PAGES
// - 1) + largestSourcePages pages. At 4.0 s/page, 80 minutes covers ~1,200
// pages standalone — and less than that if other sources already selected
// into the same chunk have consumed part of the 80 minutes first. A future
// client with a single source north of roughly 1,200 pages (lower still if it
// is not first in discovery order within its chunk) would need within-source
// (page-range) chunking too, or a chunk deadline sized off the chunk's own
// real page total instead of the nominal PREPARE_PAGES_CHUNK_PAGES; this fix
// does not add that, and should not need to until such a client is actually
// observed — but the boundary is ~1,200 pages, not ~1,800.
export const PREPARE_PAGES_CHUNK_PAGES = 500;
// Arithmetic: at the measured ~4.0 s/page rate, one 500-page chunk is
// expected to take ~2,000s (~33.3 min) of real render work. Its own
// supervised deadline —
// computeScriptRunTimeoutMsForPages(500) = SCRIPT_RUN_TIMEOUT_MS floor
// (30 min) + SCRIPT_RUN_PER_PAGE_MS (6 s/page, the deliberately-padded
// budgeting rate this call site already uses, not the raw 4.0 s measurement)
// * 500 pages = 80 min — leaves ~47 min of margin over the expected render
// time, and that 80-min deadline itself sits ~40 min under the 2-hour
// MAX_SUPERVISED_WALL_MS ceiling. Comfortable margin on both counts, for
// every client measured so far (336's worst month, 04-69 at ~1,048 inventory
// pages, needs only ceil(1,048 / 500) = 3 chunks; its whole 3-month, 2,799-page
// folder — never handed to one invocation, see the REFITTED note above — would
// still need only ceil(2,799 / 500) = 6).
export const PREPARE_PAGES_MAX_CHUNKS = 40;
// D3 loop-level bound: even if prepare.ts's own --max-pages reporting were
// ever wrong and claimed "work remains" forever, this hard iteration cap
// still ends the loop rather than running unsupervised. 40 chunks * 500
// pages/chunk = 20,000 pages of capacity — roughly 19x client 336's worst
// single month (~1,048 pages, the actual scope one invocation ever faces,
// needing only ~3 chunks), and still ~7x that client's entire 3-month,
// 2,799-page folder if the two were ever mistakenly compared 1:1. An order of
// magnitude of headroom over the largest real client measured so far. In
// practice the
// no-progress guard inside runPreparePagesChunked below should fire first on
// any real stuck run; this cap exists only to bound the pathological case
// where prepare.ts's own "done" signal is simply wrong forever.

type PreparePagesJson = {
	ok?: boolean;
	prepared?: number;
	deferred?: number;
	work_remains?: boolean;
	chunk_pages_rendered?: number;
};

function parsePreparePagesJson(stdout: string): PreparePagesJson | null {
	try {
		const parsed = JSON.parse(stdout.trim());
		return parsed && typeof parsed === "object" ? (parsed as PreparePagesJson) : null;
	} catch {
		return null;
	}
}

// Forces a SupervisedProcessResult that was `successful()` into a failed one,
// for a fix-F-specific reason (unparseable --json output, no-progress, or the
// loop bound itself) that has nothing to do with the process's own exit
// behaviour. Keeps reason/cleanupComplete/stdout/stderr from the real result
// (so the caller's existing failure logging still shows real process output)
// and only flips exitCode so successful() downstream correctly reports "fail".
function forceChunkFailure(result: SupervisedProcessResult): SupervisedProcessResult {
	return { ...result, exitCode: result.exitCode === 0 ? 1 : result.exitCode };
}

// Runs prepare.ts in a bounded loop, each invocation capped at
// PREPARE_PAGES_CHUNK_PAGES pages of new rendering work and its own
// comfortably-under-ceiling deadline (see the constants above), until
// prepare.ts itself reports no work remains. countPreparedPageArtifacts is
// used two ways here: as the WITHIN-chunk liveness probe passed to
// runSupervised (unchanged contract — an operator watching 336 sees this
// advance during a single chunk exactly as before), and, read again once each
// chunk's process exits, as this loop's own ACROSS-chunk no-progress guard
// (D3): a chunk that reports "work remains" but moved nothing on disk cannot
// be trusted to ever finish.
// Exported for direct unit coverage of the loop/no-progress-guard/max-chunks
// behaviour (see spawn-stage.test.ts) — not a second entry point, still only
// ever called from runInterpretStage below.
export async function runPreparePagesChunked(
	runSupervised: SupervisedRunner,
	repoRoot: string,
	targetDir: string,
	signal: AbortSignal | undefined,
): Promise<SupervisedProcessResult> {
	const chunkTimeoutMs = computeScriptRunTimeoutMsForPages(PREPARE_PAGES_CHUNK_PAGES);
	let lastResult: SupervisedProcessResult | null = null;
	let lastArtifactCount = countPreparedPageArtifacts(targetDir);
	for (let chunk = 0; chunk < PREPARE_PAGES_MAX_CHUNKS; chunk++) {
		const result = await runSupervised({
			cmd: [
				"bun", "run", "--cwd", scriptsDir(repoRoot), "prepare-pages", "--",
				// --json-summary, NOT --json: --json's payload includes a `results[]`
				// row per discovered source (prepared rows carry every rendered page
				// filename plus the manifest path) — MEASURED (client 336,
				// 2026-07-27) at 691,277 bytes for a realistic mid-run chunk, 69% of
				// process-supervisor.ts's default 1,000,000-byte maxOutputBytes
				// retention cap, and it scales linearly with source count. This loop's
				// control signal is only the small counters block below
				// (prepared/deferred/chunk_pages_rendered/work_remains), which
				// --json-summary prints without ever enumerating sources — see
				// prepare.ts's Args.jsonSummary comment for the full incident.
				"--dpi", "300", "--max-pages", String(PREPARE_PAGES_CHUNK_PAGES), "--json-summary", targetDir,
			],
			cwd: repoRoot,
			signal,
			label: `runScript:prepare-pages:chunk${chunk}`,
			...deadlines(chunkTimeoutMs, SCRIPT_RUN_IDLE_TIMEOUT_MS),
			livenessProbe: () => countPreparedPageArtifacts(targetDir),
		});
		lastResult = result;
		if (!successful(result)) return result; // caller's existing failure path applies unchanged

		const artifactCount = countPreparedPageArtifacts(targetDir);
		const payload = parsePreparePagesJson(result.stdout);
		if (!payload || typeof payload.work_remains !== "boolean") {
			// A truncated --json-summary stdout is a DIFFERENT failure from a
			// genuinely malformed one: the control signal was never fully written
			// to us (process-supervisor.ts's maxOutputBytes cap kept only a
			// prefix), not that prepare.ts emitted something we can't parse. Report
			// it as such — see this file's --json-summary comment above for why the
			// summary is expected to stay small, so a truncation here means that
			// expectation was violated, not that it was never tried.
			console.error(
				result.stdoutTruncated
					? `prepare-pages chunk ${chunk}: --json-summary stdout was TRUNCATED at the supervisor's ` +
							`maxOutputBytes cap (${result.stdout.length} bytes retained) before it could be parsed — ` +
							"the control signal itself was lost, not merely malformed; treating as a failed invocation"
					: `prepare-pages chunk ${chunk}: could not parse --json-summary output (${result.stdout.length} bytes) — ` +
							"treating as a failed invocation rather than guessing whether work remains",
			);
			return forceChunkFailure(result);
		}
		// Per-chunk progress line: an operator watching a long 336-style run sees
		// this advance every ~33 minutes instead of sitting in silence for hours.
		console.error(
			`prepare-pages chunk ${chunk}: prepared=${payload.prepared ?? "?"} deferred=${payload.deferred ?? "?"} ` +
				`artifacts_total=${artifactCount} work_remains=${payload.work_remains}`,
		);
		if (!payload.work_remains) return result; // done — every source is now skip-if-exists

		if (artifactCount <= lastArtifactCount) {
			console.error(
				`prepare-pages chunk ${chunk}: no progress (artifact count stayed at ${artifactCount}) while ` +
					"work_remains=true — stopping rather than looping forever",
			);
			return forceChunkFailure(result);
		}
		lastArtifactCount = artifactCount;
	}
	console.error(`prepare-pages: hit PREPARE_PAGES_MAX_CHUNKS (${PREPARE_PAGES_MAX_CHUNKS}) with work still remaining`);
	return lastResult
		? forceChunkFailure(lastResult)
		: {
				pid: null,
				exitCode: 1,
				reason: "exited",
				stdout: "",
				stderr: "prepare-pages: no chunk ever ran",
				stdoutTruncated: false,
				stderrTruncated: false,
				cleanupComplete: true,
			};
}

// Artifact validators wired into a stage's own `claude -p` as PostToolUse
// hooks, so a malformed artifact comes back to the agent that just wrote it —
// while it is still alive and still knows what it meant — instead of surfacing
// three minutes later as a BLOCKED stage with no one left to ask.
//
// Provenance: client 345 died at the Stage 0 gate because an agent editing an
// existing 452-line CLIENT.md dropped the frontmatter's closing `---`. The gate
// was right to stop, but nothing in between had noticed.
//
// Why `--settings` and not the agent's own frontmatter `hooks:` block, which
// would scope more tightly: frontmatter hooks are gated on workspace trust, and
// the container runs in an untrusted `/workspace`. Measured, not assumed — the
// same probe agent fired its hook in the trusted repo checkout and silently did
// not fire in `/workspace` or in any untrusted directory. A `--settings` hook
// fires in all three. Silently-absent safety netting is worse than none.
//
// BASE applies to every stage on purpose. CLIENT.md is not magnum's alone —
// Stage 0's parent patches it (ksk-stage-profile/SKILL.md) and Stage 1 appends
// to its `## Decisions (auto)` log (ksk-stage-segment/SKILL.md). Scoping the
// check to "the stage we think writes this file" would re-make the assumption
// that just failed. `if` costs nothing when it does not match — Claude Code
// skips the spawn entirely rather than starting a process that exits 0.
//
// NOTE: Stage 2 does not come through here (runInterpretStage has its own
// executor). That is fine only while Stage 2.5 stays deferred and writes no
// CLIENT.md; if 2.5 is ever implemented, it needs this wiring too.
const BASE_HOOK_FILES = ["CLIENT.md"] as const;
const STAGE_HOOK_FILES: Partial<Record<string, readonly string[]>> = {};

export function stageHookSettings(stageId: string, repoRoot: string): string {
	const validators: Record<string, string> = { "CLIENT.md": join(scriptsDir(repoRoot), "client-md-lint.ts") };
	const files = [...BASE_HOOK_FILES, ...(STAGE_HOOK_FILES[stageId] ?? [])];
	// One `if` rule per hook entry, so each file needs a Write and an Edit form.
	const hooks = files.flatMap((file) =>
		["Write", "Edit"].map((tool) => ({
			type: "command",
			if: `${tool}(**/${file})`,
			// Exec form (args set) — no shell, so client paths carrying spaces
			// or Thai characters need no quoting.
			command: "bun",
			args: [validators[file]],
			timeout: 30,
		})),
	);
	return JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Write|Edit", hooks }] } });
}

function preparedManifestPath(path: string) {
	return join(dirname(path), "manifest.yaml");
}

// A missing prepared input is a deterministic stage failure, never a reason
// to give a leaf a directory and hope it finds something nearby.
function assertPreparedEvidence(plan: InterpretPlan) {
	const manifests = new Map<string, { source_path?: unknown; pages?: Array<{ artifact?: unknown }> }>();
	for (const unit of plan.units) for (const ref of [...unit.pages, ...unit.sheets]) {
		if (!existsSync(ref.artifactPath)) throw new Error(`prepared evidence is missing: ${ref.artifactPath}`);
		const manifestPath = preparedManifestPath(ref.artifactPath);
		let manifest = manifests.get(manifestPath);
		if (!manifest) {
			manifest = parseYamlFile<{ source_path?: unknown; pages?: Array<{ artifact?: unknown }> }>(manifestPath, true)!;
			manifests.set(manifestPath, manifest);
		}
		if (typeof manifest.source_path !== "string" || !plan.units.some((unit) => [...unit.pages, ...unit.sheets].some((candidate) => candidate.file === manifest.source_path && preparedManifestPath(candidate.artifactPath) === manifestPath)))
			throw new Error(`prepared manifest does not identify an assigned source: ${manifestPath}`);
		if ("sheet" in ref) continue; // executor-derived sheet JSON is not a prepare.ts page artifact
		if (!Array.isArray(manifest.pages) || !manifest.pages.some((page) => page?.artifact === basename(ref.artifactPath)))
			throw new Error(`prepared manifest does not name artifact ${basename(ref.artifactPath)}: ${manifestPath}`);
	}
}

// Claude's Read tool cannot safely select one tab from XLS/XLSX. Each assigned
// sheet is converted by its own supervised, bounded subprocess so corrupt
// workbooks cannot block the app event loop or survive cancellation.
async function materializeSpreadsheetEvidence(plan: InterpretPlan, signal: AbortSignal | undefined, deps: SpawnStageDeps) {
	const seen = new Set<string>();
	for (const unit of plan.units) for (const ref of unit.sheets) {
		if (seen.has(ref.artifactPath)) continue;
		seen.add(ref.artifactPath);
		const result = await deps.runSupervised({
			cmd: ["bun", "run", PREPARE_SHEET_SCRIPT, "--", ref.sourcePath, ref.sheet, ref.artifactPath, ref.file],
			cwd: deps.repoRoot,
			signal,
			label: `sheet-prepare:${ref.file}#s${ref.sheet}`,
			...deadlines(SHEET_PREPARE_TIMEOUT_MS, SHEET_PREPARE_IDLE_TIMEOUT_MS, "KSK_SHEET_PREPARE"),
		});
		if (!successful(result))
			throw new Error(`spreadsheet preparation failed for ${ref.file}#s${ref.sheet}: ${processOutput(result) || result.reason}`);
	}
}

function removeUnexpectedGeneratedFiles(dir: string, expected: Set<string>, accepts: (name: string) => boolean) {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile() || !accepts(entry.name)) continue;
		const path = resolve(dir, entry.name);
		if (!expected.has(path)) rmSync(path, { force: true });
	}
}

/**
 * Unit boundaries may change between retries/runs. Downstream readers load
 * every generated interpretation and fragment file, so stale artifacts must not
 * survive a new deterministic plan and silently duplicate or override facts.
 */
function reconcileInterpretArtifacts(plan: InterpretPlan) {
	const expectedInterpretations = new Set(plan.units.map((unit) => resolve(unit.resultPath)));
	const expectedFragments = new Set(plan.units.map((unit) => resolve(unit.fragmentPath)));
	const segmentsRoot = join(plan.runRoot, "ข้อมูลระบบ", "_segments");
	if (existsSync(segmentsRoot)) {
		for (const entry of readdirSync(segmentsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			removeUnexpectedGeneratedFiles(
				join(segmentsRoot, entry.name),
				expectedInterpretations,
				(name) => name.startsWith("interpretation") && name.endsWith(".json"),
			);
		}
	}
	removeUnexpectedGeneratedFiles(
		join(plan.runRoot, "ข้อมูลระบบ", "_pages", "fragments"),
		expectedFragments,
		(name) => name.endsWith(".yaml") || name.endsWith(".yml"),
	);
	// Audits are re-run from current fragments every time; keeping an old
	// verdict would misrepresent a changed claim even when the unit id matches.
	removeUnexpectedGeneratedFiles(
		join(plan.runRoot, "ข้อมูลระบบ", "_pages", "claim-audit"),
		new Set(),
		(name) => name.endsWith(".yaml") || name.endsWith(".yml"),
	);
}

function clientProfilePath(targetDir: string) {
	const local = join(targetDir, "CLIENT.md");
	if (existsSync(local)) return local;
	const parent = join(dirname(targetDir), "CLIENT.md");
	return existsSync(parent) ? parent : null;
}

function canonicalUnitValidator(runSupervised: SupervisedRunner, repoRoot: string): UnitValidator {
	return async (unit, signal) => {
		const local = await validateUnitArtifacts(unit);
		if (!local.ok) return local;
		const result = await runScript(runSupervised, repoRoot, "validate-interpretation", [unit.resultPath], signal, { labelSuffix: unit.id });
		if (successful(result)) return { ok: true };
		const output = processOutput(result);
		return { ok: false, errors: [output || `canonical validator ${result.reason} (exit ${result.exitCode ?? "none"})`] };
	};
}

/**
 * The ProcessSupervisor adapter behind executeInterpretPlan's `runLeaf` port,
 * shared by the main interpret wave and the audit-repair wave (same command
 * shape, same weight class, same deadlines — only the log label differs).
 *
 * Two things it must carry that the audit leaf does not:
 * - `invocation.stdin`, because the inlined visual leaf receives its packet and
 *   its base64 page images as a stream-json message rather than as argv;
 * - `resultText`, the captured `result` event's own `result` field — the
 *   interpretation JSON the executor then writes. `capture` already assembles
 *   that event incrementally, so nothing new is buffered for it.
 */
async function runInterpretLeaf(invocation: LeafInvocation, label: string, deps: SpawnStageDeps): Promise<LeafRunResult> {
	const capture = captureLeafResult(`${label}:${invocation.unit.id}:stdout`);
	const result = await deps.runSupervised({
		cmd: [invocation.command, ...invocation.args], cwd: invocation.cwd, signal: invocation.signal,
		label: `${label}:${invocation.unit.id}`,
		...(invocation.stdin ? { stdin: invocation.stdin } : {}),
		...deadlines(computeInterpretLeafTimeoutMs(invocation.unit), INTERPRET_LEAF_IDLE_TIMEOUT_MS),
		onStdoutChunk: capture.onStdoutChunk,
	});
	const captured = capture.get();
	const classified = classifyLeafResult(result, captured);
	return {
		exitCode: successful(result) && !classified.isError ? 0 : result.exitCode && result.exitCode !== 0 ? result.exitCode : 1,
		stdout: result.stdout,
		stderr: result.stderr,
		resultText: typeof captured.event?.result === "string" ? captured.event.result : undefined,
		failureKind: classified.isUsageLimit ? "usage_limit" : result.reason === "aborted" ? "cancelled" : "process_error",
	};
}

type ExclusionClaim = { file: string; page: number | null; sheet: string | null; reason: string; duplicate_of?: string };
type AuditOutcome = { unit: InterpretUnit; claims: ExclusionClaim[]; refuted: boolean; feedback: string[] };

function claimKey(claim: ExclusionClaim) {
	return claim.page != null ? `${claim.file}#p${claim.page}` : `${claim.file}#s${claim.sheet}`;
}

function claimsForUnit(unit: InterpretUnit): ExclusionClaim[] {
	const fragment = parseYamlFile<{ entries?: unknown[] }>(unit.fragmentPath, true)!;
	if (!Array.isArray(fragment.entries)) throw new Error(`fragment entries missing for audit: ${unit.fragmentPath}`);
	return fragment.entries.flatMap((raw) => {
		if (!raw || typeof raw !== "object") return [];
		const entry = raw as Record<string, unknown>;
		if (entry.disposition !== "excluded") return [];
		if (typeof entry.file !== "string" || (typeof entry.page !== "number" && typeof entry.sheet !== "string") || typeof entry.reason !== "string" || !entry.reason)
			throw new Error(`malformed exclusion claim in ${unit.fragmentPath}`);
		return [{ file: entry.file, page: typeof entry.page === "number" ? entry.page : null, sheet: typeof entry.sheet === "string" ? entry.sheet : null, reason: entry.reason, duplicate_of: typeof entry.duplicate_of === "string" ? entry.duplicate_of : undefined }];
	});
}

function preparedRefMap(plan: InterpretPlan) {
	const refs = new Map<string, string>();
	for (const unit of plan.units) for (const ref of [...unit.pages, ...unit.sheets]) refs.set("page" in ref ? `${ref.file}#p${ref.page}` : `${ref.file}#s${ref.sheet}`, ref.artifactPath);
	return refs;
}

async function auditUnit(unit: InterpretUnit, plan: InterpretPlan, signal: AbortSignal | undefined, deps: SpawnStageDeps): Promise<AuditOutcome> {
	const claims = claimsForUnit(unit);
	if (!claims.length) return { unit, claims, refuted: false, feedback: [] };
	const refs = preparedRefMap(plan);
	const packet = claims.map((claim) => {
		const preparedEvidencePath = refs.get(claimKey(claim));
		if (!preparedEvidencePath) throw new Error(`audit claim has no prepared evidence: ${claimKey(claim)}`);
		const originalEvidencePath = claim.duplicate_of ? refs.get(claim.duplicate_of) : undefined;
		if (claim.duplicate_of && !originalEvidencePath) throw new Error(`audit duplicate claim has no prepared original: ${claim.duplicate_of}`);
		return { ...claim, preparedEvidencePath, originalEvidencePath };
	});
	const resultPath = join(unit.runRoot, "ข้อมูลระบบ", "_pages", "claim-audit", `${unit.id}.yaml`);
	mkdirSync(dirname(resultPath), { recursive: true });
	const auditPacket = {
		repoRoot: deps.repoRoot,
		runRoot: unit.runRoot,
		segmentId: unit.segmentId,
		owningInterpretationPath: unit.resultPath,
		claims: packet,
		resultPath,
	};
	const prompt = [
		"You are one direct, bounded Stage-2 exclusion auditor. Do not delegate or discover files.",
		"Audit exactly the claims in this literal JSON packet and only its prepared evidence paths:",
		JSON.stringify(auditPacket, null, 2),
		"Write exactly one ksk_claim_audit.v1 YAML result only to packet.resultPath.",
		"Do not run commands, validation, searches, merges, or change any interpretation/fragment/ledger.",
	].join("\n");
	const auditCapture = captureLeafResult(`audit-leaf:${unit.id}:stdout`);
	const result = await deps.runSupervised({
		cmd: ["claude", "-p", prompt, "--agent", "ksk-lestrade", "--tools", "Read,Write", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"],
		cwd: deps.repoRoot, signal,
		label: `audit-leaf:${unit.id}`,
		...deadlines(AUDIT_LEAF_TIMEOUT_MS, AUDIT_LEAF_IDLE_TIMEOUT_MS),
		onStdoutChunk: auditCapture.onStdoutChunk,
	});
	const auditOutput = processOutput(result);
	const auditClassified = classifyLeafResult(result, auditCapture.get());
	if (!successful(result) || auditClassified.isError) {
		if (auditClassified.isUsageLimit) throw new Error(`Claude usage limit reached during exclusion audit for ${unit.id}`);
		throw new Error(`exclusion audit leaf failed for ${unit.id}: ${auditOutput}`);
	}
	const report = parseYamlFile<{ schema?: unknown; segment_id?: unknown; claims?: unknown[] }>(resultPath, true)!;
	if (report.schema !== "ksk_claim_audit.v1" || report.segment_id !== unit.segmentId || !Array.isArray(report.claims)) throw new Error(`invalid exclusion audit report: ${resultPath}`);
	const expected = new Set(claims.map(claimKey));
	const seen = new Set<string>();
	let refuted = false;
	const feedback: string[] = [];
	for (const raw of report.claims) {
		if (!raw || typeof raw !== "object") throw new Error(`invalid audit claim in ${resultPath}`);
		const entry = raw as Record<string, unknown>;
		const claim: ExclusionClaim = { file: String(entry.file ?? ""), page: typeof entry.page === "number" ? entry.page : null, sheet: typeof entry.sheet === "string" ? entry.sheet : null, reason: String(entry.reason ?? "") };
		const key = claimKey(claim);
		// The claim's identity is `claimKey` (file + page/sheet), which is already
		// unique within a unit. The executor holds the authoritative `reason`
		// itself and does not require the auditor to echo it back verbatim —
		// requiring byte-identical `reason` here previously broke on any auditor
		// that (correctly, per its own instructions) paraphrased or summarized
		// a long free-prose reason instead of quoting it.
		if (!expected.has(key)) throw new Error(`audit report claims a page that was never claimed: ${key} (${resultPath})`);
		if (seen.has(key)) throw new Error(`audit report repeats a claim: ${key} (${resultPath})`);
		if (entry.verdict !== "confirmed" && entry.verdict !== "refuted") throw new Error(`audit claim ${key} has verdict ${JSON.stringify(entry.verdict)} (expected confirmed|refuted) (${resultPath})`);
		// ...but `duplicate` is not free prose: validate-interpretation.ts makes it
		// the ONE legal non-Thai reason code, always paired with `duplicate_of`, and
		// ksk-lestrade runs a DIFFERENT procedure for it (compare the excluded page
		// against the named original). Echoing a structural code back is not a
		// transcription burden, and a report that renames it is evidence the auditor
		// applied the wrong test — which is the guard the old equality check was
		// really reaching for, minus the fragility on prose.
		const expectedReason = claims.find((expectedClaim) => claimKey(expectedClaim) === key)?.reason;
		if (expectedReason === "duplicate" && claim.reason !== "duplicate")
			throw new Error(
				`audit claim ${key} was claimed as reason "duplicate" but the report audits it as ${JSON.stringify(claim.reason)} — a duplicate claim must be audited as a duplicate against its named original (${resultPath})`,
			);
		seen.add(key);
		if (entry.verdict === "refuted") {
			refuted = true;
			feedback.push(`exclusion audit refuted ${key}: ${typeof entry.evidence === "string" && entry.evidence ? entry.evidence : "claim not supported by prepared evidence"}`);
		}
	}
	if (seen.size !== expected.size) {
		const missing = [...expected].filter((key) => !seen.has(key));
		throw new Error(`audit report misses ${missing.length} claim(s): ${missing.join(", ")} (${resultPath})`);
	}
	return { unit, claims, refuted, feedback };
}

async function runAuditBatch(
	units: InterpretUnit[],
	plan: InterpretPlan,
	externalSignal: AbortSignal | undefined,
	deps: SpawnStageDeps,
): Promise<AuditOutcome[]> {
	const controller = new AbortController();
	const relayAbort = () => controller.abort(externalSignal?.reason ?? "Stage 2 cancelled");
	if (externalSignal?.aborted) relayAbort();
	else externalSignal?.addEventListener("abort", relayAbort, { once: true });
	const results = new Array<AuditOutcome>(units.length);
	const concurrency = envDuration("KSK_INTERPRET_CONCURRENCY") ?? DEFAULT_INTERPRET_CONCURRENCY;
	let cursor = 0;
	let firstError: unknown = null;
	async function worker() {
		while (!controller.signal.aborted) {
			const index = cursor++;
			if (index >= units.length) return;
			try {
				results[index] = await auditUnit(units[index], plan, controller.signal, deps);
			} catch (error) {
				if (firstError == null) firstError = error;
				controller.abort(error);
			}
		}
	}
	try {
		await Promise.all(Array.from({ length: Math.min(concurrency, units.length) }, worker));
		if (firstError != null) throw firstError;
		if (controller.signal.aborted) throw new Error("Stage 2 exclusion audit cancelled");
		return results;
	} finally {
		externalSignal?.removeEventListener("abort", relayAbort);
	}
}

async function auditExclusions(plan: InterpretPlan, signal: AbortSignal | undefined, deps: SpawnStageDeps) {
	const first = await runAuditBatch(plan.units, plan, signal, deps);
	const refuted = first.filter((outcome) => outcome.refuted).map((outcome) => outcome.unit);
	if (!refuted.length) return true;
	const forceRetryErrors = new Map(
		first.filter((outcome) => outcome.refuted).map((outcome) => [outcome.unit.id, outcome.feedback]),
	);
	// The owner alone receives one repair attempt. forceUnitIds deliberately
	// bypasses resume so a valid-but-refuted fragment cannot evade the repair.
	const repaired = await executeInterpretPlan({
		plan: { ...plan, units: refuted }, repoRoot: deps.repoRoot, signal, clientMdPath: clientProfilePath(plan.runRoot), concurrency: 1, maxAttempts: 1,
		forceUnitIds: new Set(refuted.map((unit) => unit.id)), forceRetryErrors, validate: canonicalUnitValidator(deps.runSupervised, deps.repoRoot),
		runLeaf: (invocation) => runInterpretLeaf(invocation, "audit-repair-leaf", deps),
	});
	if (repaired.status !== "passed") return false;
	const second = await runAuditBatch(refuted, plan, signal, deps);
	return !second.some((outcome) => outcome.refuted);
}

export async function runInterpretStage(targetDir: string, signal: AbortSignal | undefined, deps: SpawnStageDeps): Promise<StageOutcome> {
	const safeDeps: SpawnStageDeps = {
		...deps,
		runSupervised: async (options) => {
			const result = await deps.runSupervised(options);
			if (!result.cleanupComplete)
				throw new CleanupFailure(`supervisor could not clean process group ${result.pid ?? "unknown"}`);
			return result;
		},
	};
	try {
		// Prepare is deliberately before planning/execution: it creates every PDF
		// image and workbook copy named in the literal leaf packet at 300 DPI.
		// F — chunked (see runPreparePagesChunked above), not one unbounded
		// runScript() call: a single invocation covering all of a large client
		// month's pages (e.g. 336's worst month, ~1.15h of render work) could
		// otherwise approach or exceed MAX_SUPERVISED_WALL_MS and be killed
		// mid-render.
		const prepared = await runPreparePagesChunked(safeDeps.runSupervised, safeDeps.repoRoot, targetDir, signal);
		if (!successful(prepared)) {
			const detail = `prepare-pages failed: ${processOutput(prepared)}`;
			console.error(`interpret: ${detail}`);
			return { status: "fail", detail };
		}
		const plan = loadInterpretPlan(targetDir);
		reconcileInterpretArtifacts(plan);
		await materializeSpreadsheetEvidence(plan, signal, safeDeps);
		for (const unit of plan.units) {
			mkdirSync(dirname(unit.resultPath), { recursive: true });
			mkdirSync(dirname(unit.fragmentPath), { recursive: true });
		}
		assertPreparedEvidence(plan);
		const executed = await executeInterpretPlan({
			plan,
			repoRoot: safeDeps.repoRoot,
			signal,
			clientMdPath: clientProfilePath(targetDir),
			concurrency: envDuration("KSK_INTERPRET_CONCURRENCY") ?? DEFAULT_INTERPRET_CONCURRENCY,
			maxAttempts: 2,
			validate: canonicalUnitValidator(safeDeps.runSupervised, safeDeps.repoRoot),
			runLeaf: (invocation: LeafInvocation) => runInterpretLeaf(invocation, "interpret-leaf", safeDeps),
		});
		if (executed.status !== "passed") {
			const detail = `executor ${executed.status}: ${executed.units.filter((unit) => unit.status !== "passed" && unit.status !== "skipped-valid").map((unit) => `${unit.unitId}: ${unit.errors.join("; ")}`).join(" | ")}`;
			console.error(`interpret: ${detail}`);
			return { status: "fail", detail };
		}
		if (!(await auditExclusions(plan, signal, safeDeps))) {
			const detail = "an exclusion claim remained refuted after its one owner retry";
			console.error(`interpret: ${detail}`);
			return { status: "fail", detail };
		}
		const merged = await runScript(safeDeps.runSupervised, safeDeps.repoRoot, "merge-dispositions", [targetDir], signal, { targetDir });
		if (!successful(merged)) {
			const detail = `merge-dispositions failed: ${processOutput(merged)}`;
			console.error(`interpret: ${detail}`);
			return { status: "fail", detail };
		}
		return { status: "success" };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		console.error(`interpret: deterministic executor failed: ${detail}`);
		return error instanceof CleanupFailure ? { status: "cleanup-failed", detail } : { status: "fail", detail };
	}
}

export function createSpawnStage(deps: SpawnStageDeps = { repoRoot: REPO_ROOT, runSupervised: runSupervisedProcess }): StageRunner {
	return async (stage, targetDir, context, signal) => {
	if (stage.id === "interpret") return runInterpretStage(targetDir, signal, deps);
	const prompt = buildPrompt(stage, targetDir, context);
	let sawSuccessResult = false;
	let sawErrorResult = false;
	let discardedLine = false;
	const onResultEvent = (evt: any) => {
		if (evt.is_error) sawErrorResult = true;
		else sawSuccessResult = true;
	};
	// E — stdout and stderr used to share this ONE callback, so an oversized,
	// newline-free STDERR blob forced the whole attempt to "fail" even when
	// stdout had already delivered a clean, intact `result` event (a real bug
	// a validator caught). Resolved by NOT treating the two streams as
	// equally authoritative for the signal this file cares about: Claude
	// Code's `--output-format stream-json` protocol writes every protocol
	// event — including `result` — to STDOUT only; stderr carries incidental
	// diagnostic text, never the structured result. A discard on stdout can
	// therefore genuinely be "the lost result event" and must keep forcing a
	// fail; a discard on stderr cannot be that, by construction of the
	// protocol, so it must not taint the attempt at all. Each
	// resultEventConsumer call below still logs its own diagnostic (its label
	// already says which stream), so nothing about a stderr discard goes
	// unreported — it simply stops being load-bearing for StageOutcome.
	const onStdoutDiscard = () => {
		discardedLine = true;
	};
	const onStderrDiscard = () => {};
	// BLOCKER FIX: a validator caught the mirror-image bug — this file passed
	// the SAME onResultEvent to both streams' resultEventConsumer, so a line
	// shaped like `{"type":"result","is_error":false}` appearing on STDERR
	// (a child echoing a transcript, a wrapper script, a subagent printing its
	// own captured stream-json) could set sawSuccessResult and, with exitCode
	// 0 and no stdout result event at all, certify the whole stage "success".
	// That directly contradicts the comment above: if stderr is authoritative
	// enough to CERTIFY success, it must also be authoritative enough to
	// TAINT on a discard; if it is not authoritative (the position this
	// comment already takes, correctly), it must not be able to certify
	// success either. `onStderrResultEvent` is a deliberate no-op — stderr
	// stays exactly what the comment above says it is, informational only,
	// never load-bearing for StageOutcome in either direction.
	const onStderrResultEvent = () => {};
	const result = await deps.runSupervised({
		cmd: [
			"claude",
			"-p",
			prompt,
			"--model",
			STAGE_MODEL,
			"--output-format",
			"stream-json",
			"--verbose",
			// Real finding from diagnosing the first two live runs: under
			// --permission-mode acceptEdits, a plain `Bash(echo ...)` call is
			// auto-approved, but `bun run .../inventory.ts` was NOT — denied 3
			// times with "This command requires approval" (no TTY to approve it
			// in headless mode), and the model correctly gave up and reported
			// that rather than looping or fabricating success. There is no
			// human watching a bounded single-stage spawn to approve anything
			// anyway — the external completion check afterward is this
			// architecture's actual trust boundary, not the agent's own tool
			// permissions. Hardcoded rather than made configurable: any other
			// value turns every stage into a silent hang-then-timeout, so
			// there is no useful setting for an operator to choose here.
			"--permission-mode",
			"bypassPermissions",
			// Merges with (does not replace) whatever settings the host already
			// resolves; see stageHookSettings above for why this rides here
			// rather than in agent frontmatter.
			"--settings",
			stageHookSettings(stage.id, deps.repoRoot),
		],
		cwd: deps.repoRoot,
		signal,
		label: `stage-spawn:${stage.id}`,
		// Real, sane fallbacks (not the supervisor's bare module default) — see
		// STAGE_SPAWN_TIMEOUT_MS above. D1: weighted by computeStageSpawnTimeoutMs
		// (client-216-incident fix) rather than the flat constant, same shape as
		// runScript()'s computeScriptRunTimeoutMs below. Env overrides are
		// intentionally explicit for long, real client runs, never an unbounded
		// escape hatch.
		...deadlines(computeStageSpawnTimeoutMs(targetDir), STAGE_SPAWN_IDLE_TIMEOUT_MS),
		onStdoutChunk: resultEventConsumer(`stage-spawn:${stage.id}:stdout`, onResultEvent, onStdoutDiscard),
		onStderrChunk: resultEventConsumer(`stage-spawn:${stage.id}:stderr`, onStderrResultEvent, onStderrDiscard),
	});

	// A clean process exit with no result event at all (e.g. killed mid-turn)
	// is not evidence of success — only an explicit non-error result event,
	// on top of a clean exit, counts.
	if (result.reason !== "exited") {
		const detail = `supervised process ${result.reason}${result.cleanupComplete ? "" : " (cleanup incomplete)"}`;
		console.error(`stage ${stage.id}: ${detail}`);
		return result.cleanupComplete ? { status: "fail", detail } : { status: "cleanup-failed", detail };
	}
	// D/E — a tainted (stdout) discard means the ONE structured signal
	// StageOutcome is built from (see this file's header) may have been thrown
	// away mid-run. We cannot tell, after the fact, whether the discarded line
	// was itself the process's `result` event (and if so, which way `is_error`
	// went) — so we refuse to let a discard-tainted attempt certify "success"
	// from sawSuccessResult/sawErrorResult at all. Forcing "fail" here (rather
	// than, say, silently passing through) means attempt() in logic.ts routes
	// this straight to its normal retry path instead of settle()'s completion
	// check — deliberately, since a completion check only fires on the
	// "success" branch, and letting a merely-plausible success reach it would
	// make the on-disk gate the ONLY thing standing between an actually-failed
	// run and a green status, exactly the silent-false-success direction this
	// fix exists to close.
	//
	// This is now the RARE path, not the common one: since fix E,
	// resultEventConsumer classifies each line from its head and skips
	// (untainted) anything proven to not be a `result` event — no matter how
	// large — instead of buffering it up to a size threshold and hoping. Only
	// a line that cannot be classified (head exhausted, no `type` key found)
	// or a genuinely oversized `result` event itself still reaches
	// onStdoutDiscard, so "the attempt merely printed one long line" no
	// longer pays this cost at all; only a shape this pipeline has never
	// produced, or an actually-too-big result event, does — and it pays with
	// one bounded retry, not a hard stop. (A stderr-side discard never
	// reaches this flag at all — see onStderrDiscard above.)
	if (discardedLine) {
		const detail =
			"a stream-json line was discarded mid-run — its result signal cannot be trusted, so this attempt " +
			"is being forced to fail rather than risk certifying a silent false success";
		console.error(`stage ${stage.id}: ${detail}`);
		return { status: "fail", detail };
	}
	if (result.exitCode === 0 && sawSuccessResult && !sawErrorResult) return { status: "success" };
	return { status: "fail", detail: `exit ${result.exitCode ?? "none"}${sawErrorResult ? ", stage reported an error result" : !sawSuccessResult ? ", no success result event observed" : ""}` };
	};
}

export const spawnStage: StageRunner = createSpawnStage();
