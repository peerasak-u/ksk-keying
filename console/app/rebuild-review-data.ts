// The cheap "re-assemble the review data" action behind the dashboard's
// per-month menu — no agent, no LLM, no queue slot. It re-runs the shipped
// build-review-data.ts -> review-groups.ts pair for one client-month, which
// is exactly what sequencer/completion-check.ts already runs as the
// categorize stage's completion check, so this reuses runCompletionCheck
// rather than growing a second spawn site for the same two scripts.
//
// Deliberately NOT orchestrator.repairRun: that resets the run to Stage 1 and
// re-reads every document with an agent (orchestrator.ts's repairRun ->
// stageIndex of "segment"). This one only re-derives review-data.json from
// interpretation.json + categorize.json already on disk — since
// build-review-data now merges a reviewer's saved edits forward instead of
// skipping already-built groups, it is safe to press often, which is the
// whole point of putting it a click away.
//
// summarizeRebuild is the pure core (the scripts' stdout -> counts a human
// can read); runRebuildReviewData is the thin I/O wrapper, matching this
// directory's pure-core-plus-wrapper convention.
import { runCompletionCheck } from "../sequencer/completion-check";
import { STAGES, type StageDef } from "../sequencer/logic";

export type RebuildSummary = {
	/** Groups whose review-data.json was written this run. */
	built: number;
	/** Human edits the merge carried across the rebuild. */
	carried: number;
	/** Groups that lost at least one edit (dropped / degraded / bailed). */
	lostGroups: number;
	/** Groups left unbuilt because interpretation/categorize is missing. */
	skippedGroups: number;
	/** One Thai line for the operator — the only string the UI shows. */
	message: string;
};

/** build-review-data.ts's own stdout lines (see its main()):
 *   "built N review-data.json file(s)"
 *   "carried forward N human edit(s)"            — only when N > 0
 *   "⚠ N group(s) had review edits dropped ..."  — only when N > 0
 *   "skipped N group(s) with missing inputs:"    — only when N > 0
 * Anything it doesn't recognise counts as zero rather than throwing: this
 * summary is a convenience on top of the run, never the thing that decides
 * whether the run succeeded — that's the exit code. */
export function summarizeRebuild(stdout: string): RebuildSummary {
	const num = (re: RegExp): number => {
		const m = stdout.match(re);
		const n = m ? Number(m[1]) : 0;
		return Number.isFinite(n) ? n : 0;
	};
	const built = num(/built (\d+) review-data\.json file/);
	const carried = num(/carried forward (\d+) human edit/);
	const lostGroups = num(/⚠ (\d+) group\(s\) had review edits/);
	const skippedGroups = num(/skipped (\d+) group\(s\) with missing inputs/);

	const parts = [`สร้างข้อมูลรีวิวใหม่ ${built} กลุ่ม`];
	if (carried > 0) parts.push(`ยกรายการที่แก้ไว้มา ${carried} รายการ`);
	if (lostGroups > 0) parts.push(`⚠ ${lostGroups} กลุ่มมีรายการที่แก้ไว้ถูกทับ (ดู dropped-edits.json)`);
	if (skippedGroups > 0) parts.push(`ข้าม ${skippedGroups} กลุ่มเพราะข้อมูลยังไม่ครบ`);
	return { built, carried, lostGroups, skippedGroups, message: parts.join(" · ") };
}

export type RebuildResult =
	| { ok: true; summary: RebuildSummary; output: string }
	| { ok: false; error: string; output: string };

const CATEGORIZE_STAGE: StageDef = STAGES.find((s) => s.gate.kind === "categorize")!;

/** Runs the pair against one client-month directory. Exit 1 means some group
 * had missing inputs (a real, actionable state — the reviewer needs the
 * populate/categorize stage re-run, which is repairRun's job, not this
 * action's), exit 2 means malformed input. Both surface as ok:false with the
 * scripts' own output, which already names the offending groups. */
export async function runRebuildReviewData(targetDir: string): Promise<RebuildResult> {
	const result = await runCompletionCheck(CATEGORIZE_STAGE, targetDir);
	// A cleanup we could not prove complete means a descendant of these scripts
	// is still running. Surface it plainly instead of hiding it behind the
	// generic failure string — pressing the button again would stack another
	// leak on a box that is already in the state the fatal latch exists for.
	if (result.cleanupFailed) {
		console.error(`rebuild-review-data: cleanup unproven for ${targetDir} — a spawned process may still be running`);
		return {
			ok: false,
			error: "หยุดเพื่อความปลอดภัย: เก็บ process ที่รันไม่สำเร็จ กรุณา restart app/container ก่อนลองใหม่",
			output: result.stdout,
		};
	}
	if (result.exitCode !== 0) {
		const summary = summarizeRebuild(result.stdout);
		const error =
			summary.skippedGroups > 0
				? `ข้อมูลยังไม่ครบ ${summary.skippedGroups} กลุ่ม — ต้องรันขั้น populate/categorize ใหม่ก่อน`
				: "สร้างข้อมูลรีวิวใหม่ไม่สำเร็จ";
		return { ok: false, error, output: result.stdout };
	}
	return { ok: true, summary: summarizeRebuild(result.stdout), output: result.stdout };
}
