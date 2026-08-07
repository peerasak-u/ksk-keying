import type { Customer, CustomerPackage, Project, DueRow, PausedRow, ScheduleSnapshot } from "../types";
import { CUSTOMERS, PROJECTS } from "../state/stores";
import { THAI_MONTHS, TODAY_DATE, daysUntil, monthLabel, periodLabelFor, periodParts } from "./dates";
import { membersOf } from "./people";
import { ensureWork, projectFinished } from "./work";
import { jobTypeByKey } from "./jobTypes";
import { notify } from "./notifications";
import { session, showToast } from "../state/session";
import { monthIndexOf, NOW_MONTH_KEY } from "./trail";
import { customerName } from "./projects";

// ================= the recurring schedule (round 16) =================
//
// Until this round the mock had no beginning: every deadline rule in it was
// expressed against "the งวด" or "the day the งวด was opened", but nothing
// ever opened one and no project could be created. This is that missing
// step, and it is one story in three parts — what the customer bought
// (packages, above) decides what recurs; recurring is what opens periods;
// and opening a period is what instantiates a project's Phases and Gates
// and starts their deadline clock.
//
// It is SIMULATED, deliberately and visibly: there is no scheduler, no
// timer and no backend here. What the engine does is DERIVE, from the
// active packages, the งวด that ought to exist and do not — so the list on
// the month board is computed every render rather than hand-listed, and
// pressing เปิดตอนนี้ does exactly what a scheduler firing on the date
// would have done.
export const RECURRENCES = [
	{ key: "monthly", label: "ทุกเดือน", feeUnit: "บาท/เดือน" },
	{ key: "yearly", label: "ปีละครั้ง", feeUnit: "บาท/ปี" },
	{ key: "oneoff", label: "ครั้งเดียว", feeUnit: "บาท (เหมาจ่าย)" },
];
export function recurrenceByKey(key: string) {
	for (var i = 0; i < RECURRENCES.length; i++) if (RECURRENCES[i].key === key) return RECURRENCES[i];
	return RECURRENCES[0];
}
export function customerPackages(id: string): CustomerPackage[] { return (CUSTOMERS[id] && CUSTOMERS[id].packages) || []; }
export function packageById(customerId: string, pkgId: string): CustomerPackage | null {
	return customerPackages(customerId).filter(function (k: CustomerPackage) { return k.id === pkgId; })[0] || null;
}
export function packageState(pkg: CustomerPackage) { return pkg.endedAt ? "ended" : pkg.paused ? "paused" : "active"; }

// A งวด opens on the first day of the month AFTER it closes — the same
// anchor projectOpenedAt() and the lateness rule have used since round 10,
// because a month's documents can only exist once the month has ended. A
// one-off is not a งวด at all: it starts when the office agreed to do it.
export function periodOpensOn(monthKey: string, recurrenceKey: string): Date {
	var q = periodParts(monthKey);
	if (recurrenceKey === "oneoff") return new Date(q.y, q.m, 1);
	return new Date(q.y, q.m + 1, 1);
}
export function monthKeyFromIndex(idx: number) {
	var y = Math.floor((idx - 1) / 12);
	var m = idx - y * 12;
	return y + "-" + (m < 10 ? "0" : "") + m;
}
// The customer's own accounting year end decides when a yearly package's
// งวด is — it is not always 31 ธันวาคม, and the field is already on the
// customer for exactly this reason (round 9).
export function fiscalEndMonth(c: Customer | undefined) {
	for (var i = 0; i < THAI_MONTHS.length; i++) {
		if (String(c && c.fiscalYearEnd).indexOf(THAI_MONTHS[i]) !== -1) return i + 1;
	}
	return 12;
}

