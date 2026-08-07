// ================= จังหวะงาน (round 30c) =================
//
// Two blocks, one section. The top one is the office-wide answer — how many
// days each Phase of each job type actually takes, from the day the งวด was
// opened. The bottom one is the team layer under it — not how much a team
// holds but how long what it holds has been sitting where it is.
//
// The line this block does not cross: it measures WORK, never people. Where
// work is queuing, how long it has waited and how much is in hand are all
// fair; a league table of teams or of people, a fastest/slowest ordering, a
// grade or an efficiency percentage are not. So teams stay in the office's
// own order, no figure is ever a rate or a score, and the only sorting
// anywhere is of one job type's own Phases by how long they take — which is
// sorting to find the slow rung, not to rank anybody.
import type { JobType, Project, Team } from "../types";
import { JOB_TYPES, TEAMS } from "../state/stores";
import { TODAY_DATE, daysBetween } from "./dates";
import { jobTypeByKey } from "./jobTypes";
import { teamOf } from "./people";
import { phaseTrail, projectLate } from "./trail";
import { projectFinished } from "./work";

export const MIN_PHASE_SAMPLE = 5;              // งวด behind a Phase before an average is printed
export const PHASE_TONES = ["#1c1917", "#57534e", "#78716c", "#a8a29e", "#d6d3cd"];
export const WAIT_BUCKETS = [
	{ max: 7, label: "ไม่เกิน 7 วัน", tone: "#d6d3cd", ink: "#44403c" },
	{ max: 14, label: "8–14 วัน", tone: "#a8a29e", ink: "#1c1917" },
	{ max: 30, label: "15–30 วัน", tone: "#78716c", ink: "#fafaf9" },
	{ max: Infinity, label: "เกิน 30 วัน", tone: "#1c1917", ink: "#fafaf9" },
];
export const PACE_ORDER_NOTE = "เรียงตามลำดับทีมของสำนักงาน ไม่ได้เรียงตามปริมาณงานและไม่ได้จัดอันดับ";
export function paceDays(n: number) { return String(Math.round(n * 10) / 10); }
export function paceInk(rank: number) { return rank <= 2 ? "#fafaf9" : "#44403c"; }
export function paceRedInk(onDark: boolean) { return onDark ? "#f87171" : "#b91c1c"; }

interface Aged { p: Project; age: number; late: boolean }
export interface PhaseCell {
	name: string; index: number; days: number[]; live: Project[]; aged: Aged[];
	n: number; enough: boolean; avg: number; liveN: number; oldest: Aged | null;
}
export interface JobTypeTiming {
	jt: JobType; inScope: number; phases: PhaseCell[];
	known: PhaseCell[]; complete: boolean; total: number; ranked: PhaseCell[];
	sampleMin: number; sampleMax: number;
}

// Per job type, per Phase, over the scope the screen is on.
//   days[]  finished Phase lengths that are allowed to be averaged
//   live[]  the งวด sitting in that Phase right now — the COUNT is the
//           checklist's own, the AGE only exists for งวด whose trail is real
export function phaseTimingStats(scope: Project[]): Record<string, JobTypeTiming> {
	var out: Record<string, JobTypeTiming> = {};
	JOB_TYPES.forEach(function (jt) {
		out[jt.key] = {
			jt: jt, inScope: 0,
			phases: jt.phases.map(function (ph, i) {
				return { name: ph.name, index: i, days: [], live: [], aged: [] } as unknown as PhaseCell;
			}),
		} as JobTypeTiming;
	});
	scope.forEach(function (p) {
		var b = out[p.jobType]; if (!b) return;
		b.inScope++;
		var t = phaseTrail(p);
		if (!t.usable) return;
		t.phases.forEach(function (ph, pi) {
			var cell = b.phases[pi];
			if (!ph || !cell) return;
			if (ph.end) { if (!t.squeezed) cell.days.push(ph.days!); return; }
			cell.live.push(p);
			if (!t.squeezed) cell.aged.push({ p: p, age: daysBetween(ph.start, TODAY_DATE), late: projectLate(p) });
		});
	});
	Object.keys(out).forEach(function (k) {
		var b = out[k];
		b.phases.forEach(function (c) {
			c.n = c.days.length;
			c.enough = c.n >= MIN_PHASE_SAMPLE;
			if (c.enough) { var s = 0; c.days.forEach(function (d) { s += d; }); c.avg = s / c.n; }
			c.liveN = c.live.length;
			c.oldest = c.aged.slice().sort(function (a, z) { return z.age - a.age; })[0] || null;
		});
		b.known = b.phases.filter(function (c) { return c.enough; });
		b.complete = b.phases.length > 0 && b.known.length === b.phases.length;
		// The total is summed from the ROUNDED per-Phase figures, so the parts
		// a reader can see always add up to the whole the row prints.
		b.total = Math.round(b.known.reduce(function (a, c) { return a + Math.round(c.avg * 10) / 10; }, 0) * 10) / 10;
		b.ranked = b.known.slice().sort(function (x, y) { return y.avg - x.avg; });
		b.sampleMin = b.known.length ? Math.min.apply(null, b.known.map(function (c) { return c.n; })) : 0;
		b.sampleMax = b.known.length ? Math.max.apply(null, b.known.map(function (c) { return c.n; })) : 0;
	});
	return out;
}

