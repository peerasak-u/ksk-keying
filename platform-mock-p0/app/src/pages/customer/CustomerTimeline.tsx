// ---- the customer's งวด, as one timeline ----
//
// The cells are exactly what the deleted 12-cell strip drew — one per month
// of the accounting year, in one of four states — PLUS any month outside that
// year this customer actually has งวด in.
import type { ReactNode } from "react";
import type { Project } from "../../types";
import { ProjectCard } from "../../components/ProjectCard";
import { THAI_MONTHS_SHORT, THIS_YEAR, fmtDate, monthLabel } from "../../domain/dates";
import { jobTypeByKey } from "../../domain/jobTypes";
import { projectsForCustomer } from "../../domain/projects";
import { NOW_MONTH_KEY, monthIndexOf, projectLate } from "../../domain/trail";
import { isAwaitingReview, projectFinished, projectReviewer } from "../../domain/work";
import { useOpenProject } from "../../navigation";
import { lateNote, reviewNote } from "../overview/notes";
import { customerNextOccurrence } from "./CustomerHero";

interface Cell { key: string; here: Project[]; state: string }

export function customerYearCells(id: string): Cell[] {
	const byMonth: Record<string, Project[]> = {};
	projectsForCustomer(id).forEach((p) => {
		if (!byMonth[p.monthKey]) byMonth[p.monthKey] = [];
		byMonth[p.monthKey].push(p);
	});
	const keys: Record<string, boolean> = {};
	for (let m = 1; m <= 12; m++) keys[THIS_YEAR + "-" + (m < 10 ? "0" : "") + m] = true;
	Object.keys(byMonth).forEach((k) => { keys[k] = true; });
	return Object.keys(keys)
		.sort((a, b) => monthIndexOf(a) - monthIndexOf(b))
		.map((key) => {
			const here = byMonth[key] || [];
			const state = here.length === 0
				? (monthIndexOf(key) > monthIndexOf(NOW_MONTH_KEY) ? "future" : "none")
				: here.some(projectLate) ? "late" : here.every(projectFinished) ? "closed" : "open";
			return { key: key, here: here, state: state };
		});
}

export const TIMELINE_STATE_LABEL: Record<string, string> = {
	closed: "ปิดครบแล้ว", open: "ยังไม่ปิด", late: "เลยรอบปกติ",
	none: "ไม่มีงวด", future: "ยังไม่ถึงงวด",
};

function monthShort(key: string) {
	const a = String(key).split("-");
	return THAI_MONTHS_SHORT[parseInt(a[1], 10) - 1] + " " + a[0];
}

function MonthHead({ monthKey, stateLabel }: { monthKey: string; stateLabel: string }) {
	return <><b>{monthLabel(monthKey)}</b>{stateLabel}</>;
}

function TimelineRow({ dotState, month, children }: { dotState: string; month: ReactNode; children: ReactNode }) {
	return (
		<div className="cd-rail-row">
			<span className={"cd-rail-dot " + dotState}></span>
			<div className="cd-rail-month">{month}</div>
			<div>{children}</div>
		</div>
	);
}

// The closed-งวด row this screen has shown since round 9, unchanged — it just
// sits at its own month on the timeline now instead of in a list of its own.
function HistoryRow({ p }: { p: Project }) {
	const openProject = useOpenProject();
	return (
		<div className="customer-row history-row" onClick={() => openProject(p.id)}>
			<div className="customer-row-main">
				<span className="customer-row-name">
					{p.periodLabel} <span className="pill job-type-pill">{jobTypeByKey(p.jobType)!.name}</span>{" "}
					<span className="pill pill-passed">ปิดงานแล้ว</span>
				</span>
				<div className="jobtype-row-summary">ผู้รับผิดชอบ {p.assignee} · ผู้สอบทาน {projectReviewer(p)}</div>
			</div>
			<span className="customer-row-meta">{jobTypeByKey(p.jobType)!.phases.length + " เฟส ครบทั้งหมด"}</span>
		</div>
	);
}

// A month can hold both a closed งวด and a live one (a customer served on two
// job types), so each project is drawn by what IT is, not by the month's
// state: live ones get the card, closed ones get the row.
function CellRow({ cell }: { cell: Cell }) {
	const live = cell.here.filter((p) => !projectFinished(p));
	const done = cell.here.filter(projectFinished);
	return (
		<TimelineRow dotState={cell.state} month={<MonthHead monthKey={cell.key} stateLabel={TIMELINE_STATE_LABEL[cell.state]} />}>
			{live.length ? (
				<div className="task-list">
					{live.map((p) => (
						<ProjectCard key={p.id} p={p} annotation={projectLate(p) ? lateNote(p) : isAwaitingReview(p) ? reviewNote(p) : null} />
					))}
				</div>
			) : null}
			{done.map((p) => <HistoryRow key={p.id} p={p} />)}
		</TimelineRow>
	);
}