// Every งวด this package is responsible for, up to `ahead` cycles past the
// current one. Nothing here looks at what exists yet — that is the caller's
// job, so "should exist" and "does exist" stay two separate questions.
export function packageCandidates(customerId: string, pkg: CustomerPackage, ahead?: number) {
	ahead = ahead || 0;
	var nowIdx = monthIndexOf(NOW_MONTH_KEY);
	var startIdx = monthIndexOf(pkg.startedAt);
	var endIdx = pkg.endedAt ? monthIndexOf(pkg.endedAt) : nowIdx + 12;
	var out = [];
	if (pkg.recurrence === "oneoff") {
		out.push(pkg.startedAt);
	} else if (pkg.recurrence === "yearly") {
		var fem = fiscalEndMonth(CUSTOMERS[customerId]);
		for (var y = Math.floor((startIdx - 1) / 12); y <= Math.floor((nowIdx - 1) / 12) + 1; y++) {
			var key = y + "-" + (fem < 10 ? "0" : "") + fem;
			var ki = monthIndexOf(key);
			if (ki >= startIdx && ki <= Math.min(endIdx, nowIdx + (ahead ? 12 : 0))) out.push(key);
		}
	} else {
		// Only the last few งวด: a recurrence that has not been opened for
		// half a year is not a scheduling question any more.
		for (var i = Math.max(startIdx, nowIdx - 3); i <= Math.min(endIdx, nowIdx + ahead); i++) {
			out.push(monthKeyFromIndex(i));
		}
	}
	return out;
}
export function periodOpened(customerId: string, jobKey: string, monthKey: string) {
	return PROJECTS.some(function (p) {
		return p.customerId === customerId && p.jobType === jobKey && p.monthKey === monthKey;
	});
}
export function packageSkip(pkg: CustomerPackage, monthKey: string) {
	return (pkg.skips || []).filter(function (s) { return s.period === monthKey; })[0] || null;
}
// What the package will produce next, whether or not it is due yet — the
// line the customer's package card shows, so "what does this customer
// generate for us" is answerable without opening the month board.
export function nextOccurrence(customerId: string, pkg: CustomerPackage) {
	if (pkg.endedAt) return null;
	var list = packageCandidates(customerId, pkg, 1);
	for (var i = 0; i < list.length; i++) {
		if (periodOpened(customerId, pkg.jobType, list[i])) continue;
		if (packageSkip(pkg, list[i])) continue;
		var opensOn = periodOpensOn(list[i], pkg.recurrence);
		// Anything older than the schedule's own backward window is not
		// "the next one" — it is a งวด nobody opened and nobody is going to,
		// and saying otherwise here would disagree with the month board.
		if (daysUntil(opensOn) < -OPEN_WINDOW_BACK) continue;
		return { monthKey: list[i], opensOn: opensOn };
	}
	return null;
}

// How far either side of today the schedule looks. A งวด whose opening date
// is further back than this is not "due to open", it is a งวด nobody is
// working — which is what the ล่าช้า section on the office overview is for.
export const OPEN_WINDOW_BACK = 30;
export const OPEN_WINDOW_AHEAD = 30;

// The whole schedule in one pass: what is due to open, what a person chose
// to skip this cycle, and which recurrences are paused. Derived from the
// packages every time it is rendered — never a stored list.
export function scheduleSnapshot(): ScheduleSnapshot {
	var due: DueRow[] = [], skipped: DueRow[] = [], paused: PausedRow[] = [];
	Object.keys(CUSTOMERS).forEach(function (cid) {
		customerPackages(cid).forEach(function (pkg) {
			// An ended package is not skipped here: `endedAt` is the LAST
			// งวด it covers, so a งวด inside its own run that nobody opened
			// is still due. packageCandidates() is what stops it producing
			// anything past that งวด.
			if (pkg.paused) { paused.push({ customerId: cid, pkg: pkg }); return; }
			packageCandidates(cid, pkg).forEach(function (mk) {
				if (periodOpened(cid, pkg.jobType, mk)) return;
				var opensOn = periodOpensOn(mk, pkg.recurrence);
				var days = daysUntil(opensOn);
				if (days > OPEN_WINDOW_AHEAD || days < -OPEN_WINDOW_BACK) return;
				var sk = packageSkip(pkg, mk);
				var row: DueRow = { customerId: cid, pkg: pkg, monthKey: mk, opensOn: opensOn, days: days, overdue: days < 0 };
				if (sk) { row.skip = sk; skipped.push(row); return; }
				due.push(row);
			});
		});
	});
	var order = function (a: DueRow, b: DueRow) {
		if (a.days !== b.days) return a.days - b.days;
		return customerName(a.customerId).localeCompare(customerName(b.customerId), "th");
	};
	due.sort(order);
	skipped.sort(order);
	return { due: due, skipped: skipped, paused: paused };
}

