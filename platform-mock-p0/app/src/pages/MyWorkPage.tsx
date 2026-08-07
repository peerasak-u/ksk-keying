// ================= งานของฉัน (rebuilt in round 27) =================
//
// One figure and two lanes:
//
//   the figure   how many งวด are open in this person's hands, with a bar
//                saying what that number is made of (late / in the normal
//                round / already on somebody else's desk) and, under it,
//                only the comparisons that are honest for THIS person.
//   the lanes    left = waiting on you, nothing blocking it, yours to move.
//                right = you finished it and it is waiting on somebody else.
//                Left first because people read left first, and because the
//                job is to push cards from the left lane into the right one.
import { useApp } from "../state/AppContext";
import { CappedList } from "../components/CappedList";
import { CardNote, ProjectCard } from "../components/ProjectCard";
import { CheckCircleIcon } from "../components/Icons";
import { LIST_CAP, dueItems, nextDueFor } from "../domain/due";
import { fmtDate } from "../domain/dates";
import {
	iCanSignOffAs,
	myWorkLanes,
	myWorkState,
	type MyWorkLanes,
} from "../domain/myWork";
import { isAwaitingReview, awaitingGates, pendingCustomerGates } from "../domain/work";
import { projectLate } from "../domain/trail";
import type { Project } from "../types";
import { MyWorkHero } from "./myWork/MyWorkHero";
import { gateCodeList, lateNote, reviewNote } from "./overview/notes";

function MyWorkChip({ p, name }: { p: Project; name: string }) {
	const st = myWorkState(p, name);
	return <div className="mw-state"><span className={"pill " + st.cls}>{st.text}</span></div>;
}

// Why this card is where it is — one line, the same shapes the executive
// view's annotations already use.
function myWorkNote(p: Project, name: string) {
	if (iCanSignOffAs(p, name)) {
		const a = awaitingGates(p).filter((x) => x.at.name === name && x.rec.doer !== name);
		return <CardNote text={"ผู้ทำ " + (a[0].rec.doer || p.assignee) + " ติ๊กเสร็จแล้ว รอลายเซ็นของคุณที่เกท " + gateCodeList(a, 3)} />;
	}
	if (isAwaitingReview(p)) return reviewNote(p);
	if (projectLate(p)) return lateNote(p);
	const d = nextDueFor(p);
	if (d) {
		const when = d.days < 0 ? "เลยกำหนดมาแล้ว " + -d.days + " วัน"
			: d.days === 0 ? "ครบกำหนดวันนี้" : "อีก " + d.days + " วัน";
		return <CardNote text={"เกท " + d.gate.code + " " + d.gate.name + " ครบกำหนด " + fmtDate(d.date) + " (" + when + ")"} />;
	}
	const pend = pendingCustomerGates(p);
	if (pend.length) return <CardNote text={"ยังไม่มีกำหนดในช่วงนี้ · รอเอกสารจากลูกค้าอยู่ " + pend.length + " เกท"} neutral />;
	return <CardNote text="ยังไม่มีกำหนดในช่วงนี้ — อยู่ในรอบทำงานปกติ" neutral />;
}

// A person with no งวด of their own is not shown a giant zero. If somebody
// else's Gate is waiting on them there is still a lane to render; if not,
// the screen says so in one line and stops.
function QuietHero({ lanes }: { lanes: MyWorkLanes }) {
	return (
		<div className="all-clear">
			<CheckCircleIcon />
			{lanes.mine.length
				? "ไม่มีงวดของคุณค้างอยู่ตอนนี้ — เหลือแต่เกทที่รอลายเซ็นของคุณ " + lanes.mine.length + " รายการ"
				: "ไม่มีงานค้างในมือคุณตอนนี้"}
		</div>
	);
}

function LaneHead({ title, count, mine }: { title: string; count: number; mine?: boolean }) {
	return (
		<div className={"mw-lane-head" + (mine ? " mine" : "")}>
			<h3>{title}</h3>
			<span className="n">{count} งวด</span>
		</div>
	);
}

export function MyWorkPage() {
	const { currentUserName, version } = useApp();
	void version;
	const name = currentUserName!;
	const lanes = myWorkLanes(name);
	const open = lanes.ownOpen;

	// A reviewer's left lane also holds other people's งวด that need a
	// signature only they can give, so for them the two counts deliberately
	// do not add up to the figure above — and the line says why rather than
	// leaving somebody to work it out.
	const toSign = lanes.mine.filter((p) => iCanSignOffAs(p, name)).length;

	return (
		<>
			<div className="greeting">
				<h2>สวัสดี {name}</h2>
				<p>วันนี้ วันพุธที่ 5 สิงหาคม 2569</p>
			</div>
			<div id="my-work-body">
				{!lanes.mine.length && !lanes.theirs.length ? (
					<QuietHero lanes={lanes} />
				) : (
					<>
						{open.length ? <MyWorkHero open={open} lanes={lanes} name={name} /> : <QuietHero lanes={lanes} />}
						<div className="section" style={{ marginTop: "22px" }}>
							<div className="section-head">
								<h3>งานของคุณวันนี้</h3>
								<span className="section-count">{lanes.mine.length + lanes.theirs.length} งวด</span>
							</div>
							<p className="page-sub" style={{ marginBottom: "14px" }}>
								ทำเสร็จแล้วการ์ดจะย้ายจากซ้ายไปขวา — ซ้ายคือของที่ยังอยู่ที่คุณ ขวาคือของที่ออกจากมือคุณไปรอคนอื่นแล้ว
								{toSign ? " · รวมงวดของคนอื่นอีก " + toSign + " งวดที่รอลายเซ็นของคุณด้วย" : ""}
							</p>
							<div className="mw-lanes">
								<div className="mw-lane">
									<LaneHead title="รอคุณ — ทำได้เลย" count={lanes.mine.length} mine />
									<p className="mw-lane-sub">ไม่มีอะไรขวางอยู่ ลงมือได้เดี๋ยวนี้ — เรียงงานที่เลยรอบทำงานไว้ก่อน แล้วตามวันครบกำหนดที่ใกล้ที่สุด</p>
									<CappedList
										listKey="mw-mine"
										rows={lanes.mine.map((p) => (
											<ProjectCard
												key={p.id}
												p={p}
												annotation={myWorkNote(p, name)}
												compact
												opts={{ chip: <MyWorkChip p={p} name={name} />, hideAttnPill: true, plain: true }}
											/>
										))}
										emptyText="ไม่มีงานที่รอคุณอยู่ตอนนี้"
										cap={LIST_CAP}
										wrapClass="task-list"
										unit="งวด"
									/>
								</div>
								<div className="mw-lane">
									<LaneHead title="รอคนอื่น — เสร็จจากคุณแล้ว" count={lanes.theirs.length} />
									<p className="mw-lane-sub">คุณติ๊กเสร็จแล้ว ค้างรอลายเซ็นผู้สอบทาน — ทำอะไรต่อไม่ได้จนกว่าจะมีคนเซ็น</p>
									<CappedList
										listKey="mw-theirs"
										rows={lanes.theirs.map((p) => (
											<ProjectCard
												key={p.id}
												p={p}
												annotation={myWorkNote(p, name)}
												compact
												opts={{ chip: <MyWorkChip p={p} name={name} />, hideAttnPill: true }}
											/>
										))}
										emptyText="ไม่มีงานของคุณค้างรอลายเซ็นใคร"
										cap={LIST_CAP}
										wrapClass="task-list"
										unit="งวด"
									/>
								</div>
							</div>
						</div>
					</>
				)}
			</div>
		</>
	);
}

export { dueItems };