/** `run` is newest-first, so its last entry is the oldest month in the run. */
function RunRow({ run }: { run: Cell[] }) {
	const newest = run[0], oldest = run[run.length - 1];
	const label = run.length === 1 ? monthLabel(newest.key)
		: String(oldest.key).split("-")[0] === String(newest.key).split("-")[0]
			? THAI_MONTHS_SHORT[parseInt(String(oldest.key).split("-")[1], 10) - 1] + "–" +
				THAI_MONTHS_SHORT[parseInt(String(newest.key).split("-")[1], 10) - 1] + " " + String(newest.key).split("-")[0]
			: monthShort(oldest.key) + " – " + monthShort(newest.key);
	const text = newest.state === "future"
		? run.length + " งวดข้างหน้าที่ยังไม่ถึงกำหนด"
		: run.length === 1 ? "ไม่มีงวดในเดือนนี้" : "ไม่มีงวดใน " + run.length + " เดือนนี้";
	return (
		<div className="cd-rail-row">
			<span className="cd-rail-dot"></span>
			<div className="cd-rail-month"><b>{label}</b>{TIMELINE_STATE_LABEL[newest.state]}</div>
			<div><div className="cd-rail-note muted">{text}</div></div>
		</div>
	);
}

export function customerYearCounts(id: string) {
	// The counts the deleted strip printed — but counted per งวด, not per
	// month. The strip had to count months, because a month was all it drew;
	// this line sits directly beside the งวด themselves.
	const mine = projectsForCustomer(id);
	const closedN = mine.filter(projectFinished).length;
	const lateN = mine.filter(projectLate).length;
	const openN = mine.filter((p) => !projectFinished(p) && !projectLate(p)).length;
	const parts: string[] = [];
	if (closedN) parts.push("ปิดครบ " + closedN + " งวด");
	if (lateN) parts.push("ล่าช้า " + lateN + " งวด");
	if (openN) parts.push("ยังไม่ปิด " + openN + " งวด");
	return parts.length ? parts.join(" · ") : "ยังไม่มีงวด";
}

export function customerYearSub(id: string) {
	return customerYearCells(id).some((x) => x.here.length)
		? "งวดล่าสุดอยู่บนสุด — งวดที่ยังไม่ปิดกางเป็นการ์ดเต็ม งวดที่ปิดแล้วเหลือบรรทัดเดียว " +
			"จุดข้างซ้ายคือสถานะของเดือนนั้น (ทึบ = ปิดครบ · เทา = ยังไม่ปิด · แดง = เลยรอบทำงานปกติ)"
		: "ยังไม่มีงวดของลูกค้ารายนี้ — เมื่อแพ็กเกจเปิดงวดแรก งวดนั้นจะขึ้นมาอยู่บนสุดของเส้นนี้";
}

export function CustomerTimeline({ id }: { id: string }) {
	const cells = customerYearCells(id).slice().reverse();   // newest งวด at the top
	const occ = customerNextOccurrence(id);
	const isNextOcc = (cell: Cell) => !!(occ && occ.next.monthKey === cell.key);
	const rows: ReactNode[] = [];
	let i = 0;
	while (i < cells.length) {
		const cell = cells[i];
		if (cell.here.length) { rows.push(<CellRow key={cell.key} cell={cell} />); i++; continue; }
		// A month with no งวด that still says something keeps its own row: the
		// one this customer's package is about to open.
		if (isNextOcc(cell)) {
			rows.push(
				<TimelineRow key={cell.key} dotState="" month={<MonthHead monthKey={cell.key} stateLabel={TIMELINE_STATE_LABEL[cell.state]} />}>
					<div className="cd-rail-note muted">
						{"ยังไม่ได้เปิดงวดนี้ — รอบของแพ็กเกจ " + jobTypeByKey(occ!.pkg.jobType)!.name + " กำหนดเปิด " + fmtDate(occ!.next.opensOn)}
					</div>
				</TimelineRow>,
			);
			i++; continue;
		}
		// Everything else empty collapses into one run, so a customer who
		// signed last month gets a single quiet line instead of a wall of
		// twelve "ไม่มีงวด" rows.
		let j = i;
		while (j < cells.length && !cells[j].here.length && cells[j].state === cell.state && !isNextOcc(cells[j])) j++;
		rows.push(<RunRow key={"run-" + cell.key} run={cells.slice(i, j)} />);
		i = j;
	}
	return <>{rows}</>;
}
