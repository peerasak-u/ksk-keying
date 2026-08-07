// ================= พนักงานและทีม (round 17) =================
//
// The three teams, the four rungs under them and the COO on top stopped
// being seed data this round. What makes this screen worth having is that
// the consequences are the real ones, not a picture of them:
//
//   - Moving somebody to another team moves the ladder their Gates climb,
//     because reviewerFor() derives the reviewer from the assignee's team
//     every time and nothing stores it.
//   - Changing a rung changes what they may do, because canReview /
//     canSeeOffice / canEditPermissions hang off POSITIONS, not off a name.
//   - ภาพรวมสำนักงาน groups people by team by reading membersOf().
//
// And where a change would move work that is currently sitting with
// somebody, the screen says so BEFORE it is saved — computed by running the
// real ladder function over a shadow copy of the structure, never by a
// second hand-written rule that could disagree with it.
import type { PositionKey, Structure, User } from "../types";
import { LIVE_STRUCTURE, PROJECTS, TEAMS, USERS } from "../state/stores";
import { session } from "../state/session";
import { POSITIONS } from "../data/office";
import { jobTypeByKey } from "./jobTypes";
import { cooNameIn, ctxTeam, positionLabel, reviewerIn, teamName, teamOf } from "./people";
import { ensureWork, gateAwaitingReview, projectFinished } from "./work";

export function structureSnapshot(): Structure {
	var users: Record<string, User> = {};
	Object.keys(USERS).forEach(function (n) {
		users[n] = { team: USERS[n].team, position: USERS[n].position, initials: USERS[n].initials, added: (USERS[n] as User & { added?: boolean }).added } as User;
	});
	return {
		teams: TEAMS.map(function (t) {
			return { key: t.key, name: t.name, lead: t.lead, deputy: t.deputy, staff: t.staff.slice(), interns: t.interns.slice() };
		}),
		users: users,
	};
}

// Seat one person at one rung of one team, inside `ctx`. A rung that holds
// exactly one person (หัวหน้าทีม, รองหัวหน้าทีม, and the office's single COO)
// displaces whoever was in it down to พนักงานบัญชี on the same team — one
// uniform rule, and the screen states it before you press save.
export function applyPlacementTo(ctx: Structure, name: string, teamKey: string, position: PositionKey) {
	var displaced: string[] = [];
	var demote = function (who: string | null) {
		if (!who || who === name) return;
		var t = ctxTeam(ctx, ctx.users[who] ? ctx.users[who].team : teamKey);
		ctx.teams.forEach(function (x) {
			if (x.lead === who) x.lead = null;
			if (x.deputy === who) x.deputy = null;
		});
		if (t && t.staff.indexOf(who) === -1 && t.interns.indexOf(who) === -1) t.staff.push(who);
		ctx.users[who].position = "staff";
		displaced.push(who);
	};
	ctx.teams.forEach(function (t) {
		if (t.lead === name) t.lead = null;
		if (t.deputy === name) t.deputy = null;
		t.staff = t.staff.filter(function (n) { return n !== name; });
		t.interns = t.interns.filter(function (n) { return n !== name; });
	});
	var team = ctxTeam(ctx, teamKey);
	if (!team) return displaced;
	if (position === "coo") demote(cooNameIn(ctx));
	if (position === "lead") demote(team.lead);
	if (position === "deputy") demote(team.deputy);
	if (position === "lead") team.lead = name;
	else if (position === "deputy") team.deputy = name;
	else if (position === "staff") team.staff.push(name);
	else if (position === "intern") team.interns.push(name);
	// The COO sits WITH a team but holds no rung inside it — the office's
	// own chart puts them above all three, reviewing เฉพาะประเด็นสำคัญ.
	if (!ctx.users[name]) ctx.users[name] = { initials: name.slice(0, 2), added: true } as unknown as User;
	ctx.users[name].team = teamKey;
	ctx.users[name].position = position;
	return displaced;
}

/** Every Gate in the office currently sitting unsigned, and whose rung it
 *  lands on — the live answer, and the answer under a proposed change. */
export function reviewQueueUnder(ctx: Structure): Record<string, string | null> {
	var out: Record<string, string | null> = {};
	PROJECTS.forEach(function (p) {
		if (projectFinished(p)) return;
		var jt = jobTypeByKey(p.jobType)!;
		var team = ctx.users[p.assignee] ? ctx.users[p.assignee].team : teamOf(p.assignee);
		ensureWork(p).forEach(function (recs, pi) {
			recs.forEach(function (rec, gi) {
				if (!gateAwaitingReview(rec)) return;
				var who = reviewerIn(ctx, team, jt.phases[pi].gates[gi], rec.doer || p.assignee).name;
				out[p.id + "|" + pi + "|" + gi] = who;
			});
		});
	});
	return out;
}

