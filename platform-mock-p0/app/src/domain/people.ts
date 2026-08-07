import type { PositionKey, Reviewer, Structure, Team } from "../types";
import { POSITIONS, POSITION_ORDER, REVIEW_LADDER } from "../data/office";
import { LIVE_STRUCTURE, TEAMS, USERS } from "../state/stores";

// Round 17: people can be added, moved and re-ranked at runtime through the
// "พนักงานและทีม" screen, so the roster is read live instead of being
// snapshotted once at load — a name captured in a var here would go stale
// the first time somebody joins.
export function allUserNames() { return Object.keys(USERS); }

export function teamByKey(key: string | null): Team | null {
	for (var i = 0; i < TEAMS.length; i++) if (TEAMS[i].key === key) return TEAMS[i];
	return null;
}
export function teamName(key: string | null) { var t = teamByKey(key); return t ? t.name : "—"; }
export function positionOf(name: string): PositionKey | null { return USERS[name] ? USERS[name].position : null; }
export function positionLabel(name: string) { var p = positionOf(name); return p ? POSITIONS[p].label : "—"; }
export function teamOf(name: string): string | null { return USERS[name] ? USERS[name].team : null; }
export function personCaption(name: string) {
	return positionLabel(name) + " · " + teamName(teamOf(name));
}
// Everybody a team can hand work to, leader and deputy included — the
// leaders carry customers of their own in this office, they are not
// managers-only.
export function membersOf(teamKey: string | null) {
	return allUserNames().filter(function (n) { return USERS[n].team === teamKey; });
}
// The same list, ordered by rung — the order the office itself reads a
// team in, and the order the people screen lists them in.
export function membersOfByRung(teamKey: string | null) {
	return membersOf(teamKey).slice().sort(function (a, b) {
		var d = POSITION_ORDER.indexOf(USERS[b].position) - POSITION_ORDER.indexOf(USERS[a].position);
		return d !== 0 ? d : a.localeCompare(b, "th");
	});
}
export function canReview(name: string) { return !!(USERS[name] && POSITIONS[USERS[name].position].canReview); }
export function canSeeOffice(name: string) { return !!(USERS[name] && POSITIONS[USERS[name].position].canSeeOffice); }
export function canEditTemplates(name: string) { return !!(USERS[name] && POSITIONS[USERS[name].position].canEditPermissions); }

// Who a finished Gate lands on. The ladder starts at the rung the Gate
// itself demands (default รองหัวหน้าทีม) and climbs until it finds
// somebody who exists on that team and is not the person who did the
// work — the office's own rule, since a reviewer cannot review themselves.
// Team 3 has no deputy, so its work lands on its หัวหน้า directly, and the
// หัวหน้า's own work climbs to the COO. Nothing is stored: this is derived
// every time, so moving a project to another team moves its reviewer too.
//
// Round 17: the ladder is computed against a STRUCTURE rather than against
// the globals directly, so the พนักงานและทีม screen can ask "if I moved this
// person, whose queue would their Gates land in?" by running exactly the
// same function over a shadow copy — the answer it shows can never be a
// second, hand-written guess at the real rule.
export function ctxTeam(ctx: Structure, key: string | null): Team | null {
	for (var i = 0; i < ctx.teams.length; i++) if (ctx.teams[i].key === key) return ctx.teams[i];
	return null;
}
// Who the COO is, derived from the roster rather than pinned in a variable
// — so promoting somebody to that rung on the people screen genuinely moves
// the top of every team's ladder.
export function cooNameIn(ctx: Structure): string | null {
	var names = Object.keys(ctx.users);
	for (var i = 0; i < names.length; i++) if (ctx.users[names[i]].position === "coo") return names[i];
	return null;
}
export function cooName() { return cooNameIn(LIVE_STRUCTURE); }
export function reviewerIn(ctx: Structure, teamKey: string | null, gate: { review?: PositionKey } | null | undefined, doer: string | null): Reviewer {
	var t = ctxTeam(ctx, teamKey);
	var startRung = (gate && gate.review) || "deputy";
	var i = REVIEW_LADDER.indexOf(startRung);
	if (i < 0) i = 0;
	var coo = cooNameIn(ctx);
	for (; i < REVIEW_LADDER.length; i++) {
		var rung = REVIEW_LADDER[i];
		var who = rung === "coo" ? coo : t ? (t[rung as "lead" | "deputy"] as string | null) : null;
		if (!who || who === doer) continue;
		return { name: who, rung: rung, rungLabel: POSITIONS[rung].label };
	}
	return { name: coo, rung: "coo", rungLabel: POSITIONS.coo.label };
}
export function reviewerFor(teamKey: string | null, gate: { review?: PositionKey } | null | undefined, doer: string | null) { return reviewerIn(LIVE_STRUCTURE, teamKey, gate, doer); }
