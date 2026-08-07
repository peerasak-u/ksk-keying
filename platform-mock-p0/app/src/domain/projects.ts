import type { Project } from "../types";
import { CUSTOMERS, PROJECTS } from "../state/stores";
import { awaitingGates } from "./work";
import { canReview } from "./people";

export const MONTHS = [
	{ key: "2569-01", label: "มกราคม 2569" },
	{ key: "2569-02", label: "กุมภาพันธ์ 2569" },
	{ key: "2569-03", label: "มีนาคม 2569" },
	{ key: "2569-04", label: "เมษายน 2569" },
	{ key: "2569-05", label: "พฤษภาคม 2569" },
	{ key: "2569-06", label: "มิถุนายน 2569" },
	{ key: "2569-07", label: "กรกฎาคม 2569" },
	{ key: "2569-08", label: "สิงหาคม 2569" },
];

export function customerName(id: string) { return CUSTOMERS[id] ? CUSTOMERS[id].displayName : id; }
export function projectById(id: string): Project | null {
	for (var i = 0; i < PROJECTS.length; i++) if (PROJECTS[i].id === id) return PROJECTS[i];
	return null;
}
export function projectsForCustomer(id: string) {
	return PROJECTS.filter(function (p) { return p.customerId === id; });
}
export function projectsForMonth(monthKey: string) {
	return PROJECTS.filter(function (p) { return p.monthKey === monthKey; });
}

// My work = this user's own live projects, PLUS anything held up on a
// signature they are allowed to give. A reviewer who is not the assignee
// would otherwise have no way to find the Gate waiting on them.
export function projectsForUser(name: string) {
	return PROJECTS.filter(function (p) {
		if (p.assignee === name && p.status === "today") return true;
		// Round 10: not "anything unsigned anywhere" — only the Gates that
		// land on THIS person's rung of THEIR team's ladder. A deputy in
		// ทีมบัญชี 1 has no business being shown ทีมบัญชี 2's queue.
		return canReview(name) && p.assignee !== name && awaitingGates(p).some(function (a) {
			return a.at.name === name;
		});
	});
}
