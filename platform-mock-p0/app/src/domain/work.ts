// ================= the per-run work record =================
//
// One record per (project, phase, gate) — exactly the five fill-in
// columns the office's own tracking sheets have next to every
// ขั้นตอนย่อย row (ผู้ทำ / ผู้สอบทาน / วันที่เสร็จ / สถานะ / หมายเหตุ),
// and nothing invented on top of them. In particular there is no fourth
// สถานะ value: "waiting on a reviewer" is not a status, it is simply
// สถานะ = เสร็จ with ผู้สอบทาน still blank, which is how the sheet
// itself encodes it.
import type { Gate, GateRecord, JobType, Project, Reviewer } from "../types";
import { ACTOR_CUSTOMER } from "../data/jobTypes";
import { TODAY } from "./dates";
import { jobTypeByKey } from "./jobTypes";
import { reviewerFor, teamOf } from "./people";
import { stampTrailDates } from "./trail";

export const STATUS_NOT = "ยังไม่เริ่ม", STATUS_DOING = "กำลังทำ", STATUS_DONE = "เสร็จ";
export const STATUS_ORDER = [STATUS_NOT, STATUS_DOING, STATUS_DONE];

// Round 20 adds one field, `noDocs`, and it is deliberately NOT a fourth
// สถานะ — the rule from round 7 stands. It records which of two OUTCOMES a
// finished customer-facing Gate had: the documents came in, or the customer
// said there are none. Both are สถานะ เสร็จ (the office did ask, and got an
// answer); both still need a ผู้สอบทาน signature like any other Gate. What
// differs is what a manager has to do next — chase, or decide — and that
// distinction is the one thing the deleted document-chase ladder could say
// that no checkbox could. It says it here now, on the Gate somebody is
// standing on when they find out.
export function blankRecord(): GateRecord {
	return { status: STATUS_NOT, doer: null, reviewer: null, doneAt: null, note: "", noDocs: false };
}

// Built lazily, then kept in sync with the job type's template — an admin
// can add or remove a Gate on the "ประเภทงาน" screen at any time, and a
// project that already has work recorded must not fall out of alignment
// with its own checklist because of it.
export function ensureWork(p: Project): GateRecord[][] {
	var jt = jobTypeByKey(p.jobType)!;
	var seed = p.seed || {};
	if (!p.work) {
		p.work = jt.phases.map(function (ph, pi) {
			return ph.gates.map(function (g, gi) {
				var rec = blankRecord();
				if (pi < p.phaseIndex) {
					rec.status = STATUS_DONE;
					rec.doer = p.assignee;
					// reviewerFor() directly, not expectedReviewer() — the
					// work record is still being built here, so it cannot
					// read itself back.
					rec.reviewer = reviewerFor(teamOf(p.assignee), g, p.assignee).name;
					rec.doneAt = seed.pastDate || TODAY;
				} else if (pi === p.phaseIndex) {
					if (gi < (seed.done || 0)) {
						rec.status = STATUS_DONE;
						rec.doer = p.assignee;
						rec.reviewer = reviewerFor(teamOf(p.assignee), g, p.assignee).name;
						rec.doneAt = seed.pastDate || TODAY;
					} else if ((seed.awaiting || []).indexOf(gi) !== -1) {
						rec.status = STATUS_DONE;
						rec.doer = p.assignee;
						rec.doneAt = TODAY;
					} else if ((seed.doing || []).indexOf(gi) !== -1) {
						rec.status = STATUS_DOING;
						rec.doer = p.assignee;
					}
					if (seed.notes && seed.notes[gi]) rec.note = seed.notes[gi];
				}
				return rec;
			});
		});
		applyDocSeed(p, jt);
		// Round 30c: วันที่เสร็จ is stamped from the งวด's own Phase trail
		// rather than from one flat seed.pastDate for everything, so the
		// checklist's dates and จังหวะงาน's day-counts are the same record
		// read two ways. Runs last, because it needs the built work record
		// back (phaseTrail asks projectFinished whether the last Phase closed).
		stampTrailDates(p);
	}
	// Re-align to the template: pad phases/gates that were added, drop
	// records whose Gate no longer exists.
	while (p.work.length < jt.phases.length) p.work.push([]);
	p.work.length = jt.phases.length;
	jt.phases.forEach(function (ph, pi) {
		while (p.work![pi].length < ph.gates.length) p.work![pi].push(blankRecord());
		p.work![pi].length = ph.gates.length;
	});
	if (p.phaseIndex > jt.phases.length - 1) p.phaseIndex = jt.phases.length - 1;
	return p.work;
}

