// One Phase of the ประเภทงาน editor: its name, the workflows attached to it,
// and its own repeatable list of Gate rows.
//
// A Gate row is two lines: the name + บังคับ flag, and the Gate's due-date RULE
// right beside them — because a deadline that is only prose in a หมายเหตุ
// column cannot be counted, and a fixed calendar date typed in by hand would be
// wrong the next งวด. Two forms, both computable from the project's own งวด.
import { WORKFLOWS, workflowByKey } from "../../data/workflows";
import { showToast } from "../../state/session";
import { CpuIcon, PlusIcon } from "../../components/Icons";
import type { GateDraft, PhaseDraft } from "./draft";
import { gateDraft } from "./draft";

const MONTH_OPTS = [
	{ v: 0, l: "เดือนงวด" }, { v: 1, l: "เดือนถัดจากงวด" },
	{ v: 2, l: "2 เดือนหลังงวด" }, { v: 3, l: "3 เดือนหลังงวด" },
];

function CloseX() {
	return (
		<svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
	);
}

function GateRow({ gate, onChange, onRemove }: { gate: GateDraft; onChange: (g: GateDraft) => void; onRemove: () => void }) {
	return (
		<div className="gate-input-block">
			<div className="phase-input-row gate-input-row">
				<input
					type="text"
					className="phase-input gate-name-input"
					value={gate.name}
					placeholder="ชื่อ Gate"
					onChange={(e) => onChange({ ...gate, name: e.target.value })}
				/>
				<label className="gate-required-label">
					<input
						type="checkbox"
						className="gate-required-input"
						checked={gate.required}
						onChange={(e) => onChange({ ...gate, required: e.target.checked })}
					/>{" "}
					บังคับ
				</label>
				<button type="button" className="btn btn-ghost phase-input-remove" onClick={onRemove} title="ลบ Gate นี้">
					<CloseX />
				</button>
			</div>
			<div className="gate-due-row">
				<span>กำหนดส่ง</span>
				<select
					className="gate-due-kind"
					value={gate.dueKind}
					onChange={(e) => onChange({ ...gate, dueKind: e.target.value as GateDraft["dueKind"] })}
				>
					<option value="">ไม่กำหนด</option>
					<option value="dom">วันที่ของเดือน</option>
					<option value="offset">นับจากวันเปิดงวด</option>
				</select>
				<span className="gate-due-dom" hidden={gate.dueKind !== "dom"}>
					วันที่{" "}
					<input
						type="number"
						min="1"
						max="31"
						className="due-num gate-due-day"
						value={gate.dueDay}
						onChange={(e) => onChange({ ...gate, dueDay: parseInt(e.target.value, 10) })}
					/>{" "}
					<select className="gate-due-month" value={gate.dueMonth} onChange={(e) => onChange({ ...gate, dueMonth: parseInt(e.target.value, 10) })}>
						{MONTH_OPTS.map((o) => <option value={o.v} key={o.v}>{o.l}</option>)}
					</select>
				</span>
				<span className="gate-due-offset" hidden={gate.dueKind !== "offset"}>
					ภายใน{" "}
					<input
						type="number"
						min="1"
						max="365"
						className="due-num gate-due-days"
						value={gate.dueDays}
						onChange={(e) => onChange({ ...gate, dueDays: parseInt(e.target.value, 10) })}
					/>{" "}
					วันนับจากวันเปิดงวด
				</span>
				<span className="gate-due-preview">{gate.dueKind ? "" : "ไม่มีกำหนดส่งสำหรับเกทนี้"}</span>
			</div>
		</div>
	);
}

