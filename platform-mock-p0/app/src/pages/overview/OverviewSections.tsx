// The five (now six) sections of the executive view, in the order a manager
// actually asks them. Every count opens its own list in place; every row opens
// the project working screen, which is where the checklist lives.
import type { ReactNode } from "react";
import type { AwaitingGate } from "../../domain/work";
import type { Project, Reviewer } from "../../types";
import { ui } from "../../state/ui";
import { useApp } from "../../state/AppContext";
import { CappedList } from "../../components/CappedList";
import { CardNote } from "../../components/ProjectCard";
import { CheckCircleIcon } from "../../components/Icons";
import { LIST_CAP, dueItems } from "../../domain/due";
import { fmtDate } from "../../domain/dates";
import { dueRuleText, gateDueDate, jobTypeByKey } from "../../domain/jobTypes";
import { customerName } from "../../domain/projects";
import { teamName, teamOf } from "../../domain/people";
import { WAIT_BUCKETS } from "../../domain/pace";
import { phaseAgeDays, projectLate } from "../../domain/trail";
import { awaitingGates, isAwaitingReview, projectFinished } from "../../domain/work";
import { docCustomerHasNothing, docNotAskedYet, docWaitingForCustomer } from "../../domain/docs";
import { useOpenProject } from "../../navigation";
import { customerNote, lateNote, reviewNote } from "./notes";
import { projectRows } from "./projectRows";
import { OvSection } from "./OvSection";
import { OverviewPace } from "./PaceSection";
import { OverviewWorkload } from "./WorkloadSection";

// The meter's own two other bands (ปิดแล้ว / อยู่ในรอบปกติ) are buttons
// like everything else on this screen, so they open their list too —
// above the five sections rather than as a sixth one, because they are
// the meter's detail, not a question a manager starts the day with.
function MeterBand({ scope }: { scope: Project[] }) {
	if (ui.overviewOpenSection !== "closed" && ui.overviewOpenSection !== "open") return null;
	const isClosed = ui.overviewOpenSection === "closed";
	const band = scope.filter((p) => (isClosed ? projectFinished(p) : !projectFinished(p) && !projectLate(p)));
	return (
		<section className="ov-section open">
			<div className="sub-head">
				{isClosed ? "งานที่ปิดแล้ว" : "งานที่ยังไม่ปิด และยังอยู่ในรอบทำงานปกติ"}
				<span className="sub-count">{band.length} โปรเจกต์</span>
			</div>
			<CappedList
				listKey={"band-" + ui.overviewOpenSection}
				rows={projectRows(band, (p) =>
					isClosed
						? <CardNote text={"ปิดครบทุกเฟสแล้ว · ผู้รับผิดชอบ " + p.assignee} neutral />
						: isAwaitingReview(p) ? reviewNote(p)
						: docCustomerHasNothing(p) || docWaitingForCustomer(p) ? customerNote(p)
						: null,
				)}
				emptyText={isClosed ? "ยังไม่มีโปรเจกต์ที่ปิดครบทุกเฟส" : "ไม่มีโปรเจกต์ที่อยู่ในรอบปกติ"}
			/>
		</section>
	);
}

function ReviewQueue({ byReviewer }: { byReviewer: Record<string, { who: Reviewer; items: { p: Project; a: AwaitingGate }[] }> }) {
	const { bump } = useApp();
	const openProject = useOpenProject();
	const keys = Object.keys(byReviewer).sort((a, b) => byReviewer[b].items.length - byReviewer[a].items.length);
	if (!keys.length) return <div className="all-clear"><CheckCircleIcon />ไม่มีเกทที่ค้างรอลายเซ็นผู้สอบทาน</div>;
	return (
		<>
			<p className="ov-note">บันไดสอบทานของสำนักงาน: ผู้ทำ → รองหัวหน้าทีม → หัวหน้าทีม → COO (เฉพาะประเด็นสำคัญ)</p>
			{keys.map((k) => {
				const grp = byReviewer[k];
				const rows = grp.items.map((it, i) => {
					const d = gateDueDate(it.p, it.a.gate);
					return (
						<div key={i} className="contact-row due-row" onClick={() => openProject(it.p.id, it.a.pi, it.a.gi)}>
							<div className="contact-main">
								<span className="contact-name">
									<span className="pending-gate-code">{it.a.gate.code}</span> {it.a.gate.name}
								</span>
								<span className="pending-context">
									{customerName(it.p.customerId) + " · " + jobTypeByKey(it.p.jobType)!.name + " · " +
										it.p.periodLabel + " · ผู้ทำ " + (it.a.rec.doer || it.p.assignee)}
								</span>
							</div>
							<div className="contact-meta">{d ? "กำหนด " + fmtDate(d) : ""}</div>
						</div>
					);
				});
				return (
					<div key={k}>
						<div className="sub-head">
							{grp.who.name} <span className="pill rung-pill">{grp.who.rungLabel}</span>
							<span className="sub-count">{grp.items.length} เกท · {teamName(teamOf(grp.who.name || ""))}</span>
						</div>
						{ui.expandedLists["rev-" + k] || rows.length <= LIST_CAP ? rows : (
							<>
								{rows.slice(0, LIST_CAP)}
								<button
									type="button"
									className="btn btn-ghost list-more"
									onClick={() => { ui.expandedLists["rev-" + k] = true; bump(); }}
								>
									ดูทั้งหมด {rows.length} เกท
								</button>
							</>
						)}
					</div>
				);
			})}
		</>
	);
}

