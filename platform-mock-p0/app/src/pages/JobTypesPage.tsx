// "ประเภทงาน" — admin screen proving JOB_TYPES is genuinely open-ended,
// not a bigger hardcoded list. Create/edit a job type's name, and a
// nested Phase -> Gate structure: each Phase has its own repeatable list
// of named Gates, each with a "required" flag. This is the TEMPLATE only
// — a project's recorded work (PROJECTS[i].work) is separate; editing
// here re-shapes the checklist a project renders (ensureWork() re-aligns
// it) but never rewrites who did what.
// In-memory only, like everything else here: refresh resets JOB_TYPES.
//
// Two columns (round 8): the list of job types on the left, the add/edit panel
// on the right at the SAME scroll position, so reaching either never needs a
// scroll.
import { useState } from "react";
import { JOB_TYPES } from "../state/stores";
import { showToast } from "../state/session";
import { useApp } from "../state/AppContext";
import { PlusIcon } from "../components/Icons";
import { jobTypeByKey } from "../domain/jobTypes";
import { PhaseBlock } from "./jobTypes/PhaseBlock";
import { draftToPhases, jobTypeDraft, phaseDraft, type PhaseDraft } from "./jobTypes/draft";

export function JobTypesPage() {
	const { bump, version } = useApp();
	void version;
	const [editingKey, setEditingKey] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [phases, setPhases] = useState<PhaseDraft[]>(() => jobTypeDraft());

	function resetForm() {
		setEditingKey(null);
		setName("");
		setPhases(jobTypeDraft());
	}
	function startEdit(key: string) {
		const jt = jobTypeByKey(key)!;
		setEditingKey(key);
		setName(jt.name);
		// No scrollIntoView any more (round 8): the editor sits beside the list
		// at the same scroll position, so it is already in view.
		setPhases(jobTypeDraft(jt));
	}
	function submit() {
		const trimmed = name.trim();
		const built = draftToPhases(phases);
		if (!trimmed || !built) {
			showToast("กรอกชื่อประเภทงาน อย่างน้อย 1 Phase และแต่ละ Phase ต้องมีอย่างน้อย 1 Gate ก่อนบันทึก");
			return;
		}
		if (editingKey) {
			const existing = jobTypeByKey(editingKey)!;
			existing.name = trimmed;
			existing.phases = built;
			showToast('แก้ไขประเภทงาน "' + trimmed + '" แล้ว (มอคเท่านั้น ไม่บันทึกถาวร)');
		} else {
			const key = "custom-" + JOB_TYPES.length + "-" + trimmed;
			JOB_TYPES.push({ key: key, name: trimmed, phases: built });
			showToast('เพิ่มประเภทงาน "' + trimmed + '" แล้ว (มอคเท่านั้น ไม่บันทึกถาวร)');
		}
		resetForm();
		bump();
	}

	return (
		<>
			<div className="page-header">
				<h2>ประเภทงาน</h2>
				<p className="page-sub">
					แต่ละประเภทงานมีลำดับ Phase ของตัวเอง — ผู้ดูแลระบบสร้าง/แก้ไขได้ที่นี่ ไม่ใช่ค่าคงที่ในโค้ด (มอคเท่านั้น ไม่บันทึกถาวร รีเฟรชแล้วรีเซ็ต)
				</p>
			</div>

			<div className="jobtype-layout">
				<div className="jobtype-list-col">
					<div id="job-types-list">
						{JOB_TYPES.map((jt) => {
							const gateCount = jt.phases.reduce((n, ph) => n + ph.gates.length, 0);
							const wfCount = jt.phases.reduce((n, ph) => n + (ph.workflows || []).length, 0);
							const selected = jt.key === editingKey;
							return (
								// One summary line instead of a chip per Phase: 4-5 job types
								// have to fit in the column without scrolling, and the full
								// Phase→Gate breakdown is right there in the editor.
								<div className={"customer-row jobtype-row" + (selected ? " selected" : "")} key={jt.key} onClick={() => startEdit(jt.key)}>
									<div className="customer-row-main">
										<span className="customer-row-name">
											{jt.name}
											{selected ? <> <span className="pill pill-current">กำลังแก้ไข</span></> : null}
										</span>
										<div className="jobtype-row-summary">
											{jt.phases.length} เฟส · {gateCount} เกท{wfCount ? " · " + wfCount + " เวิร์กโฟลว์" : ""}
										</div>
									</div>
								</div>
							);
						})}
					</div>
					{/* The "add new" button is the list's own entry for the editor's
					    empty state, so it reads as selected whenever nothing is being
					    edited. */}
					<button type="button" className={"btn btn-ghost jobtype-add-btn" + (editingKey ? "" : " selected")} onClick={resetForm}>
						<PlusIcon />
						เพิ่มประเภทงานใหม่
					</button>
				</div>

				<div className="jobtype-form-col">
					<div className="permissions-card">
						<div className="permissions-head">
							{editingKey ? "แก้ไขประเภทงาน: " + (jobTypeByKey(editingKey)?.name || "") : "เพิ่มประเภทงานใหม่"}
						</div>
						<div className="field">
							<label htmlFor="job-type-name-input">ชื่อประเภทงาน</label>
							<input id="job-type-name-input" type="text" placeholder="เช่น รายปี" value={name} onChange={(e) => setName(e.target.value)} />
						</div>
						<div className="field">
							<label>Phase ตามลำดับ (แต่ละ Phase มี Gate ของตัวเอง)</label>
							<div id="job-type-phases-inputs">
								{phases.map((ph, pi) => (
									<PhaseBlock
										key={pi}
										phase={ph}
										onChange={(next) => setPhases(phases.map((x, i) => (i === pi ? next : x)))}
										onRemove={() => setPhases(phases.filter((_x, i) => i !== pi))}
									/>
								))}
							</div>
							<button type="button" className="btn btn-ghost btn-with-icon" style={{ marginTop: "6px" }} onClick={() => setPhases(phases.concat([phaseDraft()]))}>
								<PlusIcon />
								เพิ่ม Phase
							</button>
						</div>
						<div style={{ display: "flex", gap: "8px", marginTop: "14px" }}>
							<button type="button" className="btn btn-run" onClick={submit}>
								{editingKey ? "บันทึกการแก้ไข" : "บันทึกประเภทงาน"}
							</button>
							<button type="button" className="btn btn-ghost" onClick={resetForm} hidden={!editingKey}>ยกเลิกแก้ไข</button>
						</div>
					</div>
				</div>
			</div>
		</>
	);
}
