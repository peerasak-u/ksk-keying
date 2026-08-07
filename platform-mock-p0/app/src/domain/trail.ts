// ================= the Phase trail (round 30c) =================
//
// Until this round the office could say WHERE a งวด was, never HOW LONG it
// took to get there. `rec.doneAt` existed, but every closed Gate of every
// passed Phase carried the same seeded `seed.pastDate`, so a งวด sitting in
// เฟส 4 claimed all three Phases behind it finished on one day — a shape no
// day-count can be derived from. จังหวะงาน on the office overview needs
// exactly that, so the trail is now part of a project's record:
//
//   เฟส 1 starts the day the งวด is OPENED — periodOpensOn() via the
//   customer's own package, so a one-off (งานทะเบียน / งานโปรเจค) starts in
//   its own month rather than the month after, which is what that function
//   already says. Each Phase ends after a number of days, and the next one
//   starts the day it ends. A Phase the งวด has not reached has no dates at
//   all; the Phase it is sitting in now has a start and NO end, which is
//   what "still in flight" means here — it is why an open งวด cannot be
//   averaged, and it is also what makes "how long has this been sitting
//   here" answerable at all.
//
// The lengths are a SEED, exactly like seed.done / seed.awaiting are: a
// starting position for the demo, deterministic from the project's own id so
// the screen prints the same numbers on every refresh. They are not invented
// out of nothing either — each job type's slow Phase is the one the office's
// own checklist already says is slow:
//   monthly  รวบรวมเอกสาร — the whole "รอจากฝั่งลูกค้า" section of the
//            overview exists because that is where a monthly งวด waits.
//   yearly   บันทึกบัญชี — its Phase 2 Gates carry freq "รายไตรมาส", not
//            "ทุกเดือน": the recording is batched, so it lands in lumps.
//   consult  รับข้อมูลจากลูกค้า — the Phase whose Gates carry actor ลูกค้า.
//   project  ลงมือทำ — the one Phase of งานโปรเจค that is the work itself.
//   registry ลูกค้าลงนาม — a Gate the office cannot close on its own.
// The profile is read by Phase INDEX and falls back to 4 days, so a job type
// an admin has just given a sixth Phase still has a trail — and that Phase
// has no finished งวด behind it, so จังหวะงาน prints nothing for it, which
// is the correct answer rather than a gap.
import type { PhaseTrail, Project, TrailPhase } from "../types";
import { TODAY, TODAY_DATE, addDays, daysBetween, fmtDate } from "./dates";
import { jobTypeByKey } from "./jobTypes";
import { customerPackages, periodOpensOn } from "./schedule";
import { STATUS_DONE, projectFinished } from "./work";

export const PHASE_DAY_PROFILE: Record<string, number[]> = {
	monthly: [9, 4, 3, 3, 4],
	yearly: [8, 9, 3, 3, 6],
	consult: [6, 3, 4, 2, 2],
	project: [3, 5, 8, 4, 2],
	registry: [2, 3, 5, 2, 2],
};
export function trailHash(s: string) { var h = 2166136261; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }

// The งวด's own opening date, asked of the scheduling rule rather than of
// projectOpenedAt() — which treats every งวด as a month period and so puts a
// one-off a month later than periodOpensOn() says it starts.
export function periodStartDate(p: Project): Date {
	if (p.openedOn) return p.openedOn;
	var pkg = customerPackages(p.customerId).filter(function (k) { return k.jobType === p.jobType; })[0];
	return periodOpensOn(p.monthKey, pkg ? pkg.recurrence : "monthly");
}

