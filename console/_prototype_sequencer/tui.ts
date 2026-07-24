// PROTOTYPE — throwaway. Run: bun run --cwd console proto:sequencer
// See NOTES.md for the question this answers. Delete this whole directory
// (or fold logic.ts into console/engine.ts) once it's answered.

import { readHumanStop, runCompletionCheck } from "./completion-check";
import {
	clearClientProfile,
	clearDispositions,
	clearDocGroupManifest,
	clearGroupCategorize,
	clearGroupInterpretation,
	clearHumanStop,
	clearLinks,
	clearReviewClaims,
	clearSegmentInterpretation,
	clearSegments,
	claimAllUnitsReviewed,
	deleteInventory,
	dispositionAllUnitsUsed,
	FIXTURE_DIR,
	fixtureSummary,
	resetFixture,
	segmentAllUnits,
	writeClientProfile,
	writeDocGroupManifest,
	writeGroupCategorize,
	writeGroupInterpretation,
	writeHumanStopEntry,
	writeInventory,
	writeLinks,
	writeSegmentInterpretation,
} from "./fixture";
import { currentStage, initialState, retryStage, runStage, STAGES, type CompletionCheck, type SequencerDeps, type State } from "./logic";
import { spawnStage } from "./spawn-stage";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;

let state: State = initialState();
let busy = false;

// Three deps bundles, one per "how does the stage actually get run" mode —
// the completion check and human-stop check are always the real ones (that's
// the whole point); only runStageProcess changes. [s]/[f] are free/instant
// for iterating on the state machine itself; [S] costs real tokens/time.
const simSuccessDeps: SequencerDeps = {
	runStageProcess: async () => "success",
	runGate: runCompletionCheck,
	checkHumanStop: readHumanStop,
};
const simFailDeps: SequencerDeps = {
	runStageProcess: async () => "fail",
	runGate: runCompletionCheck,
	checkHumanStop: readHumanStop,
};
const realDeps: SequencerDeps = {
	runStageProcess: spawnStage,
	runGate: runCompletionCheck,
	checkHumanStop: readHumanStop,
};

function statusColor(s: State["status"]): (t: string) => string {
	if (s === "blocked" || s === "env-error" || s === "blocked-for-human") return red;
	if (s === "stopped-for-human") return magenta;
	if (s === "done") return green;
	if (s === "gate-running" || s === "stage-running") return yellow;
	return (t) => t;
}

function checkLabel(check: CompletionCheck): string {
	if (check.kind === "ledger") return `ledger --gate ${check.name}`;
	if (check.kind === "shape") return `stage-shape-check --stage ${check.stage}`;
	return "build-review-data + review-groups --force";
}