function DueSection({ scope }: { scope: Project[] }) {
	const { bump } = useApp();
	const openProject = useOpenProject();
	const due = dueItems(scope, ui.overviewDueWindow);
	const windows = [7, 14, 30].map((n) => (
		<button
			key={n}
			type="button"
			className={"btn btn-ghost figure" + (ui.overviewDueWindow === n ? " selected" : "")}
			onClick={() => { ui.overviewDueWindow = n; ui.overviewOpenSection = "due"; bump(); }}
		>
			ภายใน {n} วัน
		</button>
	));
	const rows = due.map((it, i) => {
		const tone = it.days < 0 ? "overdue" : it.days <= 3 ? "soon" : "";
		const when = it.days < 0 ? "เลยกำหนด " + -it.days + " วัน" : it.days === 0 ? "ครบกำหนดวันนี้" : "อีก " + it.days + " วัน";
		return (
			<div key={i} className="contact-row due-row" onClick={() => openProject(it.p.id, it.pi, it.gi)}>
				<div className="contact-main">
					<span className="contact-name">
						<span className="pending-gate-code">{it.gate.code}</span> {it.gate.name}
					</span>
					<span className="pending-context">
						{customerName(it.p.customerId) + " · " + it.p.periodLabel + " · ผู้รับผิดชอบ " + it.p.assignee}
					</span>
					<span className="due-rule">{"กติกา: " + dueRuleText(it.gate.due)}</span>
				</div>
				<div className={"due-when " + tone}>
					<span className="d">{fmtDate(it.date)}</span>
					{when}
				</div>
			</div>
		);
	});
	return (
		<>
			<div className="filter-row">{windows}</div>
			{rows.length === 0 ? (
				<div className="all-clear"><CheckCircleIcon />ไม่มีกำหนดยื่นภายใน {ui.overviewDueWindow} วันนี้</div>
			) : ui.expandedLists.due ? (
				rows
			) : (
				<>
					{rows.slice(0, LIST_CAP * 2)}
					{rows.length > LIST_CAP * 2 ? (
						<button type="button" className="btn btn-ghost list-more" onClick={() => { ui.expandedLists.due = true; bump(); }}>
							ดูทั้งหมด {rows.length} รายการ
						</button>
					) : null}
				</>
			)}
		</>
	);
}

