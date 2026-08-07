// One Phase of the working screen: the head that is always there, and — when
// unfolded — the workflow track, the Gate checklist, and the advance rule.
import type { Project } from "../../types";
import type { PhaseStats } from "../../domain/work";
import { useApp } from "../../state/AppContext";
import { ui } from "../../state/ui";
import { ChevronIcon, LockIcon, StepperCheckIcon } from "../../components/Icons";
import { jobTypeByKey, phaseWorkflows } from "../../domain/jobTypes";
import { STATUS_DOING, gateAwaitingReview, phaseStats } from "../../domain/work";
import { advancePhase } from "../../domain/gateActions";
import { WorkGate } from "./WorkGate";
import { WorkflowTrack } from "./WorkflowTrack";

// The Phase-advance rule, made visible: what is still required, by its
// own รหัส, and why the button is or is not available.
function PhaseSummary({ p, pi, stats }: { p: Project; pi: number; stats: PhaseStats }) {
	const jobType = jobTypeByKey(p.jobType)!;
	const last = pi === jobType.phases.length - 1;
	if (stats.outstanding.length === 0) {
		return (
			<div className="phase-summary ready">
				<div className="phase-summary-text">
					เกทบังคับครบทั้ง {stats.requiredTotal} ข้อแล้ว
					{stats.total - stats.closed > 0 ? " (เหลือเกทไม่บังคับที่ยังไม่ได้ทำ " + (stats.total - stats.closed) + " ข้อ ข้ามได้)" : ""}
				</div>
				<button type="button" className="btn btn-run" onClick={() => advancePhase(p.id)}>
					{last ? "ปิดงานโปรเจกต์นี้" : 'ผ่านเฟสนี้ ไป "' + jobType.phases[pi + 1].name + '"'}
				</button>
			</div>
		);
	}
	return (
		<div className="phase-summary">
			<div className="phase-summary-text">ยังผ่านเฟสนี้ไม่ได้ — เหลือเกทบังคับอีก {stats.outstanding.length} ข้อ</div>
			<ul className="phase-summary-list">
				{stats.outstanding.map((o) => {
					const why = gateAwaitingReview(o.rec) ? "รอผู้สอบทานเซ็น" : o.rec.status === STATUS_DOING ? "กำลังทำ" : "ยังไม่เริ่ม";
					return (
						<li key={o.index}>
							<span className="work-gate-code">{o.gate.code}</span> {o.gate.name}{" "}
							<span className="phase-summary-why">— {why}</span>
						</li>
					);
				})}
			</ul>
			<button type="button" className="btn btn-run" disabled>
				{pi === jobType.phases.length - 1 ? "ปิดงานโปรเจกต์นี้" : "ผ่านเฟสนี้"}
			</button>
		</div>
	);
}

export function PhasePanel({ p, pi }: { p: Project; pi: number }) {
	const { bump } = useApp();
	const jobType = jobTypeByKey(p.jobType)!;
	const ph = jobType.phases[pi];
	const stats = phaseStats(p, pi);
	const isCurrent = pi === p.phaseIndex;
	const passed = pi < p.phaseIndex;
	const open = pi === ui.openPhaseIndex;
	const workflows = phaseWorkflows(p, pi);

	return (
		<section className={"phase-panel" + (isCurrent ? " current" : "") + (open ? " open" : "")}>
			<button
				type="button"
				className="phase-panel-head"
				onClick={() => { ui.openPhaseIndex = ui.openPhaseIndex === pi ? null : pi; ui.openGateKey = null; bump(); }}
			>
				{passed ? (
					<span className="phase-marker passed"><StepperCheckIcon /></span>
				) : (
					<span className={"phase-marker" + (isCurrent ? " current" : "")}>{pi + 1}</span>
				)}
				<span className="phase-panel-name">{ph.name}</span>
				{isCurrent ? <span className="pill pill-current">เฟสปัจจุบัน</span> : passed ? <span className="pill pill-passed">ผ่านแล้ว</span> : null}
				{stats.awaiting > 0 ? <span className="pill pill-waiting">รอสอบทาน {stats.awaiting}</span> : null}
				{workflows.length ? <span className="pill pill-auto">มีเวิร์กโฟลว์</span> : null}
				<span className="phase-panel-count">เกทบังคับ {stats.requiredClosed}/{stats.requiredTotal}</span>
				<ChevronIcon />
			</button>

			{open ? (
				// The workflow track sits above the checklist and is NOT governed by
				// it: it stays runnable on a Phase whose Gates are read-only, because
				// the automation is not a step in the signed chain.
				<div className="phase-panel-body">
					{isCurrent ? null : (
						<p className="phase-readonly-note">
							<LockIcon />
							{passed ? "เฟสนี้ผ่านไปแล้ว — ดูย้อนหลังได้ แต่แก้ไม่ได้" : "ยังไม่ถึงเฟสนี้ — จะติ๊กได้เมื่อผ่านเฟสก่อนหน้าแล้ว"}
						</p>
					)}
					{workflows.map((att) => <WorkflowTrack key={att.key} p={p} pi={pi} att={att} />)}
					{ph.gates.map((_g, gi) => <WorkGate key={gi} p={p} pi={pi} gi={gi} editable={isCurrent} />)}
					{isCurrent ? <PhaseSummary p={p} pi={pi} stats={stats} /> : null}
				</div>
			) : null}
		</section>
	);
}
