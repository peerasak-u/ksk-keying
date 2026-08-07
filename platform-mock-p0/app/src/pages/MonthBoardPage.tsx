// ปฏิทินงานประจำเดือน — the spine, its figure, and the phase breakdown beside it.
//
// Round 29: the switcher rides in the header row instead of a band of its own,
// because it is the one control that moves BOTH lanes.
import type { ReactNode } from "react";
import type { Project } from "../types";
import { ui } from "../state/ui";
import { useApp } from "../state/AppContext";
import { CappedList } from "../components/CappedList";
import { CardNote, ProjectCard } from "../components/ProjectCard";
import { ChevronLeftIcon, ChevronRightIcon } from "../components/Icons";
import { THAI_MONTHS_SHORT, TODAY_DATE, daysUntil, fmtDate } from "../domain/dates";
import { nextDueFor } from "../domain/due";
import { MONTHS, customerName } from "../domain/projects";
import { projectLate } from "../domain/trail";
import { isAwaitingReview, pendingCustomerGates } from "../domain/work";
import { lateNote, reviewNote } from "./overview/notes";
import {
	MB_DOW_LONG,
	mbGateGroups,
	mbGateShort,
	mbMidnight,
	mbProjectsOn,
	monthBoardData,
	workMonthLabel,
	type MonthBoardData,
} from "./monthBoard/monthBoardData";
import { DuePeriods, duePeriodsCount } from "./monthBoard/DuePeriods";
import { MonthPhaseStrip } from "./monthBoard/PhaseStrip";

// Why this งวด is standing where it is — the same shapes the rest of the app's
// annotations already use, in the order that decides which one matters.
function monthBoardNote(p: Project) {
	if (projectLate(p)) return lateNote(p);
	if (isAwaitingReview(p)) return reviewNote(p);
	const nd = nextDueFor(p);
	if (nd) {
		const when = nd.days < 0 ? "เลยกำหนดมาแล้ว " + -nd.days + " วัน" : nd.days === 0 ? "ครบกำหนดวันนี้" : "อีก " + nd.days + " วัน";
		return <CardNote text={"เกท " + nd.gate.code + " " + nd.gate.name + " ครบกำหนด " + fmtDate(nd.date) + " (" + when + ")"} />;
	}
	const pend = pendingCustomerGates(p);
	if (pend.length) return <CardNote text={"ยังไม่มีเกทไหนที่คำนวณวันกำหนดได้ · รอเอกสารจากลูกค้าอยู่ " + pend.length + " เกท"} neutral />;
	return <CardNote text="ยังไม่มีเกทไหนที่คำนวณวันกำหนดได้ — อยู่ในรอบทำงานปกติ" neutral />;
}

function monthBoardCards(list: Project[]) {
	return list
		.slice()
		.sort((a, b) => {
			if (projectLate(a) !== projectLate(b)) return projectLate(a) ? -1 : 1;
			const ab = isAwaitingReview(a), bb = isAwaitingReview(b);
			if (ab !== bb) return ab ? -1 : 1;
			return customerName(a.customerId).localeCompare(customerName(b.customerId), "th");
		})
		.map((p) => <ProjectCard key={p.id} p={p} annotation={monthBoardNote(p)} compact />);
}

function MbWhen({ d, w, r }: { d: string; w: string; r?: string }) {
	return (
		<div className="mb-when">
			<div className="d">{d}</div>
			<div className="w">{w}</div>
			{r ? <div className="r">{r}</div> : null}
		</div>
	);
}

function MbStation({ cls, when, head, sub, children }: { cls?: string; when: ReactNode; head: ReactNode; sub?: ReactNode; children: ReactNode }) {
	return (
		<div className={"mb-station" + (cls ? " " + cls : "")}>
			<span className="mb-dot"></span>
			{when}
			<div className="mb-head">{head}</div>
			{sub ? <p className="mb-sub">{sub}</p> : null}
			{children}
		</div>
	);
}

