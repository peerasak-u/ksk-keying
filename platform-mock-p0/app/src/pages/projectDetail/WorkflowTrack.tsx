// The workflow's own track, drawn INSIDE the Phase panel but outside the
// checklist: its state never gates a tick, and a tick never gates it.
import type { PhaseWorkflowAttachment, Project } from "../../types";
import { workflowByKey } from "../../data/workflows";
import { customerName } from "../../domain/projects";
import { getRun, getRuns, startWorkflowRun, wfElementId } from "../../domain/runs";
import { wfRunData } from "../../domain/runData";
import { useOpenRunReview } from "../../navigation";
import { AlertIcon, CpuIcon, DocIcon, LinkIcon, LockIcon, PlayIcon, RerunIcon } from "../../components/Icons";

export function WorkflowTrack({ p, pi, att }: { p: Project; pi: number; att: PhaseWorkflowAttachment }) {
	const openRunReview = useOpenRunReview();
	const wf = workflowByKey(att.key)!;
	const run = getRun(p.id, pi, att.key);
	const state = run ? run.state : "idle";
	const statePill =
		state === "queued" ? <span className="pill pill-auto">เข้าคิวแล้ว</span> :
		state === "running" ? <span className="pill pill-doing">กำลังรัน</span> :
		state === "done" ? <span className="pill pill-passed">รันเสร็จแล้ว</span> :
		state === "failed" ? <span className="pill pill-blocked">รันไม่สำเร็จ</span> : null;

	const history = getRuns(p.id, pi, att.key);

	return (
		<section className="wf-track" id={wfElementId(p.id, pi, att.key)}>
			<div className="wf-head">
				<CpuIcon />
				<span className="wf-name">{wf.name}</span>
				<span className="pill pill-auto">ระบบอัตโนมัติ</span>
				{statePill}
			</div>

			<p className="wf-desc">{wf.desc}</p>
			<div className="wf-context">
				<LockIcon />
				<span>
					ขอบเขตของรอบนี้: ลูกค้า <strong>{customerName(p.customerId)}</strong> · {p.periodLabel} — กำหนดจากโปรเจกต์นี้ ไม่ต้องเลือกใหม่ตอนสั่งรัน
				</span>
			</div>

			{state === "queued" || state === "running" ? (
				<>
					<div className="wf-bar">
						<span className="fill" style={{ width: Math.round((Math.max(0, run!.step + 1) / wf.steps.length) * 100) + "%" }}></span>
					</div>
					<div className="wf-step">
						{state === "queued"
							? "รอคิวว่าง…"
							: "ขั้นที่ " + Math.max(0, run!.step + 1) + "/" + wf.steps.length + " · " + wf.steps[run!.step]}
					</div>
					<div className="wf-stamp">รันโดย {wf.actor} · รอบที่ {run!.no}</div>
				</>
			) : null}

			{state === "done" ? (
				<>
					<div className="wf-result">
						ผลของรอบนี้
						<ul>{wf.result(wfRunData(p, run!)).map((line, i) => <li key={i}>{line}</li>)}</ul>
					</div>
					<div className="wf-stamp">รันโดย {wf.actor} · รอบที่ {run!.no} · เสร็จ {run!.finishedAt}</div>
				</>
			) : null}

			{state === "failed" ? (
				<>
					<div className="wf-fail"><AlertIcon /><span>{run!.failWhy}</span></div>
					<div className="wf-stamp">รันโดย {wf.actor} · รอบที่ {run!.no} · หยุด {run!.finishedAt}</div>
				</>
			) : null}

			{/* Where the result is genuinely evidence for a Gate, say which Gate —
			    and say, in the same breath, that it is evidence and nothing more. */}
			{(att.evidence || []).length ? (
				<div className="wf-evidence">
					<LinkIcon />
					<span>
						ผลของเวิร์กโฟลว์นี้เป็นหลักฐานประกอบของเกท{" "}
						{att.evidence.map((c, i) => <span key={c}>{i > 0 ? " · " : ""}<code>{c}</code></span>)}
						{" — คนยังต้องติ๊กและผู้สอบทานเซ็นเองทุกข้อ ระบบเซ็นแทนไม่ได้"}
					</span>
				</div>
			) : null}

			<div className="wf-actions">
				{/* On a finished run, going in to read what it produced IS the action
				    of this card — the one place blue is earned here. */}
				{state === "done" ? (
					<button type="button" className="btn btn-run btn-with-icon" onClick={() => openRunReview(p.id, pi, att.key, run!.no)}>
						<DocIcon />
						เปิดผลการรันเพื่อตรวจ
					</button>
				) : null}
				{state === "queued" || state === "running" ? (
					<button type="button" className="btn btn-ghost" disabled><RerunIcon />กำลังรัน…</button>
				) : (
					<button type="button" className="btn btn-ghost" onClick={() => startWorkflowRun(p.id, pi, att.key)}>
						{state === "idle" ? <><PlayIcon />เริ่มรัน</> : <><RerunIcon />รันใหม่</>}
					</button>
				)}
				<span className="wf-stamp" style={{ margin: 0 }}>เช็กลิสต์ด้านล่างทำมือได้ตลอด ไม่ต้องรอรอบนี้</span>
			</div>

			{/* Ran, reviewed, re-ran — visible as a record on the card itself. */}
			{history.length > 1 ? (
				<div className="wf-stamp">
					{"ประวัติการรัน " + history.length + " รอบ · " +
						history.slice().reverse().map((r) =>
							"รอบที่ " + r.no + " " + (r.state === "done" ? "เสร็จ" : r.state === "failed" ? "ไม่สำเร็จ" : "กำลังรัน")).join(" · ")}
				</div>
			) : null}
		</section>
	);
}
