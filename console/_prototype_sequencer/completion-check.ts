// PROTOTYPE — throwaway. The one real I/O boundary for stage completion: it
// shells out to ACTUAL scripts already shipped in
// .claude/skills/ksk-keying/scripts/ — ledger.ts for the three real Ledger
// Gates, the new stage-shape-check.ts for stages with no gate of their own,
// and the build-review-data.ts -> review-groups.ts pair for categorize.
// Nothing here is simulated or mocked — real scripts, real exit codes.
//
// Generalizes the old real-gate-runner.ts (which only knew how to run
// `ledger --gate <name>`) to dispatch on `stage.gate.kind`. Also the one real
// I/O boundary for the hard-blocker flag (human-stop.yaml).

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { GateResult, GateRunner, HumanStopChecker, HumanStopEntry, StageDef } from "./logic";

const HERE = dirname(new URL(import.meta.url).pathname);
const SCRIPTS_DIR = resolve(HERE, "../../.claude/skills/ksk-keying/scripts");

async function run(args: string[]): Promise<GateResult> {
	const proc = Bun.spawn(["bun", "run", "--cwd", SCRIPTS_DIR, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode: exitCode as 0 | 1 | 2, stdout: (stdout + stderr).trim() };
}

export const runCompletionCheck: GateRunner = async (stage: StageDef, targetDir: string) => {
	const gate = stage.gate;

	if (gate.kind === "ledger") return run(["ledger", "--", "--gate", gate.name, targetDir]);

	if (gate.kind === "shape") return run(["stage-shape-check", "--", "--stage", gate.stage, targetDir]);

	// categorize: build-review-data must pass before review-groups can mean
	// anything — don't bother regenerating HTML from incomplete inputs. Both
	// scripts' output is concatenated so the TUI's "last gate output" panel
	// shows whichever one actually failed.
	const built = await run(["build-review-data", "--", targetDir]);
	if (built.exitCode !== 0) return built;
	const reviewed = await run(["review-groups", "--", "--force", targetDir]);
	return { exitCode: reviewed.exitCode, stdout: `${built.stdout}\n${reviewed.stdout}`.trim() };
};

export const readHumanStop: HumanStopChecker = async (targetDir: string) => {
	const path = resolve(targetDir, "ข้อมูลระบบ", "_pages", "human-stop.yaml");
	if (!existsSync(path)) return [];
	return parseHumanStopEntries(readFileSync(path, "utf8"));
};

// Minimal, hand-rolled parser for this one narrow schema (console/ has no
// "yaml" dependency — see fixture.ts) — a flat entries: list of scalar
// key/value maps. Not a general YAML parser; do not reuse elsewhere.
function parseHumanStopEntries(text: string): HumanStopEntry[] {
	const entries: HumanStopEntry[] = [];
	let current: Partial<HumanStopEntry> | null = null;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trimEnd();
		const itemMatch = line.match(/^\s*-\s+(\w+):\s*(.*)$/);
		const fieldMatch = line.match(/^\s+(\w+):\s*(.*)$/);
		if (itemMatch) {
			if (current) entries.push(finalizeEntry(current));
			current = {};
			setField(current, itemMatch[1], itemMatch[2]);
		} else if (current && fieldMatch) {
			setField(current, fieldMatch[1], fieldMatch[2]);
		}
	}
	if (current) entries.push(finalizeEntry(current));
	return entries;
}

function setField(entry: Partial<HumanStopEntry>, key: string, rawValue: string) {
	const value = unquote(rawValue.trim());
	if (key === "stage" || key === "condition" || key === "reason") (entry as any)[key] = value;
	else if (key === "unit") entry.unit = value === "null" || value === "" ? null : value;
}

function unquote(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
		return value.slice(1, -1);
	return value;
}

function finalizeEntry(partial: Partial<HumanStopEntry>): HumanStopEntry {
	return {
		stage: partial.stage ?? "",
		unit: partial.unit ?? null,
		condition: partial.condition ?? "",
		reason: partial.reason ?? "",
	};
}