export function PhaseBlock({ phase, onChange, onRemove }: { phase: PhaseDraft; onChange: (p: PhaseDraft) => void; onRemove: () => void }) {
	// The Gate รหัส currently written in this Phase block — read from the draft,
	// so evidence can be pointed at a Gate that was just edited in this session.
	const gateCodes = phase.gates.map((g) => g.code).filter(Boolean);

	function addWorkflow(key: string) {
		if (!key) return;
		if (phase.workflows.some((w) => w.key === key)) { showToast("เฟสนี้แนบเวิร์กโฟลว์นี้ไว้แล้ว"); return; }
		// Fold the picker back up, so a Phase never sits there with an open
		// select nobody asked for.
		onChange({ ...phase, workflows: phase.workflows.concat([{ key: key, evidence: [] }]), pickerOpen: false });
	}

	const attachRows = phase.workflows.map((att, wi) => {
		const wf = workflowByKey(att.key);
		if (!wf) return null;
		return (
			<div className="wf-attach-row" data-key={att.key} key={att.key}>
				<div className="wf-attach-head">
					<CpuIcon />
					<span className="wf-attach-name">{wf.name}</span>
					<button
						type="button"
						className="btn btn-ghost phase-input-remove"
						title="เอาเวิร์กโฟลว์นี้ออก"
						onClick={() => onChange({ ...phase, workflows: phase.workflows.filter((_w, i) => i !== wi) })}
					>
						<CloseX />
					</button>
				</div>
				<p className="wf-desc">{wf.desc}</p>
				<div className="wf-attach-ev">ผลของเวิร์กโฟลว์นี้เป็นหลักฐานของเกทข้อไหน (กดเลือกได้หลายข้อ)</div>
				<div className="wf-attach-chips">
					{gateCodes.length ? (
						gateCodes.map((code) => (
							<button
								type="button"
								key={code}
								className={"doc-step" + (att.evidence.indexOf(code) !== -1 ? " on" : "")}
								data-code={code}
								onClick={() => {
									const on = att.evidence.indexOf(code) !== -1;
									const evidence = on ? att.evidence.filter((c) => c !== code) : att.evidence.concat([code]);
									onChange({ ...phase, workflows: phase.workflows.map((w, i) => (i === wi ? { ...w, evidence } : w)) });
								}}
							>
								{code}
							</button>
						))
					) : (
						<span className="wf-attach-empty">Gate ในเฟสนี้ยังไม่มีรหัส — บันทึกก่อนแล้วกลับมาเลือกได้</span>
					)}
				</div>
			</div>
		);
	});

	return (
		<div className="phase-block">
			<div className="phase-input-row">
				<input
					type="text"
					className="phase-input phase-name-input"
					value={phase.name}
					placeholder="ชื่อ Phase"
					onChange={(e) => onChange({ ...phase, name: e.target.value })}
				/>
				<button type="button" className="btn btn-ghost phase-input-remove" onClick={onRemove} title="ลบ Phase นี้">
					<CloseX />
				</button>
			</div>

			{/* Most Phases carry nothing, so a Phase with no workflow shows exactly
			    one small ghost button and no box at all; the label only appears
			    once there is something for it to label. */}
			<div className="wf-attach">
				{phase.workflows.length ? (
					<div className="wf-attach-label">เวิร์กโฟลว์อัตโนมัติของเฟสนี้ — แนบได้มากกว่าหนึ่งอัน ผลที่ได้เป็นหลักฐาน ไม่ใช่การเซ็นแทนคน</div>
				) : null}
				<div className="wf-attach-list">{attachRows}</div>
				<button
					type="button"
					className="btn btn-ghost btn-with-icon wf-attach-toggle"
					hidden={phase.pickerOpen}
					onClick={() => onChange({ ...phase, pickerOpen: true })}
				>
					<PlusIcon />
					{phase.workflows.length ? "แนบเวิร์กโฟลว์อีกอัน" : "แนบเวิร์กโฟลว์อัตโนมัติ"}
				</button>
				<div className="wf-attach-pick" hidden={!phase.pickerOpen}>
					<select className="wf-attach-select" defaultValue={WORKFLOWS[0] ? WORKFLOWS[0].key : ""} id={"wf-pick-" + phase.name}>
						{WORKFLOWS.map((w) => <option value={w.key} key={w.key}>{w.name}</option>)}
					</select>
					<button
						type="button"
						className="btn btn-ghost btn-with-icon"
						onClick={(e) => {
							const sel = (e.currentTarget.parentElement as HTMLElement).querySelector(".wf-attach-select") as HTMLSelectElement | null;
							addWorkflow(sel ? sel.value : "");
						}}
					>
						<PlusIcon />
						แนบเวิร์กโฟลว์
					</button>
				</div>
			</div>

			<div className="gates-inputs">
				{phase.gates.map((g, gi) => (
					<GateRow
						key={gi}
						gate={g}
						onChange={(next) => onChange({ ...phase, gates: phase.gates.map((x, i) => (i === gi ? next : x)) })}
						onRemove={() => onChange({ ...phase, gates: phase.gates.filter((_x, i) => i !== gi) })}
					/>
				))}
			</div>
			<button
				type="button"
				className="btn btn-ghost btn-with-icon add-gate-btn"
				onClick={() => onChange({ ...phase, gates: phase.gates.concat([gateDraft()]) })}
			>
				<PlusIcon />
				เพิ่ม Gate
			</button>
		</div>
	);
}
