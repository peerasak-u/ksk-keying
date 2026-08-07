// ================= the working screen =================
//
// This is where the office actually works a project: the job type's
// Phases down the page, the current one open as a real tick-it-off
// checklist, the others reachable but deliberately quiet. One click on a
// Gate's circle records it; the row expands for the rest of the sheet's
// columns. Nothing here is a modal.
import { Navigate, useParams } from "react-router-dom";
import { POSITIONS, POSITION_ORDER } from "../data/office";
import { session } from "../state/session";
import { useApp } from "../state/AppContext";
import { ui } from "../state/ui";
import { paths, useGoBack } from "../navigation";
import { Stepper } from "../components/Stepper";
import { ArrowLeftIcon, NotifDocIcon, PermissionCheckIcon, UserCheckIcon } from "../components/Icons";
import { fmtDate } from "../domain/dates";
import { jobTypeByKey, phaseNames, projectOpenedAt } from "../domain/jobTypes";
import { customerName, projectById } from "../domain/projects";
import { positionOf } from "../domain/people";
import { docSituation } from "../domain/docs";
import { ensureWork, isAwaitingReview } from "../domain/work";
import { PhasePanel } from "./projectDetail/PhasePanel";

export function ProjectDetailPage() {
	const { id = "" } = useParams();
	const { version } = useApp();
	void version;
	const goBack = useGoBack();
	const p = projectById(id);
	if (!p) return <Navigate to={paths.myWork} replace />;

	const jobType = jobTypeByKey(p.jobType)!;
	ensureWork(p);
	if (ui.openPhaseIndex === null) ui.openPhaseIndex = p.phaseIndex;
	const attn = isAwaitingReview(p);

	// When this งวด was opened, and by what. It is on the screen because
	// the "ภายใน N วันนับจากวันเปิดงวด" deadlines below are measured from
	// it — a date nobody can see is a date nobody can check.
	const openedLine = p.openedOn
		? "เปิดงวดเมื่อ " + fmtDate(p.openedOn) +
			(p.openedHow === "recurring" ? " (ตามรอบของแพ็กเกจ" : " (เปิดด้วยตนเอง") +
			(p.openedBy ? " โดย " + p.openedBy : "") + ")"
		: "เปิดงวดเมื่อ " + fmtDate(projectOpenedAt(p)) + " (ตามรอบของงวด)";

	const sit = docSituation(p);

	return (
		<>
			<button className="back-link" onClick={goBack}>
				<ArrowLeftIcon />
				กลับ
			</button>
			<div className="page-header">
				<h2>{customerName(p.customerId)}</h2>
				<p className="page-sub">
					<span className="pill job-type-pill">{jobType.name}</span> {p.periodLabel} · ผู้รับผิดชอบ {p.assignee}
					{attn ? <> <span className="pill pill-blocked">ต้องการการตรวจสอบ</span></> : null}
				</p>
			</div>

			<div id="project-detail-stepper">
				<Stepper phases={phaseNames(jobType)} phaseIndex={p.phaseIndex} />
				<div className="proj-phase-label">
					เฟสปัจจุบัน: {jobType.phases[p.phaseIndex].name} ({p.phaseIndex + 1}/{jobType.phases.length})
				</div>
				<p className="checklist-legend">
					{openedLine} · ทุกเกทเป็นเกทบังคับ ยกเว้นข้อที่ระบุ "ไม่บังคับ" — เฟสจะผ่านได้เมื่อเกทบังคับทุกข้อเสร็จ และมีผู้สอบทานเซ็นครบ
				</p>
			</div>

			{/* Round 20: one derived, read-only sentence about where the documents
			    stand. Its only colour is the red the app already uses for "somebody
			    has to act", on the one case that is a decision rather than a chase. */}
			<div id="project-doc-state">
				<p className={"checklist-legend doc-line" + (sit.attn ? " attn" : "")}>
					<NotifDocIcon />
					<span>เอกสารจากลูกค้า: {sit.text}</span>
				</p>
			</div>

			<div id="project-detail-phases">
				{jobType.phases.map((_ph, pi) => <PhasePanel key={pi} p={p} pi={pi} />)}
			</div>

			<div className="permissions-card">
				<div className="permissions-head">
					<UserCheckIcon />
					ใครทำอะไรได้กับเกท
				</div>
				<p className="permissions-caption">
					ทุกบทบาทติ๊กเกทได้ รวมถึงพนักงานฝึกงาน — แต่ช่อง "ผู้สอบทาน" เซ็นได้เฉพาะบทบาทที่มีสิทธิ์สอบทาน และต้องไม่ใช่คนเดียวกับผู้ทำ
				</p>
				<ul className="permissions-list">
					{POSITION_ORDER.map((key) => {
						const pos = POSITIONS[key];
						const isMe = !!session.currentUserName && positionOf(session.currentUserName) === key;
						return (
							<li className="permission-row" key={key}>
								<PermissionCheckIcon />
								<span className="permission-role">
									{pos.label}
									{isMe ? <> <span className="permission-me-tag">(คุณ)</span></> : null}
								</span>
								<span className="permission-note">
									{pos.canReview ? "ติ๊กเกทได้ + เซ็นผู้สอบทานได้" : "ติ๊กเกทได้ (เซ็นผู้สอบทานไม่ได้)"}
									{pos.canEditPermissions ? " + แก้ไขประเภทงานได้" : ""}
								</span>
							</li>
						);
					})}
				</ul>
			</div>
		</>
	);
}
