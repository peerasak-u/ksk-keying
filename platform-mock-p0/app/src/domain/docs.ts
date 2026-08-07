// ---- where the documents stand, read off the Gates (round 20) ----
//
// Round 10 modelled the office's document-chase ladder as `Project.docState`.
// Round 20 deleted the field: the situation is READ OFF the Gates whose actor
// is the customer, and the only rung that was genuinely more than a Gate —
// "ขอแล้วลูกค้าไม่มีเอกสาร" — is recorded on the Gate itself, as `rec.noDocs`.
//
//   nobody started a customer Gate    → ยังไม่ได้เริ่มติดตาม (nobody asked)
//   a customer Gate is กำลังทำ         → ขอแล้ว รอลูกค้าส่ง
//   a customer Gate closed with noDocs → ขอแล้วลูกค้าไม่มีเอกสาร
//   every customer Gate closed        → เอกสารเข้าครบแล้ว
import type { Gate, GateRecord, Project } from "../types";
import { ACTOR_CUSTOMER } from "../data/jobTypes";
import { jobTypeByKey } from "./jobTypes";
import { STATUS_DOING, ensureWork, pendingCustomerGates, projectFinished } from "./work";

export interface CustomerGateRow { pi: number; gi: number; gate: Gate; rec: GateRecord }

// Every customer-facing Gate in a Phase the project has actually reached —
// the same scope pendingCustomerGates() uses, so the two can never
// disagree about which Gates are in play.
export function customerGateRecords(p: Project): CustomerGateRow[] {
	var jt = jobTypeByKey(p.jobType)!;
	var out: CustomerGateRow[] = [];
	ensureWork(p).forEach(function (recs, pi) {
		if (pi > p.phaseIndex) return;
		recs.forEach(function (rec, gi) {
			if (jt.phases[pi].gates[gi].actor !== ACTOR_CUSTOMER) return;
			out.push({ pi: pi, gi: gi, gate: jt.phases[pi].gates[gi], rec: rec });
		});
	});
	return out;
}
// The one distinction the deleted ladder existed for, and the reason it is
// worth recording at all: chase, or stop chasing and decide.
export function noDocsGates(p: Project) {
	return customerGateRecords(p).filter(function (x) { return x.rec.noDocs; });
}
export function docCustomerHasNothing(p: Project) {
	return !projectFinished(p) && noDocsGates(p).length > 0;
}
// "We asked and are waiting" is now a real thing somebody DID: a customer
// Gate somebody has started. That is what starting the chase looks like on
// the checklist, so it needs no second recording.
export function docWaitingForCustomer(p: Project) {
	if (projectFinished(p) || docCustomerHasNothing(p)) return false;
	return pendingCustomerGates(p).some(function (x) { return x.rec.status === STATUS_DOING; });
}
// Round 16 established this as a real state (a freshly opened งวด starts
// here) and round 20 keeps it, just derived differently: customer Gates
// are outstanding and nobody has touched one yet. Not the same as "asked
// and waiting" — nobody has asked. Without it the newest work would vanish
// from the office's รอจากฝั่งลูกค้า section, the one place it most needs
// to appear.
export function docNotAskedYet(p: Project) {
	if (projectFinished(p) || docCustomerHasNothing(p) || docWaitingForCustomer(p)) return false;
	return pendingCustomerGates(p).length > 0;
}
// The single derived sentence the project screen shows in place of round
// 10's editable ladder panel. Returns { text, attn } so the one case a
// manager has to act on can carry the app's existing red and the rest
// stays stone.
export function docSituation(p: Project): { text: string; attn: boolean } {
	var nd = noDocsGates(p);
	if (nd.length) {
		return { text: "ลูกค้าแจ้งว่าไม่มีเอกสารของงวดนี้ (บันทึกไว้ที่เกท " +
			nd.map(function (x) { return x.gate.code; }).join(", ") + ") — ต้องตัดสินใจ ไม่ใช่ทวงต่อ", attn: true };
	}
	var pending = pendingCustomerGates(p);
	if (!pending.length) {
		return { text: customerGateRecords(p).length
			? "เอกสารจากลูกค้าเข้าครบตามเกทของเฟสที่ผ่านมาแล้ว"
			: "เฟสนี้ไม่มีเกทที่ต้องรอเอกสารจากลูกค้า", attn: false };
	}
	var started = pending.filter(function (x) { return x.rec.status === STATUS_DOING; });
	if (started.length) {
		return { text: "ขอเอกสารกับลูกค้าแล้ว รออยู่ " + pending.length + " เกท (เริ่มติดตามแล้ว " +
			started.length + ") — เกทถัดไป " + started[0].gate.code + " " + started[0].gate.name, attn: false };
	}
	return { text: "ยังไม่มีใครเริ่มติดตามเอกสารของงวดนี้ — เกทแรกคือ " +
		pending[0].gate.code + " " + pending[0].gate.name, attn: false };
}
