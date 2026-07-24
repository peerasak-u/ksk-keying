// Real per-stage `claude -p` spawn: one bounded,
// fresh-context headless invocation of `/ksk-stage-<id>`, per the R&D
// decision that each ksk-stage-* skill becomes a standalone entry point —
// the actual fix for context bloat, since no single session accumulates all
// 6 stages anymore.
//
// StageOutcome ("success" | "fail") is decided from the stream-json
// protocol's OWN structured result event (`is_error`) plus the process exit
// code — never by regexing the assistant's prose, unlike
// console/engine.ts's existing GATE_RE/UNFINISHED_RE. Whether the STAGE
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

import { dirname, resolve } from "node:path";
import type { StageAttemptContext, StageDef, StageRunner } from "./logic";

const HERE = dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = resolve(HERE, "../..");

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

// Distinct from console/engine.ts's HEADLESS_DIRECTIVE (which is about not
// abandoning IN-FLIGHT BACKGROUND WAVES within one long multi-stage
// session). This one is about a DIFFERENT failure mode specific to
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

async function consumeResultEvents(
	stream: ReadableStream<Uint8Array>,
	onResultEvent: (evt: any) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let idx: number;
		while ((idx = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 1);
			if (!line.trim()) continue;
			const evt = parseLine(line);
			if (evt?.type === "result") onResultEvent(evt);
		}
	}
}

export const spawnStage: StageRunner = async (stage, targetDir, context) => {
	const prompt = buildPrompt(stage, targetDir, context);
	const proc = Bun.spawn(
		[
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
			// permissions. console/.env.example already documents
			// KSK_PERMISSION_MODE=bypassPermissions as the real-unattended-run
			// setting for the exact same reason; this uses the same setting.
			"--permission-mode",
			"bypassPermissions",
		],
		{ cwd: REPO_ROOT, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);

	let sawSuccessResult = false;
	let sawErrorResult = false;
	const onResultEvent = (evt: any) => {
		if (evt.is_error) sawErrorResult = true;
		else sawSuccessResult = true;
	};

	await Promise.all([
		consumeResultEvents(proc.stdout, onResultEvent),
		consumeResultEvents(proc.stderr, onResultEvent),
		proc.exited,
	]);
	const exitCode = await proc.exited;

	// A clean process exit with no result event at all (e.g. killed mid-turn)
	// is not evidence of success — only an explicit non-error result event,
	// on top of a clean exit, counts.
	return exitCode === 0 && sawSuccessResult && !sawErrorResult ? "success" : "fail";
};