// What would actually change if this person were seated here. Returns plain
// sentences, because "say so plainly" is the requirement — not a diff view.
export function placementImpact(name: string, teamKey: string, position: PositionKey) {
	var cur = USERS[name];
	var lines: string[] = [];
	if (cur && cur.team === teamKey && cur.position === position) return { lines: [], moved: 0, unchanged: true };
	var shadow = structureSnapshot();
	var displaced = applyPlacementTo(shadow, name, teamKey, position);
	displaced.forEach(function (who) {
		lines.push(who + " ถือตำแหน่ง" + positionLabel(who) + "อยู่เดิม จะถูกย้ายลงเป็นพนักงานบัญชีของทีมเดิม");
	});
	var before = reviewQueueUnder(LIVE_STRUCTURE);
	var after = reviewQueueUnder(shadow);
	var offThem = 0, ontoThem = 0, moved = 0;
	Object.keys(before).forEach(function (k) {
		if (before[k] === after[k]) return;
		moved++;
		if (before[k] === name) offThem++;
		if (after[k] === name) ontoThem++;
	});
	if (offThem > 0) lines.push("เกทที่ค้างรอลายเซ็นของ " + name + " อยู่ตอนนี้ " + offThem + " ข้อ จะย้ายไปอยู่กับผู้สอบทานคนอื่นตามบันไดของทีมใหม่ ไม่มีเกทไหนค้างอยู่กับคนที่ไม่มีสิทธิ์เซ็น");
	if (ontoThem > 0) lines.push("เกทที่ค้างอยู่กับคนอื่น " + ontoThem + " ข้อ จะย้ายมาอยู่ในคิวสอบทานของ " + name);
	if (moved - offThem - ontoThem > 0) lines.push("อีก " + (moved - offThem - ontoThem) + " เกทจะเปลี่ยนผู้สอบทานตามผลกระทบต่อเนื่องของการย้ายครั้งนี้");
	var mine = PROJECTS.filter(function (p) { return p.assignee === name && !projectFinished(p); }).length;
	if (mine > 0 && cur && cur.team !== teamKey) {
		lines.push("โปรเจกต์ที่ยังไม่ปิด " + mine + " โปรเจกต์ยังเป็นของ " + name + " ตามเดิม แต่จะถูกนับอยู่ในทีมใหม่ในหน้าภาพรวมสำนักงาน");
	}
	var wasCap = POSITIONS[cur ? cur.position : "staff"], nowCap = POSITIONS[position];
	if (wasCap.canReview && !nowCap.canReview) lines.push(name + " จะเซ็นผู้สอบทานไม่ได้อีกต่อไป");
	if (!wasCap.canReview && nowCap.canReview) lines.push(name + " จะเซ็นผู้สอบทานได้ตั้งแต่บันทึก");
	if (wasCap.canSeeOffice && !nowCap.canSeeOffice) lines.push(name + " จะเข้าหน้าภาพรวมสำนักงานไม่ได้อีก");
	if (!wasCap.canSeeOffice && nowCap.canSeeOffice) lines.push(name + " จะเห็นหน้าภาพรวมสำนักงานได้");
	if (name === session.currentUserName && wasCap.canEditPermissions && !nowCap.canEditPermissions) {
		lines.push("คุณกำลังปลดสิทธิ์ผู้ดูแลของตัวเอง — บันทึกแล้วจะเข้าหน้านี้ไม่ได้อีกจนกว่าจะเข้าระบบด้วยบัญชีที่มีสิทธิ์");
	}
	return { lines: lines, moved: moved, unchanged: false };
}

// Leaving the office. Open work is the one thing that genuinely strands, so
// it is refused rather than reported — with the transfer control sitting on
// the same panel, so the refusal is one click from being resolved.
export function removalImpact(name: string) {
	var open = PROJECTS.filter(function (p) { return p.assignee === name && !projectFinished(p); });
	var queue = reviewQueueUnder(LIVE_STRUCTURE);
	var waiting = Object.keys(queue).filter(function (k) { return queue[k] === name; }).length;
	var isCoo = USERS[name] && USERS[name].position === "coo";
	return { open: open.length, waiting: waiting, isCoo: isCoo };
}

// The same shadow-structure diff the person dialog uses, with the team that
// does not exist yet pushed into the copy first — so what it promises is
// again the REAL reviewerIn() over the office's real queue.
export function newTeamImpact(teamForm: { name: string; lead: string; deputy: string }, cooNameNow: string | null) {
	var lines: string[] = [];
	if (!teamForm.lead && !teamForm.deputy) {
		lines.push("ยังไม่ได้ตั้งหัวหน้าทีมหรือรองหัวหน้าทีม — งานของทีมนี้จะข้ามขึ้นไปหา " +
			(cooNameNow || "—") + " (COO) โดยตรงจนกว่าจะมีคนถือตำแหน่ง");
		return { lines: lines, moved: 0 };
	}
	var shadow = structureSnapshot();
	shadow.teams.push({ key: "__new", name: teamForm.name || "ทีมใหม่", lead: null, deputy: null, staff: [], interns: [] });
	var displaced: string[] = [];
	(["lead", "deputy"] as const).forEach(function (rung) {
		var who = teamForm[rung];
		if (!who || !USERS[who]) return;
		var from = USERS[who];
		if (from.position === "lead" || from.position === "deputy") {
			lines.push(who + " ถือตำแหน่ง" + POSITIONS[from.position].label + "ของ" + teamName(from.team) +
				"อยู่เดิม — ทีมนั้นจะว่างตำแหน่งนี้ และงานที่เคยค้างกับเขาจะเลื่อนขึ้นไปตามบันไดของทีมเดิม");
		}
		displaced = displaced.concat(applyPlacementTo(shadow, who, "__new", rung));
	});
	displaced.forEach(function (who) {
		lines.push(who + " จะถูกย้ายลงเป็นพนักงานบัญชีของทีมเดิม");
	});
	var before = reviewQueueUnder(LIVE_STRUCTURE);
	var after = reviewQueueUnder(shadow);
	var moved = Object.keys(before).filter(function (k) { return before[k] !== after[k]; }).length;
	if (moved) lines.push("เกทที่ยังไม่ได้เซ็น " + moved + " ข้อจะเปลี่ยนผู้สอบทานตามผลของการย้ายครั้งนี้");
	if (teamForm.lead && !teamForm.deputy) {
		lines.push("ทีมนี้ไม่มีรองหัวหน้าทีม — งานจะขึ้นตรงถึง " + teamForm.lead +
			" (หัวหน้าทีม) เหมือนทีมที่ปรึกษา + โปรเจคในปัจจุบัน");
	}
	return { lines: lines, moved: moved };
}