function render() {
	process.stdout.write("\x1b[2J\x1b[H"); // clear + home
	const lines: string[] = [];
	lines.push(bold("engine-owned sequencer — prototype (see NOTES.md)"));
	lines.push(dim(`fixture: ${FIXTURE_DIR}`));
	lines.push("");

	lines.push(bold("Pipeline"));
	STAGES.forEach((stage, i) => {
		const passed = i < state.stageIndex || (i === state.stageIndex && state.status === "done");
		const isCurrent = i === state.stageIndex && state.status !== "done";
		const marker = passed ? green("✓") : isCurrent ? yellow("▶") : dim("·");
		const processLabel = stage.spawnsProcess ? "" : dim(" [no process — re-examines earlier stages' output]");
		const gateLabel = dim(`[check: ${checkLabel(stage.gate)}]${processLabel}`);
		const label = isCurrent ? bold(stage.label) : stage.label;
		lines.push(`  ${marker} ${label} ${gateLabel}`);
	});
	lines.push("");

	const color = statusColor(state.status);
	lines.push(
		`${bold("Status:")} ${color(state.status)}  ${dim(`(stage ${state.stageIndex + 1}/${STAGES.length}: ${currentStage(state).id}, retries used: ${state.retryCount})`)}`,
	);
	lines.push("");

	lines.push(bold("Fixture evidence"));
	for (const line of fixtureSummary()) lines.push(`  ${dim(line)}`);
	lines.push("");

	if (state.humanStopEntries.length > 0) {
		lines.push(bold(magenta("human-stop.yaml entries")));
		for (const entry of state.humanStopEntries)
			lines.push(`  ${dim(`${entry.stage} / ${entry.unit ?? "(client-wide)"} — ${entry.condition}: ${entry.reason}`)}`);
		lines.push("");
	}

	if (
		state.lastGateStdout &&
		(state.status === "blocked" || state.status === "env-error" || state.status === "blocked-for-human" || state.status === "done")
	) {
		lines.push(bold("Last completion-check output (tail)"));
		const tail = state.lastGateStdout.split("\n").slice(-10);
		for (const line of tail) lines.push(`  ${dim(line)}`);
		lines.push("");
	}

	lines.push(bold("Log"));
	for (const line of state.log) lines.push(`  ${dim(line)}`);
	if (!state.log.length) lines.push(dim("  (empty)"));
	lines.push("");

	lines.push(bold("Actions"));
	const canAdvance = state.status === "idle" || state.status === "blocked" || state.status === "env-error";
	const shortcuts: string[] = [];
	if (canAdvance) {
		shortcuts.push(`${bold("[s]")} ${dim("run/retry stage (simulated success)")}`);
		shortcuts.push(`${bold("[f]")} ${dim("run/retry stage (simulated FAILURE)")}`);
		shortcuts.push(`${bold("[S]")} ${dim("run/retry stage (REAL claude -p spawn — costs tokens/time)")}`);
	}
	shortcuts.push(`${bold("[g]")} ${dim("write manifest.yaml (segment all units)")}`);
	shortcuts.push(`${bold("[u]")} ${dim("write dispositions.yaml (mark all used)")}`);
	shortcuts.push(`${bold("[c]")} ${dim("write review-data.json (claim all reviewed)")}`);
	shortcuts.push(`${bold("[x]")} ${dim("delete inventory.yaml (force env-error)")}`);
	shortcuts.push(`${bold("[i]")} ${dim("restore inventory.yaml")}`);
	shortcuts.push(`${bold("[z]")} ${dim("clear segments/dispositions/claims (re-block)")}`);
	shortcuts.push(`${bold("[p]")} ${dim("write CLIENT.md + coa.csv (profile evidence)")}`);
	shortcuts.push(`${bold("[P]")} ${dim("clear CLIENT.md + coa.csv")}`);
	shortcuts.push(`${bold("[l]")} ${dim("write seg-01 interpretation + links.draft/links.yaml (link evidence)")}`);
	shortcuts.push(`${bold("[L]")} ${dim("clear link evidence")}`);
	shortcuts.push(`${bold("[d]")} ${dim("write doc-group manifest + g1 interpretation (group evidence)")}`);
	shortcuts.push(`${bold("[D]")} ${dim("clear doc-group evidence")}`);
	shortcuts.push(`${bold("[h]")} ${dim("write human-stop.yaml entry (simulate Decision Policy hard blocker)")}`);
	shortcuts.push(`${bold("[H]")} ${dim("clear human-stop.yaml")}`);
	shortcuts.push(`${bold("[R]")} ${dim("reset sequencer + fixture")}`);
	shortcuts.push(`${bold("[q]")} ${dim("quit")}`);
	for (const s of shortcuts) lines.push(`  ${s}`);

	process.stdout.write(lines.join("\n") + "\n");
}

async function advanceWith(deps: SequencerDeps) {
	if (state.status === "idle") state = await runStage(state, FIXTURE_DIR, deps);
	else if (state.status === "blocked" || state.status === "env-error") state = await retryStage(state, FIXTURE_DIR, deps);
}

async function handle(key: string) {
	if (busy) return;
	if (key === "q" || key === "") {
		process.stdin.setRawMode?.(false);
		process.exit(0);
	}
	busy = true;
	try {
		switch (key) {
			case "s":
				render();
				await advanceWith(simSuccessDeps);
				break;
			case "f":
				render();
				await advanceWith(simFailDeps);
				break;
			case "S":
				render();
				await advanceWith(realDeps);
				break;
			case "g":
				segmentAllUnits();
				break;
			case "u":
				dispositionAllUnitsUsed();
				break;
			case "c":
				claimAllUnitsReviewed();
				break;
			case "x":
				deleteInventory();
				break;
			case "i":
				writeInventory();
				break;
			case "z":
				clearSegments();
				clearDispositions();
				clearReviewClaims();
				break;
			case "p":
				writeClientProfile();
				break;
			case "P":
				clearClientProfile();
				break;
			case "l":
				writeSegmentInterpretation();
				writeLinks();
				break;
			case "L":
				clearSegmentInterpretation();
				clearLinks();
				break;
			case "d":
				writeDocGroupManifest();
				writeGroupInterpretation();
				writeGroupCategorize();
				break;
			case "D":
				clearDocGroupManifest();
				clearGroupInterpretation();
				clearGroupCategorize();
				break;
			case "h":
				writeHumanStopEntry();
				break;
			case "H":
				clearHumanStop();
				break;
			case "R":
				resetFixture();
				state = initialState();
				break;
			default:
				break;
		}
	} finally {
		busy = false;
		render();
	}
}

resetFixture();
render();

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	void handle(chunk.toString());
});
