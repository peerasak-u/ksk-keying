// The one real I/O boundary for stage completion: it shells out to ACTUAL
// scripts already shipped in .claude/skills/ksk-keying/scripts/ — ledger.ts
// for the three real Ledger Gates, stage-shape-check.ts for stages with no
// gate of their own, and the build-review-data.ts -> review-groups.ts pair
// for categorize. Nothing here is simulated or mocked — real scripts, real
// exit codes. Also the one real I/O boundary for the hard-blocker flag
// (human-stop.yaml).

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as yamlParse } from "yaml";
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

// Real YAML parsing now that console/ depends on "yaml" (added alongside
// this promotion) — replaces the prototype's hand-rolled scalar-only regex
// parser, which couldn't safely handle a `reason:` containing a colon or
// quote. Defensive field defaults still apply: an agent hand-writes this
// file per decision-policy.md's example, not through a shared serializer.
function parseHumanStopEntries(text: string): HumanStopEntry[] {
	const doc = yamlParse(text);
	const rawEntries = Array.isArray(doc?.entries) ? doc.entries : [];
	return rawEntries.map(
		(e: any): HumanStopEntry => ({
			stage: typeof e?.stage === "string" ? e.stage : "",
			unit: typeof e?.unit === "string" ? e.unit : null,
			condition: typeof e?.condition === "string" ? e.condition : "",
			reason: typeof e?.reason === "string" ? e.reason : "",
		}),
	);
}