interface WaitBucketCell { name: string; order: number; days: number[]; n: number; enough: boolean; avg: number }
interface TeamAged { p: Project; age: number; late: boolean; phase: string }
export interface TeamWait {
	team: Team; inScope: number; open: number; late: number; noAge: number;
	ages: TeamAged[]; buckets: Record<string, WaitBucketCell>;
	durable: WaitBucketCell[]; thinDur: number; measurable: number; counts: number[]; oldest: TeamAged | null;
}

// Per team, over the same scope. Phases are bucketed by NAME rather than by
// position, because one team holds งวด of several job types at once and
// position 3 is ยื่นแบบภาษี in one ladder and ลูกค้าลงนาม in another.
export function teamWaitStats(scope: Project[]): Record<string, TeamWait> {
	var order: Record<string, number> = {}, oi = 0;
	JOB_TYPES.forEach(function (jt) {
		jt.phases.forEach(function (ph) { if (!(ph.name in order)) order[ph.name] = oi++; });
	});
	var out: Record<string, TeamWait> = {};
	TEAMS.forEach(function (t) {
		out[t.key] = { team: t, inScope: 0, open: 0, late: 0, noAge: 0, ages: [], buckets: {} } as unknown as TeamWait;
	});
	scope.forEach(function (p) {
		var b = out[teamOf(p.assignee) || ""]; if (!b) return;
		b.inScope++;
		var fin = projectFinished(p);
		if (!fin) { b.open++; if (projectLate(p)) b.late++; }
		var t = phaseTrail(p);
		if (!t.usable) { if (!fin) b.noAge++; return; }
		var jt = jobTypeByKey(p.jobType)!;
		t.phases.forEach(function (ph, pi) {
			if (!ph || !jt.phases[pi]) return;
			var nm = jt.phases[pi].name;
			var bk = b.buckets[nm] || (b.buckets[nm] = { name: nm, order: order[nm] === undefined ? 99 : order[nm], days: [] } as unknown as WaitBucketCell);
			if (ph.end) { if (!t.squeezed) bk.days.push(ph.days!); return; }
			if (t.squeezed) { b.noAge++; return; }
			b.ages.push({ p: p, age: daysBetween(ph.start, TODAY_DATE), late: projectLate(p), phase: nm });
		});
	});
	Object.keys(out).forEach(function (k) {
		var b = out[k];
		var list = Object.keys(b.buckets).map(function (n) { return b.buckets[n]; })
			.sort(function (x, y) { return x.order - y.order; });
		list.forEach(function (bk) {
			bk.n = bk.days.length;
			bk.enough = bk.n >= MIN_PHASE_SAMPLE;
			if (bk.enough) { var s = 0; bk.days.forEach(function (d) { s += d; }); bk.avg = s / bk.n; }
		});
		b.durable = list.filter(function (bk) { return bk.enough; });
		b.thinDur = list.filter(function (bk) { return !bk.enough && bk.n > 0; }).length;
		b.measurable = b.ages.length;
		b.counts = WAIT_BUCKETS.map(function () { return 0; });
		b.ages.forEach(function (a) {
			for (var i = 0; i < WAIT_BUCKETS.length; i++) { if (a.age <= WAIT_BUCKETS[i].max) { b.counts[i]++; return; } }
		});
		b.oldest = b.ages.slice().sort(function (x, y) { return y.age - x.age; })[0] || null;
	});
	return out;
}

export function paceSampleText(b: JobTypeTiming) {
	if (!b.known.length) return "ยังไม่มีเฟสไหนมีงวดทำจบพอจะเฉลี่ย";
	var head = b.complete ? "จากงวดที่ทำจบเฟสแล้ว " : "เฉพาะเฟสที่มีข้อมูล จากงวดที่ทำจบเฟสแล้ว ";
	return b.sampleMin === b.sampleMax
		? head + b.sampleMin + " งวด"
		: head + b.sampleMin + "–" + b.sampleMax + " งวด แล้วแต่เฟส";
}
// What a job type with a broken ladder is allowed to say — built from what it
// actually has, never a placeholder.
export function paceThinText(b: JobTypeTiming) {
	var missing = b.phases.filter(function (c) { return !c.enough; });
	var none = missing.filter(function (c) { return c.n === 0; });
	var thin = missing.filter(function (c) { return c.n > 0; });
	var bits: string[] = [];
	if (none.length) {
		bits.push("ยังไม่มีงวดไหนเดินผ่าน" +
			(none.length === b.phases.length ? "เฟสไหนเลย" : "เฟส " + none.map(function (c) { return c.index + 1; }).join(", ")));
	}
	if (thin.length) {
		bits.push("เฟส " + thin.map(function (c) { return c.index + 1 + " (" + c.n + " งวด)"; }).join(", ") +
			" ยังไม่ถึง " + MIN_PHASE_SAMPLE + " งวด");
	}
	return (b.known.length ? "มีแค่เฟส " + b.known.map(function (c) { return c.index + 1; }).join(", ") + " ที่มีตัวอย่างพอ — " : "") +
		bits.join(" · ") + " จึงยังต่อเป็นบันไดทั้งงวดไม่ได้";
}
