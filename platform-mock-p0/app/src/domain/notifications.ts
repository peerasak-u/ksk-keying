// ================= notifications (round 17) =================
//
// Until this round a person only discovered that a Gate had reached their
// rung by opening งานของฉัน and looking. This is the hand-off made visible —
// and it is deliberately the smallest thing that does that job:
//
//   - It is PER PERSON. A notification is addressed to one name, and the
//     screen only ever shows the signed-in user's own. Switching demo
//     users shows genuinely different lists, which is the whole point:
//     without that, a hand-off cannot be demonstrated at all.
//   - NO NEW DOMAIN EVENTS. Every kind below is something the mock already
//     did before this round — a Gate reaching a reviewer's rung, a Gate
//     coming back to the person who did it, a งวด opening, an automation
//     run finishing or failing, the document-chase ladder moving. Nothing
//     was invented in order to have something to notify about.
//   - It stays in the frame the app already has: one more nav destination
//     with a quiet count, never a bell that opens a panel over the work,
//     and never colour — an unread count is stone, because red in this app
//     means "somebody is blocked" and must keep meaning only that.
//
// Simulated in-page, like everything else here: no push, no email, no
// scheduler, and nothing survives a refresh.
import type { Notification, NotificationTarget, Project, WorkflowRun } from "../types";
import { NOTIFS, USERS, WF_RUNS, counters } from "../state/stores";
import { session } from "../state/session";
import { TODAY } from "./dates";
import { jobTypeByKey } from "./jobTypes";
import { customerName, projectById } from "./projects";
import { awaitingGates, gateRecord, expectedReviewer } from "./work";
import { noDocsGates } from "./docs";
import { workflowByKey } from "../data/workflows";

export const NOTIF_KINDS: Record<string, string> = {
	review: "รอคุณสอบทาน",
	sentback: "ถูกส่งกลับให้แก้",
	period: "เปิดงวดใหม่",
	run: "ผลการรันอัตโนมัติ",
	doc: "สถานะเอกสารจากลูกค้า",
};

// `target` is where clicking the row goes — always somewhere that already
// exists, so a notification can never be a dead end.
export function notify(
	to: string | null,
	kind: string,
	title: string,
	context: string,
	target: NotificationTarget | null,
): Notification | null {
	if (!to || !USERS[to]) return null;
	var n: Notification = {
		id: ++counters.notifSeq, to: to, kind: kind, title: title, context: context || "",
		target: target || null, at: TODAY, read: false,
	};
	NOTIFS.push(n);
	return n;
}
export function notifsFor(name: string | null) {
	return NOTIFS.filter(function (n) { return n.to === name; }).slice().reverse();
}
export function unreadCount(name: string | null) {
	return NOTIFS.filter(function (n) { return n.to === name && !n.read; }).length;
}

// One Gate has just reached somebody's rung. Emitted from the two places a
// Gate can become "done but unsigned" — the tick and the สถานะ dropdown —
// so the queue on งานของฉัน and the notification can never disagree.
export function notifyGateAwaiting(p: Project, pi: number, gi: number) {
	var g = jobTypeByKey(p.jobType)!.phases[pi].gates[gi];
	var at = expectedReviewer(p, pi, gi);
	if (!at || at.name === session.currentUserName) return;
	notify(at.name, "review",
		"เกท " + g.code + " " + g.name + " รอลายเซ็นผู้สอบทานของคุณ",
		customerName(p.customerId) + " · " + p.periodLabel + " · ผู้ทำ " + (gateRecord(p, pi, gi).doer || p.assignee),
		{ page: "project", id: p.id, pi: pi, gi: gi });
}
// The other direction: a Gate somebody else had finished has been re-opened,
// so it is back on the doer's desk.
export function notifyGateSentBack(p: Project, pi: number, gi: number, doer: string | null) {
	var g = jobTypeByKey(p.jobType)!.phases[pi].gates[gi];
	if (!doer || doer === session.currentUserName) return;
	notify(doer, "sentback",
		"เกท " + g.code + " " + g.name + " ถูกเปิดกลับมาแก้",
		customerName(p.customerId) + " · " + p.periodLabel + " · โดย " + (session.currentUserName || "—"),
		{ page: "project", id: p.id, pi: pi, gi: gi });
}

// A run reached a terminal state. Told to the person whose project it is,
// and to whoever fired it when that is somebody else.
export function notifyRunFinished(p: Project, pi: number, wfKey: string, run: WorkflowRun) {
	var wf = workflowByKey(wfKey);
	if (!wf) return;
	var ok = run.state === "done";
	var title = wf.name + " รอบที่ " + run.no + (ok ? " เสร็จแล้ว — รอคนตรวจผล" : " รันไม่สำเร็จ");
	var ctx = customerName(p.customerId) + " · " + p.periodLabel;
	var target: NotificationTarget = ok
		? { page: "run", id: p.id, pi: pi, key: wfKey, no: run.no }
		: { page: "project", id: p.id };
	var told: Record<string, boolean> = {};
	[p.assignee, run.startedBy].forEach(function (who) {
		if (!who || told[who]) return;
		told[who] = true;
		notify(who, "run", title, ctx, target);
	});
}

// The demo state. Nothing here is invented either: it is derived from the
// state the mock is already seeded with — every Gate already sitting
// unsigned, every seeded automation run, and every งวด whose document chase
// already reached "ขอแล้วลูกค้าไม่มีเอกสาร" (the one rung of that ladder the
// office has to make a decision about rather than keep chasing).
export function seedNotifications(PROJECTS: Project[]) {
	PROJECTS.forEach(function (p) {
		awaitingGates(p).forEach(function (a) {
			notify(a.at.name, "review",
				"เกท " + a.gate.code + " " + a.gate.name + " รอลายเซ็นผู้สอบทานของคุณ",
				customerName(p.customerId) + " · " + p.periodLabel + " · ผู้ทำ " + (a.rec.doer || p.assignee),
				{ page: "project", id: p.id, pi: a.pi, gi: a.gi });
		});
		// The one document outcome that is a decision rather than a chase.
		// Round 20 reads it off the Gate that records it, and links to that
		// exact Gate rather than to the project in general.
		noDocsGates(p).forEach(function (x) {
			notify(p.assignee, "doc",
				"ลูกค้าแจ้งว่าไม่มีเอกสารของงวดนี้ — ต้องตัดสินใจ",
				customerName(p.customerId) + " · " + p.periodLabel + " · เกท " + x.gate.code + " " + x.gate.name,
				{ page: "project", id: p.id, pi: x.pi, gi: x.gi });
		});
	});
	Object.keys(WF_RUNS).forEach(function (k) {
		var parts = k.split("|");
		var p = projectById(parts[0]);
		if (!p) return;
		(WF_RUNS[k] || []).forEach(function (run) {
			if (run.state !== "done" && run.state !== "failed") return;
			notifyRunFinished(p!, parseInt(parts[1], 10), parts[2], run);
		});
	});
}