export function phaseTrail(p: Project): PhaseTrail {
	var jt = jobTypeByKey(p.jobType)!, n = jt.phases.length;
	// Rebuilt when an admin changes the ladder's length, the same way
	// ensureWork() re-aligns the checklist.
	if (p.trail && p.trail.n === n) return p.trail;
	var prof = PHASE_DAY_PROFILE[p.jobType] || [];
	var h = trailHash(p.id), raw: number[] = [], i: number;
	for (i = 0; i < n; i++) raw.push(Math.max(1, (prof[i] || 4) + (((h >>> (i * 3)) & 3) - 2)));
	var fin = projectFinished(p);
	var done = fin ? n : Math.min(p.phaseIndex, n);   // Phases with BOTH a start and an end
	var opened = periodStartDate(p);
	var room = daysBetween(opened, TODAY_DATE);       // days that have actually elapsed
	var need = 0; for (i = 0; i < done; i++) need += raw[i];
	// A งวด whose opening date has not arrived yet, or that has not existed
	// for as many days as it has closed Phases, has no trail that could be
	// true — so it has none, and contributes nothing anywhere.
	if (room < done) { p.trail = { n: n, opened: opened, phases: [], usable: false, squeezed: false }; return p.trail; }
	// The demo's own seed positions งวดกรกฎาคม in เฟส 3 or 4 four days after
	// it opened, which no plausible trail can hold. Where that happens the
	// trail is compressed into the days that really elapsed AND flagged, so
	// those Phase lengths are never averaged and that งวด's current-Phase age
	// is never printed. The contradiction is a property of the demo's seed
	// positions, and it is named rather than hidden.
	var squeezed = done > 0 && need > room;
	var days = raw.slice();
	if (squeezed) {
		var extra = room - done, alloc: number[] = [], rema: { i: number; r: number }[] = [], used = 0;
		for (i = 0; i < done; i++) { var x = extra * raw[i] / need, f = Math.floor(x); alloc.push(f); rema.push({ i: i, r: x - f }); used += f; }
		rema.sort(function (a, b) { return b.r - a.r; });
		for (var k = 0; k < extra - used; k++) alloc[rema[k].i]++;
		for (i = 0; i < done; i++) days[i] = 1 + alloc[i];
	}
	var phases: (TrailPhase | null)[] = [], cursor = opened;
	for (i = 0; i < n; i++) {
		if (i < done) { var end = addDays(cursor, days[i]); phases.push({ start: cursor, end: end, days: days[i] }); cursor = end; }
		else if (i === done && !fin) phases.push({ start: cursor, end: null, days: null });
		else phases.push(null);
	}
	p.trail = { n: n, opened: opened, phases: phases, usable: true, squeezed: squeezed };
	return p.trail;
}

// วันที่เสร็จ, from the trail rather than from one flat date for the whole
// งวด: a Gate closed inside a Phase that has ended carries that Phase's end
// date, and one closed inside the Phase still running carries today. Called
// once, by ensureWork(), immediately after the record is first built.
export function stampTrailDates(p: Project) {
	var trail = phaseTrail(p);
	if (!trail.usable) return;
	p.work!.forEach(function (recs, pi) {
		var ph = trail.phases[pi];
		if (!ph) return;
		const phase = ph;
		recs.forEach(function (rec) {
			if (rec.status !== STATUS_DONE) return;
			rec.doneAt = phase.end ? fmtDate(phase.end) : TODAY;
		});
	});
}

// How long the งวด has been sitting in the Phase it is in now, or null when
// that cannot honestly be answered (a compressed trail, or none at all).
export function phaseAgeDays(p: Project): number | null {
	if (projectFinished(p)) return null;
	var trail = phaseTrail(p);
	if (!trail.usable || trail.squeezed) return null;
	var ph = trail.phases[p.phaseIndex];
	return ph && !ph.end ? daysBetween(ph.start, TODAY_DATE) : null;
}

// ---- "behind", derived. There is no deadline field on a project and
// none is invented here: a งวด is simply worked in the month AFTER it
// closes (documents only arrive once the month has ended — the whole of
// Phase 1 is about collecting them), so one month of lag is normal and
// only lag beyond that counts as late. That makes "how far behind"
// answerable in the unit the office actually thinks in — months of งวด —
// rather than in invented days-past-due.
export const NOW_MONTH_KEY = "2569-08";          // the month TODAY (5/8/2569) falls in
export const NORMAL_LAG_MONTHS = 1;              // งวด M is worked during M+1
export function monthIndexOf(key: string) {
	var parts = String(key).split("-");
	return parseInt(parts[0], 10) * 12 + parseInt(parts[1], 10);
}
export function monthsBehind(p: Project) {
	return Math.max(0, monthIndexOf(NOW_MONTH_KEY) - monthIndexOf(p.monthKey) - NORMAL_LAG_MONTHS);
}
export function projectLate(p: Project) { return !projectFinished(p) && monthsBehind(p) > 0; }
