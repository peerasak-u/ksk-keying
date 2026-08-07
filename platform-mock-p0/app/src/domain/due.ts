// ---- filings and other Gates coming due, from the templates' own rules ----
// Only Gates that are still open, on projects that are still open, and only
// in Phases the project can plausibly be working — a rule three Phases away
// is not a deadline anybody can act on today.
import type { Gate, Project } from "../types";
import { daysUntil } from "./dates";
import { gateDueDate, jobTypeByKey } from "./jobTypes";
import { ensureWork, gateClosed, projectFinished } from "./work";

export interface DueItem { p: Project; pi: number; gi: number; gate: Gate; date: Date; days: number }

export function dueItems(projects: Project[], withinDays: number): DueItem[] {
	var out: DueItem[] = [];
	projects.forEach(function (p) {
		if (projectFinished(p)) return;
		var jt = jobTypeByKey(p.jobType)!;
		ensureWork(p).forEach(function (recs, pi) {
			if (pi > p.phaseIndex + 1) return;
			recs.forEach(function (rec, gi) {
				var g = jt.phases[pi].gates[gi];
				if (!g.due || gateClosed(rec)) return;
				var d = gateDueDate(p, g);
				if (!d) return;
				var days = daysUntil(d);
				// A window, not a backlog: what falls due in the next N
				// days, plus what has only just gone past. Anything long
				// overdue belongs to a งวด that is already sitting in
				// section 1 (ล่าช้า) and does not need saying twice.
				if (days > withinDays || days < -withinDays) return;
				out.push({ p: p, pi: pi, gi: gi, gate: g, date: d, days: days });
			});
		});
	});
	return out.sort(function (a, b) { return a.days - b.days; });
}

/** The nearest Gate deadline still open on a งวด. */
export function nextDueFor(p: Project): DueItem | null {
	var items = dueItems([p], 400);
	return items.length ? items[0] : null;
}

/** The office has 113 customers, so every list shows a sensible first slice. */
export const LIST_CAP = 6;
