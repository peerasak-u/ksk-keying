// ================= the month board, rebuilt in round 28c (แบบ ค) ==========
//
// The screen was called ปฏิทินงานประจำเดือน and there was no calendar in it:
// a month switcher with three stacked lists under it. It is now a calendar
// with every empty day deleted — one spine, ordered by time, carrying only
// the days that actually hold a Gate deadline, with today's line in its true
// position.
//
// Three things decide the shape:
//
//   1. A งวด is worked in the month AFTER it closes. Every date gateDueDate()
//      produces for งวดกรกฎาคม therefore falls in สิงหาคม, and the line under
//      the switcher says so.
//   2. Most days are empty and one is not. A 31-cell grid would spend most of
//      a screen saying nothing; a spine spends none of it.
//   3. Not everything HAS a date, so those get stations of their own rather
//      than being dropped — and because the four kinds of station partition
//      projectsForMonth() exactly, the spine can be the whole screen.
import type { Gate, Project } from "../../types";
import { THAI_MONTHS, periodParts } from "../../domain/dates";
import { dueItems, type DueItem } from "../../domain/due";
import { projectsForMonth } from "../../domain/projects";
import { projectFinished } from "../../domain/work";

export const MB_DOW_LONG = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
// How far either side of today the board looks for deadlines. Wide enough to
// take any month the switcher can reach.
export const MB_WINDOW = 400;
export function mbMidnight(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

/** The month a งวด is actually worked in, named. */
export function workMonthLabel(monthKey: string) {
	var q = periodParts(monthKey);
	var d = new Date(q.y, q.m + 1, 1);
	return THAI_MONTHS[d.getMonth()] + " " + (d.getFullYear() + 543);
}

export interface MonthBoardData {
	month: { key: string; label: string };
	all: Project[]; open: Project[]; items: DueItem[];
	byDay: Record<number, DueItem[]>; days: number[];
	onLine: Project[]; undated: Project[]; closed: Project[];
}

// One pass over the month, so the figure and the spine can never disagree
// about what is in it: every open งวด is in exactly one of `dated` and
// `undated`, and every project of the month is in one of those two or `closed`.
export function monthBoardData(month: { key: string; label: string }): MonthBoardData {
	var all = projectsForMonth(month.key);
	var open = all.filter(function (p) { return !projectFinished(p); });
	var items = dueItems(open, MB_WINDOW);
	var byDay: Record<number, DueItem[]> = {}, dated: Record<string, boolean> = {};
	items.forEach(function (it) {
		dated[it.p.id] = true;
		var k = mbMidnight(it.date).getTime();
		(byDay[k] = byDay[k] || []).push(it);
	});
	return {
		month: month, all: all, open: open, items: items, byDay: byDay,
		days: Object.keys(byDay).map(Number).sort(function (a, b) { return a - b; }),
		onLine: open.filter(function (p) { return dated[p.id]; }),
		undated: open.filter(function (p) { return !dated[p.id]; }),
		closed: all.filter(projectFinished),
	};
}

/** The งวด that have something due on one day, de-duplicated. */
export function mbProjectsOn(items: DueItem[]) {
	var seen: Record<string, boolean> = {}, out: Project[] = [];
	items.forEach(function (it) { if (!seen[it.p.id]) { seen[it.p.id] = true; out.push(it.p); } });
	return out;
}

// What is due on a day, grouped by the Gate itself rather than by job type —
// กลุ่มรายเดือน 3.4 and กลุ่มรายปี 3.4 are the same form on the same deadline.
export function mbGateGroups(items: DueItem[]) {
	var map: Record<string, { gate: Gate; n: number }> = {}, order: string[] = [];
	items.forEach(function (it) {
		if (!map[it.gate.name]) { map[it.gate.name] = { gate: it.gate, n: 0 }; order.push(it.gate.name); }
		map[it.gate.name].n++;
	});
	return order.map(function (k) { return map[k]; }).sort(function (a, b) { return b.n - a.n; });
}

// A Gate name is a whole sentence and a station's summary line is one line, so
// this cuts at the first clause break for display only. Nothing is renamed.
export function mbGateShort(g: Gate) {
	var s = String(g.name).split(" — ")[0].split(" (")[0].split(" + ")[0].replace(/^จัดทำ\s*/, "");
	return s.length > 22 ? s.slice(0, 21) + "…" : s;
}