export function OverviewSections({ scope }: { scope: Project[] }): ReactNode {
	// ---- 2. รอจากฝั่งลูกค้า ----
	const lateList = scope.filter(projectLate);
	const waiting = scope.filter(docWaitingForCustomer);
	const nothing = scope.filter(docCustomerHasNothing);
	const notAsked = scope.filter(docNotAskedYet);

	// ---- 3. รอสอบทาน — ค้างที่ใคร ----
	const byReviewer: Record<string, { who: Reviewer; items: { p: Project; a: AwaitingGate }[] }> = {};
	let awaitingTotal = 0;
	scope.forEach((p) => {
		if (projectFinished(p)) return;
		awaitingGates(p).forEach((a) => {
			const k = a.at.name + "|" + a.at.rung;
			if (!byReviewer[k]) byReviewer[k] = { who: a.at, items: [] };
			byReviewer[k].items.push({ p: p, a: a });
			awaitingTotal++;
		});
	});

	const due = dueItems(scope, ui.overviewDueWindow);
	const stuck = scope.filter((p) => {
		const age = phaseAgeDays(p);
		return age !== null && age > WAIT_BUCKETS[WAIT_BUCKETS.length - 2].max;
	}).length;
	const openCount = scope.filter((p) => !projectFinished(p)).length;

	return (
		<>
			<MeterBand scope={scope} />

			<OvSection
				sectionKey="late"
				title="ล่าช้า"
				sub="งานที่เลยรอบทำงานปกติ — งวดหนึ่งเดือนตามปกติทำในเดือนถัดไป จะนับว่าล่าช้าก็ต่อเมื่อเลยจากนั้นไปแล้ว"
				count={lateList.length}
				tone="figure-late"
				body={() => (
					<CappedList listKey="late" rows={projectRows(lateList, lateNote)} emptyText="ไม่มีงานล่าช้า ทุกงวดยังอยู่ในรอบทำงานปกติ" />
				)}
			/>

			<OvSection
				sectionKey="customer"
				title="รอจากฝั่งลูกค้า"
				sub={'อ่านจากเกทที่รอเอกสารจากลูกค้าในเฟสที่โปรเจกต์ไปถึงแล้ว — แยก "ขอแล้วรออยู่" ออกจาก "ขอแล้วลูกค้าไม่มีเอกสาร"'}
				count={waiting.length + nothing.length + notAsked.length}
				tone="figure-wait"
				body={() => (
					<>
						<p className="ov-note">ทั้งสามกลุ่มนี้เป็นผลจากเช็กลิสต์ ไม่ใช่ฟอร์มแยก — คนทำงานติ๊กเกทของเฟส “รวบรวมเอกสาร” เท่านั้น ส่วน “ลูกค้าไม่มีเอกสาร” บันทึกไว้ที่ตัวเกทเอง</p>
						<div className="sub-head sub-head-attn">
							ขอแล้วลูกค้าไม่มีเอกสาร<span className="sub-count">{nothing.length} รายการ</span>
						</div>
						<p className="sub-desc">ทวงต่อไม่ช่วยแล้ว — ต้องตัดสินใจ: โทรคุยกับลูกค้า หรือปิดงวดนี้ตามเอกสารเท่าที่มี</p>
						<CappedList listKey="docnone" rows={projectRows(nothing, customerNote)} emptyText="ไม่มีรายที่ขอแล้วลูกค้าไม่มีเอกสาร" />
						<div className="sub-head">ขอแล้ว รอลูกค้าส่ง<span className="sub-count">{waiting.length} รายการ</span></div>
						<p className="sub-desc">มีคนเริ่มติดตามแล้ว (เกทที่รอเอกสารอยู่ในสถานะ “กำลังทำ”) และยังรอลูกค้าส่งอยู่</p>
						<CappedList listKey="docwait" rows={projectRows(waiting, customerNote)} emptyText="ไม่มีรายที่ค้างรอเอกสารจากลูกค้า" />
						<div className="sub-head">ยังไม่มีใครเริ่มติดตาม<span className="sub-count">{notAsked.length} รายการ</span></div>
						<p className="sub-desc">งวดที่เปิดแล้วแต่ยังไม่มีใครแตะเกทที่รอเอกสารจากลูกค้าเลย — ขั้นแรกคือแจ้งลูกค้าส่งเอกสาร</p>
						<CappedList listKey="docnew" rows={projectRows(notAsked, customerNote)} emptyText="ทุกงวดที่เปิดอยู่มีคนเริ่มติดตามเอกสารแล้ว" />
					</>
				)}
			/>

			<OvSection
				sectionKey="review"
				title="รอสอบทาน — ค้างที่ใคร"
				sub="ผู้ทำติ๊กว่าเสร็จแล้ว แต่ยังไม่มีใครเซ็นช่องผู้สอบทาน — จัดกลุ่มตามคน และตามรุ่นของบันไดสอบทาน"
				count={awaitingTotal}
				tone="figure-wait"
				body={() => <ReviewQueue byReviewer={byReviewer} />}
			/>

			<OvSection
				sectionKey="due"
				title="ใกล้ถึงกำหนดยื่น"
				sub="กำหนดของทั้งสำนักงานในช่วงนี้ คำนวณจากกติกาที่ตั้งไว้ในประเภทงาน ไม่ใช่วันที่กรอกมือ"
				count={due.length}
				tone="figure-late"
				body={() => <DueSection scope={scope} />}
			/>

			{/* Sits here, and not above the meter: the four sections before it are
			    QUEUES — things somebody has to act on today — and it belongs next
			    to งานกระจายตามผู้รับผิดชอบ, because the two are the same family. */}
			<OvSection
				sectionKey="pace"
				title="จังหวะงาน — เวลาต่อเฟส และงานที่ค้างนาน"
				sub={"เวลาเฉลี่ยต่อเฟสจากงวดที่ทำจบแล้ว แล้วดูว่างานที่ยังค้างอยู่ตอนนี้ รออยู่ในเฟสเดิมมานานแค่ไหน แยกตามทีม — ตัวเลขคือจำนวนงวดที่ค้างเกิน " +
					WAIT_BUCKETS[WAIT_BUCKETS.length - 2].max + " วัน"}
				count={stuck}
				tone="figure-wait"
				body={() => <OverviewPace scope={scope} />}
			/>

			<OvSection
				sectionKey="people"
				title="งานกระจายตามผู้รับผิดชอบ"
				sub="งานที่ยังไม่ปิดต่อคน พร้อมส่วนที่ล่าช้า — เป็นการกระจายงาน ไม่ใช่การจัดอันดับหรือให้คะแนน"
				count={openCount}
				tone=""
				body={() => <OverviewWorkload scope={scope} />}
			/>
		</>
	);
}