// The one dominant figure, and it counts DEADLINES rather than งวด, because
// that is what the screen below it is ordered by. The line under it says how
// many งวด those deadlines came from, and how many งวด have no deadline at all.
function MonthBoardHero({ d }: { d: MonthBoardData }) {
	const overdue = d.items.filter((x) => x.days < 0).length;
	const soon = d.items.filter((x) => x.days >= 0 && x.days <= 7).length;
	const later = d.items.length - overdue - soon;
	const pct = (n: number) => (n / d.items.length) * 100;
	const late = d.open.filter(projectLate).length;
	const waitCust = d.open.filter((p) => pendingCustomerGates(p).length > 0).length;
	const awaiting = d.open.filter(isAwaitingReview).length;

	const figs: ReactNode[] = [
		<div className="mw-fig" key="days"><b>{d.days.length}</b><span>วันที่มีของครบกำหนดในงวดนี้</span></div>,
	];
	if (overdue) figs.push(<div className="mw-fig attn" key="over"><b>{overdue}</b><span>เกทที่เลยกำหนดแล้ว</span></div>);
	if (late) figs.push(<div className="mw-fig attn" key="late"><b>{late}</b><span>งวดที่เลยรอบทำงานปกติ</span></div>);
	if (awaiting) figs.push(<div className="mw-fig" key="await"><b>{awaiting}</b><span>งวดที่รอลายเซ็นผู้สอบทาน</span></div>);
	if (waitCust) figs.push(<div className="mw-fig" key="cust"><b>{waitCust}</b><span>งวดที่รอเอกสารจากลูกค้า</span></div>);

	return (
		<div className="mw-hero mb-hero">
			<div className="mw-hero-n">{d.items.length}</div>
			<div className="mw-hero-unit">กำหนดส่งงานที่ยังไม่ปิดของงวด{d.month.label}</div>
			<div className="mb-hero-line">
				มาจาก <b>{d.onLine.length}</b> งวด
				{d.undated.length ? (
					<> — อีก <b>{d.undated.length}</b> งวดที่ยังไม่ปิดไม่มีเกทไหนที่คำนวณวันกำหนดได้ จึงไม่มีที่ยืนบนเส้นเวลา แต่อยู่ในสถานีล่างสุด</>
				) : (
					<> — ทุกงวดที่ยังไม่ปิดของเดือนนี้มีที่ยืนบนเส้นเวลาแล้ว</>
				)}
			</div>
			<div className="mw-split">
				<div className="seg-late" style={{ width: pct(overdue) + "%" }}></div>
				<div className="seg-wait" style={{ width: pct(soon) + "%" }}></div>
				<div className="seg-move" style={{ width: pct(later) + "%" }}></div>
			</div>
			{/* A band that is not there does not get a line in the legend — the same
			    "only print a figure that can mean something" rule งานของฉัน uses. */}
			<div className="mw-legend">
				{overdue ? <span><span className="k" style={{ background: "#f87171" }}></span>{overdue} เลยกำหนดแล้ว</span> : null}
				{soon ? <span><span className="k" style={{ background: "#78716c" }}></span>{soon} ครบกำหนดภายใน 7 วัน</span> : null}
				{later ? <span><span className="k" style={{ background: "#d6d3cd" }}></span>{later} หลังจากนั้น</span> : null}
			</div>
			<div className="mw-figs">{figs}</div>
		</div>
	);
}

// No 68px zero, ever (round 27's rule): a month with no deadline in it says so
// in one line and lets the stations below carry the work.
function MonthBoardQuiet({ d }: { d: MonthBoardData }) {
	if (!d.open.length) {
		return (
			<p className="mb-quiet">
				ไม่มีงวดที่ยังไม่ปิดใน<b>งวด{d.month.label}</b> —{" "}
				{d.closed.length ? <>ปิดครบทั้ง <b>{d.closed.length}</b> งวดแล้ว</> : "ยังไม่มีงวดของเดือนนี้ถูกเปิดเลย"}
			</p>
		);
	}
	return (
		<p className="mb-quiet">
			ยังไม่มีเกทไหนของ<b>งวด{d.month.label}</b> ที่คำนวณวันกำหนดได้ในช่วงนี้ — งานที่ยังไม่ปิดทั้ง <b>{d.open.length}</b> งวดจึงอยู่ในสถานี “ยังไม่มีวันกำหนด” ข้างล่าง
		</p>
	);
}

