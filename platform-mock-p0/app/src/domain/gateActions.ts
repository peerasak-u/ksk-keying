// ---- the four actions the working screen can take ----
//
// Every tick flows straight back out to the dashboard cards, the customer
// screen and the month board — they all read the same derived state, so
// nothing needs to be told about the change beyond the repaint.
import type { GateRecord } from "../types";
import { ACTOR_CUSTOMER } from "../data/jobTypes";
import { bumpApp, session, showToast } from "../state/session";
import { ui } from "../state/ui";
import { TODAY } from "./dates";
import { jobTypeByKey } from "./jobTypes";
import { customerName, projectById } from "./projects";
import { notify, notifyGateAwaiting, notifyGateSentBack } from "./notifications";
import { STATUS_DOING, STATUS_DONE, STATUS_NOT, gateRecord, phaseCanAdvance } from "./work";

// One click = the common case: I did this, today. Clicking again undoes
// it (and clears the signature with it — a Gate that is no longer done
// cannot stay signed off).
export function toggleGateTick(id: string, pi: number, gi: number) {
	var p = projectById(id);
	if (!p) return;
	var rec = gateRecord(p, pi, gi);
	if (rec.status === STATUS_DONE) {
		var wasDoer = rec.doer;
		rec.status = STATUS_NOT;
		rec.doneAt = null;
		rec.reviewer = null;
		// Re-opening somebody else's finished Gate puts it back on their
		// desk — which is exactly the hand-off the notification says.
		notifyGateSentBack(p, pi, gi, wasDoer);
	} else {
		rec.status = STATUS_DONE;
		if (!rec.doer) rec.doer = session.currentUserName;
		rec.doneAt = TODAY;
		notifyGateAwaiting(p, pi, gi);
	}
	// The tick means "we collected them". Whichever way it just went, the
	// other outcome can no longer be true of this Gate.
	rec.noDocs = false;
	bumpApp();
}

// Round 20: the same close, with the other outcome recorded. The office DID
// ask and DID get an answer, so สถานะ is เสร็จ exactly as a tick makes it,
// and it still needs a ผู้สอบทาน signature — "the customer has nothing" is
// a claim that deserves a second pair of eyes as much as any other.
export function toggleGateNoDocs(id: string, pi: number, gi: number) {
	var p = projectById(id);
	if (!p) return;
	var rec = gateRecord(p, pi, gi);
	var g = jobTypeByKey(p.jobType)!.phases[pi].gates[gi];
	// Only a Gate whose ball is in the customer's court can end this way.
	if (g.actor !== ACTOR_CUSTOMER) return;
	if (rec.noDocs) {
		rec.noDocs = false;
		rec.status = STATUS_DOING;
		rec.reviewer = null;
		rec.doneAt = null;
		showToast("เปิดเกท " + g.code + " กลับมาติดตามเอกสารต่อ");
		bumpApp();
		return;
	}
	rec.noDocs = true;
	rec.status = STATUS_DONE;
	if (!rec.doer) rec.doer = session.currentUserName;
	rec.doneAt = TODAY;
	if (!rec.note) rec.note = "ลูกค้าแจ้งว่าไม่มีเอกสารของงวดนี้";
	notifyGateAwaiting(p, pi, gi);
	// The one document outcome that is a decision rather than a chase — so
	// the person carrying the งวด hears about it without going to look.
	if (p.assignee !== session.currentUserName) {
		notify(p.assignee, "doc",
			"ลูกค้าแจ้งว่าไม่มีเอกสารของงวดนี้ — ต้องตัดสินใจ",
			customerName(p.customerId) + " · " + p.periodLabel + " · เกท " + g.code + " " + g.name +
				" · บันทึกโดย " + (session.currentUserName || "—"),
			{ page: "project", id: p.id, pi: pi, gi: gi });
	}
	showToast("บันทึกที่เกท " + g.code + ": ลูกค้าไม่มีเอกสารให้ — งวดนี้จะไปอยู่กลุ่ม “ต้องตัดสินใจ” ในภาพรวมสำนักงาน");
	bumpApp();
}

export function setGateField(id: string, pi: number, gi: number, field: keyof GateRecord, value: string) {
	var p = projectById(id);
	if (!p) return;
	var rec = gateRecord(p, pi, gi);
	var wasDone = rec.status === STATUS_DONE, wasDoer = rec.doer;
	(rec as unknown as Record<string, unknown>)[field] = value === "" ? (field === "note" ? "" : null) : value;
	if (field === "status") {
		if (value === STATUS_DONE) {
			if (!rec.doer) rec.doer = session.currentUserName;
			if (!rec.doneAt) rec.doneAt = TODAY;
			if (!rec.reviewer) notifyGateAwaiting(p, pi, gi);
		} else {
			rec.reviewer = null;
			rec.doneAt = null;
			// A Gate that is no longer finished cannot still carry an
			// outcome — the answer went with the close.
			rec.noDocs = false;
			if (wasDone) notifyGateSentBack(p, pi, gi, wasDoer);
		}
	}
	if (field === "reviewer" && value && rec.status !== STATUS_DONE) {
		// Signing off something not yet finished makes no sense; treat
		// the signature as also confirming it is done.
		rec.status = STATUS_DONE;
		if (!rec.doer) rec.doer = p.assignee;
		if (!rec.doneAt) rec.doneAt = TODAY;
	}
	bumpApp();
}

export function signOffGate(id: string, pi: number, gi: number) {
	var p = projectById(id);
	if (!p) return;
	var rec = gateRecord(p, pi, gi);
	rec.reviewer = session.currentUserName;
	bumpApp();
	showToast("เซ็นผู้สอบทานข้อนี้แล้ว");
}

export function advancePhase(id: string) {
	var p = projectById(id);
	if (!p) return;
	var jobType = jobTypeByKey(p.jobType)!;
	if (!phaseCanAdvance(p, p.phaseIndex)) return;
	if (p.phaseIndex >= jobType.phases.length - 1) {
		p.status = "on-track";
		showToast("ปิดงานโปรเจกต์นี้แล้ว — เกทบังคับครบทุกเฟส");
		bumpApp();
		return;
	}
	p.phaseIndex++;
	ui.openPhaseIndex = p.phaseIndex;
	ui.openGateKey = null;
	showToast('ผ่านเฟสแล้ว — เข้าสู่เฟส "' + jobType.phases[p.phaseIndex].name + '"');
	bumpApp();
}

export function gateKey(pi: number, gi: number) { return pi + ":" + gi; }

// The most-repeated ความถี่ value in a job type — treated as its baseline,
// so only the Gates that deviate from it say anything about frequency.
const freqCache: Record<string, string> = {};
export function commonFreq(jobTypeKey: string) {
	if (freqCache[jobTypeKey]) return freqCache[jobTypeKey];
	var counts: Record<string, number> = {}, best = "", bestN = 0;
	jobTypeByKey(jobTypeKey)!.phases.forEach(function (ph) {
		ph.gates.forEach(function (g) {
			if (!g.freq) return;
			counts[g.freq] = (counts[g.freq] || 0) + 1;
			if (counts[g.freq] > bestN) { bestN = counts[g.freq]; best = g.freq; }
		});
	});
	freqCache[jobTypeKey] = best;
	return best;
}
