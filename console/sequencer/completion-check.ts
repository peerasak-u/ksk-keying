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
import { runSupervisedProcess } from "./process-supervisor";

const HERE = dirname(new URL(import.meta.url).pathname);
// On a bare-host run, console/ sits inside the full repo checkout, so two
// levels up from HERE lands on the repo root and this guess is correct. In
// the ksk-app Docker image only console/'s own contents get copied to /app,
// so the same guess lands on "/" instead — the real scripts are bind-mounted
// at $KSK_WORKSPACE_ROOT/.claude/skills/... there (see docker-compose.yml's
// KSK_APP_SKILLS_HOST), hence the fallback.
const HOST_GUESS = resolve(HERE, "../../.claude/skills/ksk-keying/scripts");
const CONTAINER_GUESS = process.env.KSK_WORKSPACE_ROOT
	? resolve(process.env.KSK_WORKSPACE_ROOT, ".claude/skills/ksk-keying/scripts")
	: null;
const SCRIPTS_DIR = existsSync(HOST_GUESS) ? HOST_GUESS : CONTAINER_GUESS ?? HOST_GUESS;

function envDuration(name: string): number | undefined {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

async function run(args: string[], signal?: AbortSignal): Promise<GateResult> {
	const result = await runSupervisedProcess({
		cmd: ["bun", "run", "--cwd", SCRIPTS_DIR, ...args],
		signal,
		timeoutMs: envDuration("KSK_GATE_TIMEOUT_MS") ?? 10 * 60 * 1_000,
		idleTimeoutMs: envDuration("KSK_GATE_IDLE_TIMEOUT_MS") ?? 60 * 1_000,
		maxOutputBytes: envDuration("KSK_PROCESS_MAX_OUTPUT_BYTES"),
	});
	const output = (result.stdout + result.stderr).trim();
	if (result.reason !== "exited") {
		return {
			exitCode: 2,
			stdout: `${output}${output ? "\n" : ""}[process-supervisor] ${result.reason}${result.cleanupComplete ? "" : "; cleanup incomplete"}`,
			cleanupFailed: !result.cleanupComplete,
		};
	}
	return {
		exitCode: result.exitCode === 0 || result.exitCode === 1 ? result.exitCode : 2,
		stdout: output,
		cleanupFailed: !result.cleanupComplete,
	};
}

export const runCompletionCheck: GateRunner = async (stage: StageDef, targetDir: string, signal?: AbortSignal) => {
	const gate = stage.gate;

	if (gate.kind === "ledger") return run(["ledger", "--", "--gate", gate.name, targetDir], signal);

	if (gate.kind === "shape") return run(["stage-shape-check", "--", "--stage", gate.stage, targetDir], signal);

	// categorize: build-review-data must pass before review-groups can mean
	// anything — don't bother regenerating HTML from incomplete inputs. Both
	// scripts' output is concatenated so the TUI's "last gate output" panel
	// shows whichever one actually failed.
	const built = await run(["build-review-data", "--", targetDir], signal);
	if (built.exitCode !== 0 || built.cleanupFailed) return built;
	const reviewed = await run(["review-groups", "--", "--force", targetDir], signal);
	return {
		exitCode: reviewed.exitCode,
		stdout: `${built.stdout}\n${reviewed.stdout}`.trim(),
		cleanupFailed: reviewed.cleanupFailed,
	};
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
