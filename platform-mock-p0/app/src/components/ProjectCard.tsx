// A card shows the current Phase's checklist in miniature — never all 37
// Gates. Whatever is genuinely left in this Phase, capped at three rows,
// plus a count of the rest. Same plain check / hollow dot markers as
// before; a Gate waiting on a signature is the only one that picks up the
// amber "needs attention" colour.
import type { ReactNode } from "react";
import type { Project } from "../types";
import { jobTypeByKey, phaseNames } from "../domain/jobTypes";
import { customerName } from "../domain/projects";
import {
	ensureWork,
	gateAwaitingReview,
	gateClosed,
	isAwaitingReview,
	phaseStats,
	projectFinished,
} from "../domain/work";
import { session } from "../state/session";
import { GateCheckIcon } from "./Icons";
import { Stepper } from "./Stepper";
import { useOpenProject } from "../navigation";

function CardGateList({ p }: { p: Project }) {
	const gates = jobTypeByKey(p.jobType)!.phases[p.phaseIndex].gates;
	const work = ensureWork(p)[p.phaseIndex];
	const rows: ReactNode[] = [];
	let hiddenCount = 0;
	// Anything sitting on a signature comes first — it is the reason the
	// card is flagged at all, so it must not fall below the cut. Then
	// required Gates, since those are what the count above refers to and
	// what actually holds the Phase; skippable ones last.
	const rank = (gi: number) => (gateAwaitingReview(work[gi]) ? 0 : gates[gi].required === false ? 2 : 1);
	const order = gates.map((_g, gi) => gi).sort((a, b) => (rank(a) !== rank(b) ? rank(a) - rank(b) : a - b));
	order.forEach((gi) => {
		const g = gates[gi];
		const rec = work[gi];
		if (gateClosed(rec)) return;
		if (rows.length >= 3) { hiddenCount++; return; }
		const awaiting = gateAwaitingReview(rec);
		rows.push(
			<li key={gi} className={"gate-item " + (awaiting ? "awaiting" : "pending")}>
				{awaiting ? <GateCheckIcon /> : <span className="gate-dot"></span>}
				<span>
					{g.code + " " + g.name}
					{awaiting ? <> <span className="gate-awaiting-tag">รอผู้สอบทาน</span></> : null}
				</span>
			</li>,
		);
	});
	if (rows.length === 0) {
		rows.push(
			<li key="all-done" className="gate-item done">
				<GateCheckIcon /><span>เกทบังคับในเฟสนี้ครบแล้ว — พร้อมผ่านเฟส</span>
			</li>,
		);
	} else if (hiddenCount > 0) {
		rows.push(
			<li key="more" className="gate-item pending gate-item-more">อีก {hiddenCount} รายการในเฟสนี้</li>,
		);
	}
	return <ul className="gate-list">{rows}</ul>;
}

export interface ProjectCardOpts {
	/** งานของฉัน only: one pill above the client name saying what state this งวด is in. */
	chip?: ReactNode;
	hideAttnPill?: boolean;
	/** Keeps the "a Gate is unsigned" tint off a card sitting on THIS person's desk. */
	plain?: boolean;
}

// `annotation` (round 9) is one optional line saying why the list the
// card is currently sitting in has it. `compact` (round 10) drops the
// miniature gate list — the executive screen uses it everywhere.
export function ProjectCard({
	p,
	annotation,
	compact,
	opts = {},
}: {
	p: Project;
	annotation?: ReactNode;
	compact?: boolean;
	opts?: ProjectCardOpts;
}) {
	const openProject = useOpenProject();
	const jobType = jobTypeByKey(p.jobType)!;
	const attn = isAwaitingReview(p);
	const finished = projectFinished(p);
	const stats = phaseStats(p, p.phaseIndex);
	const tinted = attn && !opts.plain;
	const btnClass = tinted ? "btn-attn" : p.primary ? "btn-run" : "btn-ghost";
	return (
		<div className={"task-card" + (tinted ? " blocked" : "")} onClick={() => openProject(p.id)}>
			<div className="task-main">
				{opts.chip ? opts.chip : null}
				<div className="proj-head">
					<span className="proj-client">{customerName(p.customerId)}</span>
					<span className="pill job-type-pill">{jobType.name}</span>
					{tinted && !opts.hideAttnPill ? <span className="pill pill-blocked">ต้องการการตรวจสอบ</span> : null}
					{finished ? <span className="pill pill-passed">ปิดงานแล้ว</span> : null}
				</div>
				<div className="proj-period">
					{p.periodLabel}
					{/* Reviewers see other people's projects here too, so whose
					    work it is has to be on the card itself. */}
					{p.assignee !== session.currentUserName ? " · ผู้รับผิดชอบ " + p.assignee : ""}
				</div>
				{annotation ? annotation : null}
				<Stepper phases={phaseNames(jobType)} phaseIndex={p.phaseIndex} />
				<div className="proj-phase-label">
					เฟสปัจจุบัน: {jobType.phases[p.phaseIndex].name}{" "}
					<span className="proj-phase-count">เกทบังคับ {stats.requiredClosed}/{stats.requiredTotal}</span>
				</div>
				{compact ? null : <CardGateList p={p} />}
			</div>
			<div className="task-action">
				<button
					className={"btn " + btnClass}
					onClick={(e) => { e.stopPropagation(); openProject(p.id); }}
				>
					{p.actionLabel || "ดูรายละเอียด"}
				</button>
			</div>
		</div>
	);
}

/** One optional line under the client name, saying why this card is in this list. */
export function CardNote({ text, neutral }: { text: string; neutral?: boolean }) {
	return <p className={"card-annotation" + (neutral ? " neutral" : "")}>{text}</p>;
}
