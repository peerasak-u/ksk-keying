// The figure at the top of งานของฉัน: how many งวด are open in this person's
// hands, what that number is made of, and only the comparisons that are honest
// for THIS person.
import type { Project } from "../../types";
import { TODAY_DATE } from "../../domain/dates";
import { dueItems } from "../../domain/due";
import { iCanSignOffAs, myWorkBacklog, type MyWorkLanes } from "../../domain/myWork";
import { isAwaitingReview, pendingCustomerGates } from "../../domain/work";
import { projectLate } from "../../domain/trail";

// The next fortnight of Gate deadlines, plus everything already overdue
// piled at the left. Built from the templates' own due rules like every
// other date in this app; omitted entirely when there is nothing to draw.
function MyWorkChart({ open }: { open: Project[] }) {
	const all = dueItems(open, 400);
	const perDay: Record<number, number> = {};
	let overdue = 0, upcoming = 0;
	all.forEach((it) => {
		if (it.days < 0) { overdue++; return; }
		if (it.days > 14) return;
		perDay[it.days] = (perDay[it.days] || 0) + 1;
		upcoming++;
	});
	if (!overdue && !upcoming) return null;
	let max = overdue;
	Object.keys(perDay).forEach((k) => { max = Math.max(max, perDay[Number(k)]); });

	const bars = [];
	const axis = [];
	if (overdue) {
		bars.push(
			<div className="c over" key="over">
				<span className="v">{overdue}</span>
				<span className="b" style={{ height: Math.round((overdue / max) * 42) + "px" }}></span>
			</div>,
		);
		axis.push(<span key="over">เลย<br />กำหนด</span>);
	}
	const d = new Date(TODAY_DATE.getFullYear(), TODAY_DATE.getMonth(), TODAY_DATE.getDate());
	for (let i = 0; i <= 14; i++) {
		const n = perDay[i] || 0;
		bars.push(
			<div className={"c" + (n ? " has" : "")} key={"d" + i}>
				<span className="v">{n ? n : ""}</span>
				<span className="b" style={{ height: (n ? Math.max(3, Math.round((n / max) * 42)) : 2) + "px" }}></span>
			</div>,
		);
		axis.push(<span key={"a" + i}>{new Date(d.getFullYear(), d.getMonth(), d.getDate() + i).getDate()}</span>);
	}
	return (
		<>
			<div className="mw-chart-cap">
				เกทที่ครบกำหนด — วันนี้ถึงอีก 14 วัน{overdue ? " (แท่งซ้ายสุดคือที่เลยกำหนดไปแล้ว)" : ""}
			</div>
			<div className="mw-chart">{bars}</div>
			<div className="mw-chart-axis">{axis}</div>
		</>
	);
}

export function MyWorkHero({ open, lanes, name }: { open: Project[]; lanes: MyWorkLanes; name: string }) {
	const late = open.filter(projectLate).length;
	const waiting = open.filter(isAwaitingReview).length;
	const moving = open.length - late - waiting;
	const pct = (n: number) => (n / open.length) * 100;
	const backlog = myWorkBacklog(open);
	const overdueGates = dueItems(open, 400).filter((x) => x.days < 0).length;
	const toSign = lanes.mine.filter((p) => iCanSignOffAs(p, name)).length;

	const figs = [];
	if (backlog.meaningful) {
		figs.push(
			<div className="mw-fig" key="backlog">
				<b>{backlog.stacked} / {backlog.customers}</b><span>ลูกค้าที่ค้างสองงวดพร้อมกัน</span>
			</div>,
		);
	}
	const waitCust = open.filter((p) => pendingCustomerGates(p).length > 0).length;
	if (waitCust) figs.push(<div className="mw-fig" key="waitcust"><b>{waitCust}</b><span>งวดที่รอเอกสารจากลูกค้า</span></div>);
	if (overdueGates) figs.push(<div className="mw-fig attn" key="overdue"><b>{overdueGates}</b><span>เกทที่เลยกำหนดยื่นแล้ว</span></div>);
	if (toSign) figs.push(<div className="mw-fig" key="tosign"><b>{toSign}</b><span>งวดที่รอลายเซ็นของคุณ</span></div>);

	return (
		<div className="mw-hero">
			<div className="mw-hero-n">{open.length}</div>
			<div className="mw-hero-unit">งวดที่ยังไม่ปิดอยู่ในมือคุณ</div>
			<div className="mw-split">
				<div className="seg-late" style={{ width: pct(late) + "%" }}></div>
				<div className="seg-move" style={{ width: pct(moving) + "%" }}></div>
				<div className="seg-wait" style={{ width: pct(waiting) + "%" }}></div>
			</div>
			<div className="mw-legend">
				<span><span className="k" style={{ background: "#f87171" }}></span>{late} เลยรอบทำงาน</span>
				<span><span className="k" style={{ background: "#d6d3cd" }}></span>{moving} อยู่ในรอบ</span>
				<span><span className="k" style={{ background: "#78716c" }}></span>{waiting} รอลายเซ็น</span>
			</div>
			{figs.length ? <div className="mw-figs">{figs}</div> : null}
			<MyWorkChart open={open} />
		</div>
	);
}
