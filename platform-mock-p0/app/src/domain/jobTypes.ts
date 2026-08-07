import type { JobType, Phase, PhaseWorkflowAttachment, Project } from "../types";
import { periodParts } from "./dates";
import { JOB_TYPES } from "../state/stores";
import { workflowByKey } from "../data/workflows";

export function jobTypeByKey(key: string): JobType | null {
	for (var i = 0; i < JOB_TYPES.length; i++) if (JOB_TYPES[i].key === key) return JOB_TYPES[i];
	return null;
}
// Phase NAME strings only, for the stepper/phase-label — kept separate
// from the Phase objects (which also carry the Gate template) so
// buildStepper() doesn't need to know about Gates at all.
export function phaseNames(jobType: JobType) { return jobType.phases.map(function (p: Phase) { return p.name; }); }

export function phaseWorkflows(p: Project, pi: number): PhaseWorkflowAttachment[] {
	var ph = jobTypeByKey(p.jobType)!.phases[pi];
	return (ph.workflows || []).filter(function (a: PhaseWorkflowAttachment) { return !!workflowByKey(a.key); });
}
// Every attachment on this Phase whose evidence list names this Gate.
export function gateEvidenceFrom(p: Project, pi: number, gateCode: string) {
	return phaseWorkflows(p, pi).filter(function (a: PhaseWorkflowAttachment) { return (a.evidence || []).indexOf(gateCode) !== -1; });
}

// The rule itself, in words — shown next to the derived date everywhere,
// so nobody has to trust a bare calendar date they cannot check.
export function dueRuleText(due: any) {
	if (!due) return "";
	if (typeof due.dayOfMonth === "number") {
		var off = due.monthOffset || 0;
		var whichMonth = off === 0 ? "ของเดือนงวด" : off === 1 ? "ของเดือนถัดจากงวด" : "ของเดือนที่ " + off + " หลังงวด";
		return "วันที่ " + due.dayOfMonth + " " + whichMonth;
	}
	if (typeof due.offsetDays === "number") return "ภายใน " + due.offsetDays + " วันนับจากวันเปิดงวด";
	return "";
}

// Round 16: once a period can actually be OPENED, the real opening date is
// the thing the "ภายใน N วันนับจากวันเปิดงวด" rules have to measure from —
// a งวด opened late, or opened early, moves those deadlines with it. The
// derived first-of-the-following-month is now only the fallback, for the
// pre-seeded demo projects that were never opened through the schedule.
// The dayOfMonth rules are deliberately NOT moved: a filing deadline is
// fixed by the งวด itself, not by when the office got round to it.
export function projectOpenedAt(p: Project): Date {
	if (p.openedOn) return p.openedOn;
	var q = periodParts(p.monthKey);
	return new Date(q.y, q.m + 1, 1);
}
export function gateDueDate(p: Project, g: any): Date | null {
	if (!g || !g.due) return null;
	if (typeof g.due.dayOfMonth === "number") {
		var q = periodParts(p.monthKey);
		return new Date(q.y, q.m + (g.due.monthOffset || 0), g.due.dayOfMonth);
	}
	if (typeof g.due.offsetDays === "number") {
		var o = projectOpenedAt(p);
		return new Date(o.getFullYear(), o.getMonth(), o.getDate() + g.due.offsetDays);
	}
	return null;
}
