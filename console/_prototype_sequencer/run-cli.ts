// PROTOTYPE — throwaway. Non-interactive driver: runs the sequencer against
// a REAL target directory end-to-end using real claude -p spawns
// (spawn-stage.ts) and real completion checks (completion-check.ts) — no
// TUI, no keypresses. For scripted/background verification runs against a
// real samples/ client, per NOTES.md's deferred "does a real client produce
// the same shape" check.
//
// Usage: bun run run-cli.ts <target-dir>
//
// Retries within each stage's bounded budget happen automatically (same
// policy as the TUI's [S] key would apply one keypress at a time); this just
// drives the loop without a human at the keyboard. Exits 0 on "done", 1
// otherwise (stopped-for-human / blocked-for-human / safety cap hit).

import { readHumanStop, runCompletionCheck } from "./completion-check";
import { currentStage, initialState, retryStage, runStage, STAGES, type SequencerDeps, type State } from "./logic";
import { spawnStage } from "./spawn-stage";

const realDeps: SequencerDeps = {
	runStageProcess: spawnStage,
	runGate: runCompletionCheck,
	checkHumanStop: readHumanStop,
};

const TERMINAL: State["status"][] = ["done", "stopped-for-human", "blocked-for-human"];
// Well above the ~7 stages * (1 initial attempt + up to 2 retries) a real run
// could legitimately need — this is a hang/infinite-loop backstop, not a
// business-logic cap.
const MAX_ITERATIONS = 40;

function ts(): string {
	return new Date().toISOString();
}

async function main() {
	const targetDir = process.argv[2];
	if (!targetDir) {
		console.error("Usage: bun run run-cli.ts <target-dir>");
		process.exit(2);
	}

	let state: State = initialState();
	console.log(`[${ts()}] starting real end-to-end run against ${targetDir}`);

	let iterations = 0;
	while (!TERMINAL.includes(state.status)) {
		iterations++;
		if (iterations > MAX_ITERATIONS) {
			console.error(`[${ts()}] safety cap of ${MAX_ITERATIONS} iterations hit — aborting`);
			process.exit(2);
		}
		const stage = currentStage(state);
		console.log(`[${ts()}] stage ${stage.id} (status ${state.status}, retries used ${state.retryCount}) — invoking...`);

		if (state.status === "idle") state = await runStage(state, targetDir, realDeps);
		else if (state.status === "blocked" || state.status === "env-error") state = await retryStage(state, targetDir, realDeps);
		else break; // unreachable — no other non-terminal status exists between actions

		console.log(`[${ts()}]   -> status ${state.status}`);
		for (const line of state.log.slice(-3)) console.log(`      ${line}`);
	}

	console.log(`\n[${ts()}] FINISHED — final status: ${state.status}`);
	console.log(`stage reached: ${currentStage(state).id} (index ${state.stageIndex}/${STAGES.length - 1})`);
	if (state.humanStopEntries.length) {
		console.log("human-stop entries:");
		for (const e of state.humanStopEntries) console.log(`  - ${e.stage}/${e.unit ?? "(client-wide)"} — ${e.condition}: ${e.reason}`);
	}
	if (state.lastGateStdout) {
		console.log("last completion-check output:");
		console.log(state.lastGateStdout);
	}
	process.exit(state.status === "done" ? 0 : 1);
}

main();
