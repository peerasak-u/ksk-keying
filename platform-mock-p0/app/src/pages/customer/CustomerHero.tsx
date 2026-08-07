// ---- the header of the customer screen ----
//
// Counts only, and every one of them appears ONLY when it is non-zero —
// round 27's rule, for the same reason: a quiet customer must not be told
// "0 · 0 · 0". A customer with nothing open at all gets a sentence instead.
// No score, no ranking, no percentage; red is spent on exactly the two
// figures that mean something is past a date.
import { Fragment, type ReactNode } from "react";
import type { Project } from "../../types";
import { CUSTOMERS } from "../../state/stores";
import { CUSTOMER_STATUS_LABEL } from "../../data/customers";
import { THIS_YEAR, daysUntil, fmtDate } from "../../domain/dates";
import { dueItems } from "../../domain/due";
import { personCaption } from "../../domain/people";
import { projectsForCustomer } from "../../domain/projects";
import { customerPackages, nextOccurrence, occurrenceLabel, packageState } from "../../domain/schedule";
import { monthsBehind, projectLate } from "../../domain/trail";
import { pendingCustomerGates, projectReviewer, projectFinished } from "../../domain/work";
import type { PendingCustomerGate } from "../../domain/work";

/** One row per outstanding customer-facing Gate across their live งวด. */
export function customerPendingItems(active: Project[]) {
	const out: { p: Project; item: PendingCustomerGate }[] = [];
	active.forEach((p) => {
		pendingCustomerGates(p).forEach((item) => out.push({ p: p, item: item }));
	});
	return out;
}

/** The earliest งวด this customer's live packages will open next. Used by the
 *  header and by the timeline's own row for that month, so both say the same
 *  date without either one storing it. */
export function customerNextOccurrence(id: string) {
	let best: { pkg: (typeof CUSTOMERS)[string]["packages"][number]; next: { monthKey: string; opensOn: Date } } | null = null;
	customerPackages(id).forEach((pkg) => {
		if (packageState(pkg) !== "active") return;
		const n = nextOccurrence(id, pkg);
		if (n && (!best || n.opensOn < best.next.opensOn)) best = { pkg: pkg, next: n };
	});
	return best as { pkg: (typeof CUSTOMERS)[string]["packages"][number]; next: { monthKey: string; opensOn: Date } } | null;
}

export function customerHasAnyProject(id: string) { return projectsForCustomer(id).length > 0; }

export function CustomerHero({ id, active }: { id: string; active: Project[] }) {
	const c = CUSTOMERS[id];
	const late = active.filter(projectLate);
	const pending = customerPendingItems(active);
	const overdue = dueItems(active, 60).filter((d) => d.days < 0);
	const closed = projectsForCustomer(id).filter(projectFinished).length;

	const fig = (key: string, n: number, unit: string, label: string, attn: boolean) => (
		<div className={"mw-fig" + (attn ? " attn" : "")} key={key}>
			<b>{n}<span style={{ fontSize: "12px", fontWeight: 400 }}> {unit}</span></b>
			<span>{label}</span>
		</div>
	);
	const figs: ReactNode[] = [];
	if (active.length) figs.push(fig("open", active.length, "งวด", "ยังไม่ปิด", false));
	if (late.length) {
		const behind = Math.max.apply(null, late.map(monthsBehind));
		figs.push(fig("late", late.length, "งวด", "เลยรอบทำงานปกติ (มากสุด " + behind + " เดือน)", true));
	}
	if (pending.length) figs.push(fig("pending", pending.length, "รายการ", "รอจากฝั่งลูกค้า", false));
	if (overdue.length) figs.push(fig("overdue", overdue.length, "เกท", "เลยกำหนดยื่นแล้ว", true));
	if (closed) figs.push(fig("closed", closed, "งวด", "ปิดครบแล้วในปี " + THIS_YEAR, false));

	// The lines under the figures: who is carrying the open งวด and who signs
	// them, and when this customer's packages open the next one. Each prints
	// only when it has something to say.
	const lines: string[] = [];
	if (active.length) {
		const owners: string[] = [], reviewers: string[] = [];
		active.forEach((p) => {
			if (owners.indexOf(p.assignee) === -1) owners.push(p.assignee);
			const r = projectReviewer(p);
			if (r && reviewers.indexOf(r) === -1) reviewers.push(r);
		});
		lines.push("ผู้รับผิดชอบงานที่เปิดอยู่: " + owners.map((n) => n + " (" + personCaption(n) + ")").join(" · ") +
			" · ผู้สอบทาน " + reviewers.join(" · "));
	}
	const occ = customerNextOccurrence(id);
	if (occ) {
		const days = daysUntil(occ.next.opensOn);
		lines.push("รอบถัดไปของแพ็กเกจ: " + occurrenceLabel(occ.pkg.jobType, occ.next.monthKey, occ.pkg.recurrence) +
			" — กำหนดเปิด " + fmtDate(occ.next.opensOn) + (days < 0 ? " (เลยกำหนดมาแล้ว " + -days + " วัน)" : ""));
	} else if (!customerPackages(id).filter((k) => packageState(k) === "active").length) {
		lines.push("ยังไม่มีแพ็กเกจที่ใช้งานอยู่ — ลูกค้ารายนี้จึงยังไม่มีงวดที่เกิดซ้ำเอง");
	}
	// The empty case, said in words rather than as a row of zeros.
	if (!figs.length) lines.unshift(customerHasAnyProject(id) ? "ไม่มีงวดที่ยังเปิดอยู่กับลูกค้ารายนี้" : "ยังไม่มีงวดของลูกค้ารายนี้ในระบบ");

	return (
		<>
			<div className="cd-hero-name">
				{c.displayName}
				<span className="cd-hero-code">#{c.code}</span>
			</div>
			<div className="cd-hero-sub">
				{c.legalName + " · " + c.businessNature + " · " + CUSTOMER_STATUS_LABEL[c.status] + " · เข้าเป็นลูกค้าตั้งแต่ " + c.onboardedAt}
				{c.note ? <><br />{"หมายเหตุ: " + c.note}</> : null}
			</div>
			{figs.length ? <div className="mw-figs">{figs}</div> : null}
			{lines.length ? (
				<p className={"cd-hero-note" + (figs.length ? "" : " bare")}>
					{lines.map((l, i) => <Fragment key={i}>{i > 0 ? <br /> : null}{l}</Fragment>)}
				</p>
			) : null}
		</>
	);
}
