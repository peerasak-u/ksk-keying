// ---- the run summary, compacted into a header: what this run is, how big
// it is, and the two things you can do to the run itself.
import type { Workflow } from "../../types";
import { customerName } from "../../domain/projects";
import { phaseWorkflows } from "../../domain/jobTypes";
import { getRuns, startWorkflowRun } from "../../domain/runs";
import { useCloseRunReview, useOpenRunReview } from "../../navigation";
import { CpuIcon, LinkIcon, PlayIcon, RerunIcon } from "../../components/Icons";
import { ui } from "../../state/ui";
import type { RunCtx } from "./runModel";
import { runPendingExcluded } from "./runModel";
import type { RunActions } from "./useRunActions";

export function RunHead({ c, wf, phaseName, actions }: { c: RunCtx; wf: Workflow; phaseName: string; actions: RunActions }) {
	const openRunReview = useOpenRunReview();
	const d = c.d, run = c.run;
	const runs = getRuns(c.args.id, c.args.pi, c.args.key).slice().reverse();
	const att = phaseWorkflows(c.p, c.args.pi).filter(function (a) { return a.key === c.args.key; })[0] || { evidence: [] };
	const pending = runPendingExcluded(d);

	// Always back to the project's own working screen, opened on the Phase
	// the run belongs to — never a dead end.
	const goBack = useCloseRunReview();
	const closeRunReview = () => goBack(c.args.id, c.args.pi);

	return (
		<div className="run-head">
			<div className="run-head-top">
				<div className="run-head-main">
					<div className="run-head-name">
						<CpuIcon />ตรวจทานผล{wf.name}{" "}
						<span className="pill pill-auto">รอบที่ {run.no}</span>{" "}
						<span className="pill job-type-pill">{phaseName}</span>
					</div>
					<div className="run-head-meta">
						รันโดย {wf.actor} · เสร็จ {run.finishedAt} · ขอบเขต {customerName(c.p.customerId)} · {c.p.periodLabel}
					</div>
				</div>
				<div className="run-head-counts">
					<div><b>{d.groupCount}</b><span>กลุ่ม</span></div>
					<div><b>{d.pageCount}</b><span>หน้าเอกสาร</span></div>
					<div className="attn"><b>{d.attention}</b><span>ต้องตรวจสอบ</span></div>
					<div className={pending ? "attn" : undefined}>
						<b>{pending || d.excluded.length}</b>
						<span>{pending ? "ตัดออก — รอตัดสินใจ" : "ตัดออก — ตัดสินใจแล้ว"}</span>
					</div>
				</div>
			</div>
			<div className="run-head-actions">
				<button type="button" className="btn btn-ghost" onClick={actions.toggleRunHistory}>
					<RerunIcon />ประวัติการรัน {runs.length} รอบ
				</button>
				<button type="button" className="btn btn-ghost" onClick={() => startWorkflowRun(c.p.id, c.args.pi, c.args.key)}>
					<PlayIcon />รันใหม่
				</button>
				<button type="button" className="btn btn-ghost" onClick={closeRunReview}>
					<LinkIcon />กลับไปติ๊กเกทในเฟส "{phaseName}"
				</button>
				<span className="run-head-note">
					ผลรอบนี้เป็นหลักฐานของเกท {att.evidence.length ? att.evidence.join(" · ") : "—"} — ระบบเซ็นแทนคนไม่ได้
				</span>
			</div>
			<div className="run-head-drawer" hidden={!ui.runHistoryOpen}>
				<p className="permissions-caption">
					รันใหม่ได้เสมอ และไม่ทับของเดิม — ทุกรอบเก็บไว้ทั้งหมด ขอบเขตยังเป็นลูกค้าและงวดเดิมของโปรเจกต์นี้
				</p>
				{runs.map((r) => {
					const openable = r.state === "done";
					return (
						<div
							className={"contact-row run-hist-row" + (openable ? " openable" : "")}
							key={r.no}
							onClick={openable ? () => openRunReview(c.p.id, c.args.pi, c.args.key, r.no) : undefined}
						>
							<div className="contact-main">
								<span className="contact-name">
									รอบที่ {r.no}
									{r.no === run.no ? <> <span className="pill pill-current">กำลังดูอยู่</span></> : null}
									{r.state === "failed" ? <> <span className="pill pill-blocked">ไม่สำเร็จ</span></> : null}
								</span>
								<span className="contact-role">
									{r.state === "done" ? "เสร็จ " + r.finishedAt : r.state === "failed" ? "ไม่สำเร็จ " + r.finishedAt : "กำลังรัน"}
									{" · "}{wf.actor}
								</span>
							</div>
							<span className="contact-meta">{openable ? "เปิดดูผล" : "—"}</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}
