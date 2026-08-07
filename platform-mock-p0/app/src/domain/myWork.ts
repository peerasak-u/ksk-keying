// ================= งานของฉัน (rebuilt in round 27) =================
//
// The phase-0 principle is unchanged: only this person's own work, plus the
// Gates that land on their rung of their team's ladder. What changed is that
// the screen now says how the day FEELS, not just how many cards there are —
// two flat lists of identical cards could only ever say the second.
//
// Everything is derived per render from the signed-in user, so switching
// demo users genuinely changes every number on the screen.
import type { Project } from "../types";
import { canReview } from "./people";
import { projectsForUser } from "./projects";
import { nextDueFor } from "./due";
import { projectLate } from "./trail";
import {
	STATUS_DOING,
	awaitingGates,
	ensureWork,
	gateClosed,
	isAwaitingReview,
	projectFinished,
} from "./work";

export interface MyWorkLanes { mine: Project[]; theirs: Project[]; ownOpen: Project[] }

// Which lane a project belongs in, for THIS user. Note the reviewer case:
// a Gate waiting for a signature this person is allowed to give is work
// waiting on THEM, so it belongs on the left. Until round 27 those sat in
// รอสอบทาน together with the person's own finished work, which conflated
// "I am blocked" with "somebody is blocked on me".
export function myWorkLanes(name: string): MyWorkLanes {
	var all = projectsForUser(name);
	var mine: Project[] = [], theirs: Project[] = [];
	all.forEach(function (p) {
		if (projectFinished(p)) return;
		if (iCanSignOffAs(p, name)) mine.push(p);
		else if (isAwaitingReview(p) && p.assignee === name) theirs.push(p);
		else if (p.assignee === name) mine.push(p);
	});
	mine.sort(function (a, b) {
		// A signature somebody else is waiting on comes first: it is the
		// shortest job on the screen and it unblocks another person.
		var sa = iCanSignOffAs(a, name) ? 0 : 1, sb = iCanSignOffAs(b, name) ? 0 : 1;
		if (sa !== sb) return sa - sb;
		if (projectLate(a) !== projectLate(b)) return projectLate(a) ? -1 : 1;
		var da = nextDueFor(a), db = nextDueFor(b);
		return (da ? da.days : 9999) - (db ? db.days : 9999);
	});
	theirs.sort(function (a, b) { return (projectLate(a) ? 0 : 1) - (projectLate(b) ? 0 : 1); });
	return { mine: mine, theirs: theirs, ownOpen: all.filter(function (p) {
		return p.assignee === name && !projectFinished(p);
	}) };
}

// iCanSignOff() asks about the signed-in user; this is the same question for
// any name, so the lane split and the sort can both use it.
export function iCanSignOffAs(p: Project, name: string | null) {
	return !!name && canReview(name) && awaitingGates(p).some(function (a) {
		return a.rec.doer !== name && a.at.name === name;
	});
}

// What state a งวด is in right now, in words, read off the current Phase's
// own records. This is what lets a card say "I have not started this" as
// opposed to "I am half way through it" without a status field for it.
export function myWorkState(p: Project, name: string): { text: string; cls: string } {
	if (iCanSignOffAs(p, name)) {
		var a = awaitingGates(p).filter(function (x) { return x.at.name === name && x.rec.doer !== name; });
		return { text: "รอคุณเซ็นสอบทาน " + a.length + " เกท", cls: "pill-attention" };
	}
	if (isAwaitingReview(p)) return { text: "เสร็จแล้ว รอเซ็น", cls: "pill-blocked" };
	var work = ensureWork(p)[p.phaseIndex];
	var doing = work.filter(function (r) { return r.status === STATUS_DOING; }).length;
	var closed = work.filter(gateClosed).length;
	if (doing) return { text: "กำลังทำอยู่ " + doing + " เกท", cls: "pill-doing" };
	if (!closed) return { text: "ยังไม่ได้เริ่มเฟสนี้", cls: "pill-passed" };
	return { text: "ค้างไว้ — ยังไม่มีเกทไหนกำลังทำ", cls: "pill-passed" };
}

// "Is this a lot?" needs something honest to compare against, and the two
// easy answers are both wrong: comparing this person to other people is a
// ranking, and comparing them to a target is an invented number. What the
// work itself implies is neither — a customer normally has exactly ONE open
// งวด (last month's, worked this month), so a second open งวด on the same
// customer means last month's never closed. Same rule projectLate() already
// uses, counted per customer.
//
// It is only shown when it can mean something: with one or two customers a
// "1 / 2" ratio says nothing and would only mislead, so nothing is printed.
export function myWorkBacklog(open: Project[]) {
	var by: Record<string, Project[]> = {};
	open.forEach(function (p) { (by[p.customerId] = by[p.customerId] || []).push(p); });
	var ids = Object.keys(by);
	var stacked = ids.filter(function (id) { return by[id].length > 1; }).length;
	return { customers: ids.length, stacked: stacked, meaningful: ids.length >= 3 && stacked > 0 };
}