// Who a newly opened period lands on. Whoever already carries this
// customer's work of this job type keeps it — a recurring งวด does not
// change hands just because it is a new month. Only a customer nobody has
// worked yet falls through to the team that does this kind of work, and
// then to whoever is carrying the least open work, so the default is never
// "always the same person".
export function defaultAssigneeFor(customerId: string, jobKey: string) {
	var mine = PROJECTS.filter(function (p: Project) { return p.customerId === customerId && p.jobType === jobKey; });
	if (mine.length) return mine[mine.length - 1].assignee;
	var any = PROJECTS.filter(function (p: Project) { return p.customerId === customerId; });
	if (any.length) return any[any.length - 1].assignee;
	var pool = (jobKey === "consult" || jobKey === "project")
		? membersOf("team3")
		: membersOf("team1").concat(membersOf("team2"));
	var best = pool[0], bestN = Infinity;
	pool.forEach(function (name: string) {
		var n = PROJECTS.filter(function (p: Project) { return p.assignee === name && !projectFinished(p); }).length;
		if (n < bestN) { bestN = n; best = name; }
	});
	return best;
}

export function fmtFee(n: number) { return Number(n).toLocaleString("en-US"); }
// A yearly package's งวด is keyed by the customer's own accounting year
// end, so it is named that way rather than by the monthly "งวดเดือน…"
// convention periodLabelFor() carries for everything else.
export function occurrenceLabel(jobKey: string, monthKey: string, recurrenceKey: string) {
	if (recurrenceKey === "yearly") return "ปีบัญชีสิ้นสุด" + monthLabel(monthKey);
	return periodLabelFor(jobKey, monthKey);
}

// ---- the ONE way a project comes into existence ----
// The recurring schedule and the manual form both call this, so there are
// not two creation paths that can drift apart: the manual one is the same
// action, triggered by a person instead of by a date.
//
// A new period starts genuinely untouched — phase 0, every Gate blank, no
// document-chase state recorded — and its Phases and Gates are instantiated
// from the job type's own template by ensureWork(), exactly as every other
// project's are. `openedOn` is the real opening date, which is what the
// offsetDays deadline rules are then measured from (see projectOpenedAt).
export function openPeriod(
	customerId: string,
	jobKey: string,
	monthKey: string,
	opts: { assignee?: string; periodLabel?: string; by?: string; how?: string } = {},
): Project | null {
	if (!CUSTOMERS[customerId] || !jobTypeByKey(jobKey) || !monthKey) {
		showToast("เปิดงวดไม่สำเร็จ — ข้อมูลไม่ครบ");
		return null;
	}
	if (periodOpened(customerId, jobKey, monthKey)) {
		showToast("งวดนี้เปิดไว้แล้ว — " + customerName(customerId) + " · " + jobTypeByKey(jobKey)!.name);
		return null;
	}
	var p: Project = {
		id: customerId + "-" + jobKey + "-" + monthKey,
		customerId: customerId,
		assignee: opts.assignee || defaultAssigneeFor(customerId, jobKey),
		jobType: jobKey,
		periodLabel: opts.periodLabel || periodLabelFor(jobKey, monthKey),
		monthKey: monthKey,
		phaseIndex: 0,
		seed: {},
		openedOn: new Date(TODAY_DATE.getTime()),
		openedBy: opts.by || session.currentUserName || undefined,
		openedHow: opts.how || "manual",
		status: "today",
		actionLabel: "เปิดเช็กลิสต์",
	};
	PROJECTS.push(p);
	ensureWork(p);   // Phases + Gates instantiated from the job type template
	// The งวด has to reach whoever now carries it — otherwise a period can
	// open on a customer somebody is responsible for and they find out by
	// opening the month board.
	if (p.assignee !== session.currentUserName) {
		notify(p.assignee, "period",
			"เปิดงวดใหม่ที่คุณรับผิดชอบ: " + p.periodLabel,
			customerName(customerId) + " · " + jobTypeByKey(jobKey)!.name +
				(p.openedHow === "recurring" ? " · ตามรอบของแพ็กเกจ" : " · เปิดด้วยตนเอง") +
				(p.openedBy ? " โดย " + p.openedBy : ""),
			{ page: "project", id: p.id });
	}
	return p;
}