// Round 20: the demo's starting document situation, expressed on the Gates
// that actually carry it rather than in a parallel `docState` field. This
// is a seed like `seed.done` / `seed.awaiting` are — a starting position,
// run once when the work record is first built, never consulted again.
//
//   "asked" — somebody has asked and is waiting  → customer Gates กำลังทำ
//   "none"  — asked, and the customer has none   → first one closed noDocs
//   "in"    — the documents are in               → customer Gates closed
//   (absent) — nobody has asked yet              → left ยังไม่เริ่ม
//
export function applyDocSeed(p: Project, jt: JobType) {
	var mode = (p.seed || {}).docs;
	if (!mode) return;
	var touched = false;
	jt.phases.forEach(function (ph, pi) {
		if (pi > p.phaseIndex) return;
		ph.gates.forEach(function (g, gi) {
			if (g.actor !== ACTOR_CUSTOMER) return;
			var rec = p.work![pi][gi];
			// Never overwrite what the ordinary seed already recorded — a
			// Gate the phase seed closed or left mid-flight stays as it is.
			if (rec.status !== STATUS_NOT) return;
			if (mode === "asked") {
				rec.status = STATUS_DOING;
				rec.doer = p.assignee;
			} else if (mode === "in") {
				rec.status = STATUS_DONE;
				rec.doer = p.assignee;
				rec.reviewer = reviewerFor(teamOf(p.assignee), g, p.assignee).name;
				rec.doneAt = (p.seed || {}).pastDate || TODAY;
			} else if (mode === "none" && !touched) {
				// One Gate carries the answer — the customer said there is
				// nothing, and that is recorded once, not on every row.
				rec.status = STATUS_DONE;
				rec.doer = p.assignee;
				rec.doneAt = (p.seed || {}).pastDate || TODAY;
				rec.noDocs = true;
				if (!rec.note) rec.note = "ลูกค้าแจ้งว่าไม่มีเอกสารของงวดนี้";
				touched = true;
			}
		});
	});
}

export function gateRecord(p: Project, pi: number, gi: number) { return ensureWork(p)[pi][gi]; }

// Whose desk this Gate lands on, and which rung of the office's review
// ladder that is. Derived from the assignee's team every time — a project
// carries no reviewer field of its own any more.
export function expectedReviewer(p: Project, pi: number, gi: number): Reviewer {
	var g = jobTypeByKey(p.jobType)!.phases[pi].gates[gi];
	var rec = ensureWork(p)[pi][gi];
	return reviewerFor(teamOf(p.assignee), g, rec.doer || p.assignee);
}
/** The project's default ผู้สอบทาน — the rung its ordinary work lands on. */
export function projectReviewer(p: Project) { return reviewerFor(teamOf(p.assignee), null, p.assignee).name; }
// A Gate is closed only when the doer has finished it AND someone has
// signed the ผู้สอบทาน column — one signature is not enough.
export function gateClosed(rec: GateRecord) { return rec.status === STATUS_DONE && !!rec.reviewer; }
export function gateAwaitingReview(rec: GateRecord) { return rec.status === STATUS_DONE && !rec.reviewer; }

export interface PhaseStats {
	total: number;
	closed: number;
	requiredTotal: number;
	requiredClosed: number;
	awaiting: number;
	outstanding: { index: number; gate: Gate; rec: GateRecord }[];
}

export function phaseStats(p: Project, pi: number): PhaseStats {
	var gates = jobTypeByKey(p.jobType)!.phases[pi].gates;
	var work = ensureWork(p)[pi];
	var s: PhaseStats = { total: gates.length, closed: 0, requiredTotal: 0, requiredClosed: 0, awaiting: 0, outstanding: [] };
	gates.forEach(function (g, gi) {
		var rec = work[gi];
		var closed = gateClosed(rec);
		if (closed) s.closed++;
		if (gateAwaitingReview(rec)) s.awaiting++;
		if (g.required !== false) {
			s.requiredTotal++;
			if (closed) s.requiredClosed++;
			else s.outstanding.push({ index: gi, gate: g, rec: rec });
		}
	});
	return s;
}
export function phaseCanAdvance(p: Project, pi: number) { return phaseStats(p, pi).outstanding.length === 0; }

export interface AwaitingGate { pi: number; gi: number; gate: Gate; rec: GateRecord; at: Reviewer }

/** The whole app's "ต้องการการตรวจสอบ" state, derived — never stored. */
export function awaitingGates(p: Project): AwaitingGate[] {
	var out: AwaitingGate[] = [];
	var jt = jobTypeByKey(p.jobType)!;
	ensureWork(p).forEach(function (recs, pi) {
		recs.forEach(function (rec, gi) {
			if (gateAwaitingReview(rec)) {
				var g = jt.phases[pi].gates[gi];
				out.push({ pi: pi, gi: gi, gate: g, rec: rec, at: reviewerFor(teamOf(p.assignee), g, rec.doer || p.assignee) });
			}
		});
	});
	return out;
}
export function isAwaitingReview(p: Project) { return awaitingGates(p).length > 0; }
export function projectFinished(p: Project) {
	var jt = jobTypeByKey(p.jobType)!;
	return p.phaseIndex >= jt.phases.length - 1 && phaseCanAdvance(p, jt.phases.length - 1);
}

// ---- "waiting on the customer", derived from the Gates' own `actor`.
// Only Gates in Phases the project has actually reached count — a
// document request three Phases away is not something anyone is stuck
// on today. A Gate the office already finished and that is merely
// waiting for a signature is NOT waiting on the customer; it is waiting
// on a reviewer, and belongs in that list instead.
export interface PendingCustomerGate { pi: number; gi: number; gate: Gate; rec: GateRecord }
export function pendingCustomerGates(p: Project): PendingCustomerGate[] {
	var jt = jobTypeByKey(p.jobType)!;
	var out: PendingCustomerGate[] = [];
	ensureWork(p).forEach(function (recs, pi) {
		if (pi > p.phaseIndex) return;
		recs.forEach(function (rec, gi) {
			var g = jt.phases[pi].gates[gi];
			if (g.actor !== ACTOR_CUSTOMER) return;
			if (gateClosed(rec) || gateAwaitingReview(rec)) return;
			out.push({ pi: pi, gi: gi, gate: g, rec: rec });
		});
	});
	return out;
}
export function waitingOnCustomer(p: Project) { return !projectFinished(p) && pendingCustomerGates(p).length > 0; }
