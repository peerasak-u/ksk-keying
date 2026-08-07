// ---- the run's items, flattened and filtered. One item = one doc group,
// which is the unit the pipeline's own review page steps through.
//
// Everything in here is a pure read over the run's own result plus the
// module-level selections in `ui` — the same globals the legacy mock kept as
// plain `var`s so a filter survived walking away from the screen and back.
import type { CoaRow, Project, RunBucket, RunExclusion, RunGroup, WorkflowRun, WorkflowRunData } from "../../types";
import { WF_COA_BANK, WF_COA_EXPENSE, WF_COA_INCOME } from "../../data/runTables";
import { wfRunData } from "../../domain/runData";
import { projectById } from "../../domain/projects";
import { getRunNo } from "../../domain/runs";
import { ui } from "../../state/ui";

/** The four route params, already parsed — the legacy `currentPageArgs`. */
export interface RunArgs {
	id: string;
	pi: number;
	key: string;
	no: number;
}

export interface RunCtx {
	p: Project;
	run: WorkflowRun;
	d: WorkflowRunData;
	args: RunArgs;
}

export interface RunItem {
	bucket: RunBucket;
	g: RunGroup;
}

export function runCurrentData(args: RunArgs): RunCtx | null {
	var p = projectById(args.id);
	var run = getRunNo(args.id, args.pi, args.key, args.no);
	if (!p || !run || run.state !== "done") return null;
	return { p: p, run: run, d: wfRunData(p, run), args: args };
}

// How many proposed exclusions still have nobody's decision on them. This
// is the "N รอตัดสินใจ" the real page badges in its own navbar.
export function runPendingExcluded(d: WorkflowRunData) {
	return d.excluded.filter(function (e) { return !e.decision; }).length;
}

export function runExcludedVisible(d: WorkflowRunData): RunExclusion[] {
	return d.excluded.filter(function (e) { return ui.runExFilter === "all" || e.reason === ui.runExFilter; });
}

export function runCurrentExcluded(d: WorkflowRunData): RunExclusion | null {
	var list = runExcludedVisible(d);
	if (!list.length) return null;
	if (ui.runExIndex >= list.length) ui.runExIndex = list.length - 1;
	if (ui.runExIndex < 0) ui.runExIndex = 0;
	return list[ui.runExIndex];
}

export function runItems(d: WorkflowRunData): RunItem[] {
	var out: RunItem[] = [];
	d.buckets.forEach(function (b) {
		if (ui.runFilterBucket !== "all" && ui.runFilterBucket !== b.key) return;
		b.groups.forEach(function (g) {
			if (ui.runFilterAttention && g.status !== "needs_attention") return;
			out.push({ bucket: b, g: g });
		});
	});
	return out;
}

export function runCurrentItem(c: RunCtx | null): RunItem | null {
	if (!c) return null;
	var items = runItems(c.d);
	if (!items.length) return null;
	if (ui.runItemIndex >= items.length) ui.runItemIndex = items.length - 1;
	if (ui.runItemIndex < 0) ui.runItemIndex = 0;
	return items[ui.runItemIndex];
}

export function runCoaFor(bucketKey: string): CoaRow[] {
	return bucketKey === "bank_statement" ? WF_COA_BANK
		: bucketKey.indexOf("income") === 0 ? WF_COA_INCOME : WF_COA_EXPENSE;
}