export function MonthBoardPage() {
	const { bump, version } = useApp();
	void version;
	const month = MONTHS[ui.currentMonthIndex];
	const d = monthBoardData(month);
	const today = mbMidnight(TODAY_DATE);

	const changeMonth = (delta: number) => {
		ui.currentMonthIndex = Math.max(0, Math.min(MONTHS.length - 1, ui.currentMonthIndex + delta));
		bump();
	};

	// ---- the dated stations, in order, with today's line where it belongs
	const stations: ReactNode[] = [];
	let nowDrawn = false;
	d.days.forEach((k) => {
		const items = d.byDay[k], date = new Date(k), dd = daysUntil(date);
		const list = mbProjectsOn(items);
		if (!nowDrawn && dd >= 0) {
			nowDrawn = true;
			stations.push(<div className="mb-now" key="now"><span>วันนี้ {fmtDate(today)}</span></div>);
		}
		stations.push(
			<MbStation
				key={k}
				cls={dd < 0 ? "late" : dd <= 7 ? "soon" : ""}
				when={
					<MbWhen
						d={date.getDate() + " " + THAI_MONTHS_SHORT[date.getMonth()]}
						w={MB_DOW_LONG[date.getDay()]}
						r={dd < 0 ? "เลยมาแล้ว " + -dd + " วัน" : dd === 0 ? "วันนี้" : "อีก " + dd + " วัน"}
					/>
				}
				head={list.length + " งวดครบกำหนดวันนี้ · " + items.length + " เกท"}
				sub={mbGateGroups(items).map((g, i) => (
					<span key={g.gate.code + i}>{i > 0 ? " · " : ""}{g.gate.code + " " + mbGateShort(g.gate)} <b>{g.n}</b></span>
				))}
			>
				<CappedList
					listKey={"mb-" + month.key + "-" + k}
					rows={monthBoardCards(list)}
					emptyText="ไม่มีงวด"
					cap={5}
					wrapClass="task-list"
					unit="งวด"
				/>
			</MbStation>,
		);
	});
	// A month entirely in the past never reaches the line above, and one with
	// nothing dated at all never enters the loop — both still need to know
	// where they are standing.
	if (!nowDrawn) stations.push(<div className="mb-now" key="now"><span>วันนี้ {fmtDate(today)}</span></div>);

	// ---- and the three kinds of station that have no date of their own
	if (d.undated.length) {
		stations.push(
			<MbStation
				key="undated"
				when={<MbWhen d="ไม่มีวัน" w="ยังไม่มีกำหนด" />}
				head={"ยังไม่มีวันกำหนด · " + d.undated.length + " งวด"}
				sub="ไม่มีเกทไหนของงวดเหล่านี้ที่คำนวณวันกำหนดได้ตอนนี้ — ยังเป็นงานที่ยังไม่ปิดเหมือนกัน"
			>
				<CappedList listKey={"mb-undated-" + month.key} rows={monthBoardCards(d.undated)} emptyText="ไม่มีงวด" cap={5} wrapClass="task-list" unit="งวด" />
			</MbStation>,
		);
	}
	if (d.closed.length) {
		stations.push(
			<MbStation
				key="closed"
				when={<MbWhen d="ปิดแล้ว" w="ผ่านไปแล้ว" />}
				head={"ปิดงานแล้ว · " + d.closed.length + " งวด"}
				sub="งวดของเดือนนี้ที่ปิดครบทุกเกทบังคับแล้ว — เก็บไว้ให้ย้อนดูได้ ไม่ได้หายไปจากเดือน"
			>
				<CappedList listKey={"mb-closed-" + month.key} rows={monthBoardCards(d.closed)} emptyText="ไม่มีงวดที่ปิดแล้ว" cap={4} wrapClass="task-list" unit="งวด" />
			</MbStation>,
		);
	}
	// รอบที่ถึงกำหนดเปิด is the part of the line that has not happened yet. It
	// still does NOT follow the month switcher — it is about what is coming
	// into existence.
	stations.push(
		<MbStation
			key="due"
			when={<MbWhen d="ข้างหน้า" w="ยังไม่เกิดขึ้น" />}
			head={<>รอบที่ถึงกำหนดเปิด <span className="section-count">{duePeriodsCount()}</span></>}
			sub={<>งวดที่แพ็กเกจของลูกค้าบอกว่าควรมีแต่ยังไม่ถูกเปิด — <b>ไม่ขึ้นกับเดือนที่เลือกด้านบน</b></>}
		>
			<DuePeriods />
		</MbStation>,
	);

	// A month with nothing open renders no strip at all, so the lane is not
	// emitted either — an empty 320px gutter beside the calendar would be the
	// padding this lane is not allowed to have.
	const side = d.open.length ? (
		<aside className="mb-side" aria-label="งานกองอยู่ที่เฟสไหน">
			<div id="month-board-phases"><MonthPhaseStrip month={month} projects={d.all} /></div>
		</aside>
	) : null;

	return (
		<>
			<div className="page-header mb-page-head">
				<div className="mb-page-head-text">
					<h2>ปฏิทินงานประจำเดือน</h2>
					<p className="page-sub">งานทุกโปรเจกต์ของทุกคนในงวดที่เลือก เรียงตามวันที่ครบกำหนดจริง — วันที่ไม่มีอะไรครบกำหนดไม่ถูกวาด</p>
				</div>
				<div className="month-switcher">
					<button id="month-prev" onClick={() => changeMonth(-1)} aria-label="เดือนก่อนหน้า" disabled={ui.currentMonthIndex === 0}>
						<ChevronLeftIcon />
					</button>
					<span className="month-switcher-label" id="month-board-label">{month.label}</span>
					<button
						id="month-next"
						onClick={() => changeMonth(1)}
						aria-label="เดือนถัดไป"
						disabled={ui.currentMonthIndex === MONTHS.length - 1}
					>
						<ChevronRightIcon />
					</button>
				</div>
			</div>

			<div id="month-board-body">
				<div className={"mb-cols" + (side ? "" : " single")}>
					<div className="mb-main">
						{/* The work note belongs to the calendar lane, not to the page:
						    it says which month the DATES below are in. */}
						<p className="mb-work-note">
							งวด{month.label} ทำงานกันในเดือน <b>{workMonthLabel(month.key)}</b> — วันบนเส้นเวลาข้างล่างเป็นวันของเดือนนั้น เพราะกำหนดของทุกเกทในงวดนี้ตกอยู่ในเดือนนั้น
						</p>
						{d.items.length ? <MonthBoardHero d={d} /> : <MonthBoardQuiet d={d} />}
						<div className="mb-line">{stations}</div>
					</div>
					{side}
				</div>
			</div>
		</>
	);
}
