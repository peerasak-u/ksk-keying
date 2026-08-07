import type { JobType, GateRule, PhaseWorkflowAttachment } from "../types";
import { JOB_TYPE_SEED } from "./jobTypes";

// ---- two per-Gate template fields added in round 10, kept in one table
// beside the workbook copy rather than sprinkled through it, so the block
// above stays exactly what the sheet says and every addition here can be
// read (and argued with) in one place. Both are merged onto the Gate
// objects at load, and both are editable in the ประเภทงาน editor.
//
// `due` — a deadline RULE, never a fixed calendar date. Two forms only:
//   { dayOfMonth: 7, monthOffset: 1 } — "วันที่ 7 ของเดือนถัดจากงวด"
//   { offsetDays: 10 }                — "ภายใน 10 วันนับจากวันเปิดงวด"
// The concrete date is derived per project from its own งวด (see
// gateDueDate()). Every dayOfMonth rule here comes from the sheet's own
// หมายเหตุ text — "กำหนดยื่นวันที่ 7 (e-Filing วันที่ 15)" and
// "กำหนดยื่นวันที่ 15" — which until now sat there as unparsed prose. The
// offsetDays rules are office practice for the document chase, stated as
// a rule so they can be argued with and edited rather than assumed.
//
// `review` — which rung of the office's review ladder this Gate has to
// reach: "deputy" (the default, unstated), "lead", or "coo". Set only
// where the sheet's own wording names the reviewer ("ส่งแบบทั้งหมดให้
// หัวหน้าทีมตรวจสอบ", "หัวหน้าทีม/CFO สอบทานร่างงานก่อนส่ง") or where the
// work is a CPA matter (งบการเงิน, ภ.ง.ด.50) — the COO step the office's
// own chart marks "เฉพาะประเด็นสำคัญ".
export const GATE_RULES: Record<string, Record<string, GateRule>> = {
	monthly: {
		"1.1": { due: { offsetDays: 3 } },
		"1.2": { due: { offsetDays: 10 } },
		"1.3": { due: { offsetDays: 10 } },
		"3.1": { due: { dayOfMonth: 7, monthOffset: 1 } },
		"3.2": { due: { dayOfMonth: 15, monthOffset: 1 } },
		"3.4": { due: { dayOfMonth: 15, monthOffset: 1 } },
		"3.5": { review: "lead" },
		"5.1": { review: "lead" },
		"5.2": { review: "coo" },
		"5.4": { review: "coo" },
	},
	yearly: {
		"1.1": { due: { offsetDays: 3 } },
		"1.2": { due: { offsetDays: 14 } },
		"3.1": { due: { dayOfMonth: 7, monthOffset: 1 } },
		"3.2": { due: { dayOfMonth: 15, monthOffset: 1 } },
		"3.4": { due: { dayOfMonth: 15, monthOffset: 1 } },
		"3.5": { review: "lead" },
		"5.1": { review: "lead" },
		"5.2": { review: "coo" },
		"5.4": { review: "coo" },
	},
	consult: {
		"1.1": { due: { offsetDays: 3 } },
		"1.2": { due: { offsetDays: 10 } },
		"3.4": { review: "lead" },
		"4.1": { due: { offsetDays: 25 } },
	},
	project: {
		"2.2": { due: { offsetDays: 14 } },
		"4.1": { review: "lead" },
	},
	registry: {
		"2.1": { due: { offsetDays: 10 } },
		"2.4": { review: "lead" },
	},
};
function applyGateRules(JOB_TYPES: JobType[]) {
	JOB_TYPES.forEach(function (jt) {
		var table = GATE_RULES[jt.key];
		if (!table) return;
		jt.phases.forEach(function (ph) {
			ph.gates.forEach(function (g) {
				var extra = table[g.code];
				if (!extra) return;
				if (extra.due) g.due = extra.due;
				if (extra.review) g.review = extra.review;
			});
		});
	});
}

// Which Phase of which job type carries which workflow — kept beside the
// workbook copy (exactly like GATE_RULES) rather than sprinkled into it,
// and merged onto the Phase objects at load. `evidence` lists the Gate
// codes this workflow's result is genuinely evidence FOR; a Gate not
// listed simply has nothing to do with it. Both fields are editable on the
// ประเภทงาน screen — attaching a workflow is a template-level choice,
// alongside the Phase's Gates.
export const PHASE_WORKFLOWS: Record<string, Record<string, PhaseWorkflowAttachment[]>> = {
	monthly: {
		"บันทึกบัญชี": [{ key: "ksk-keying", evidence: ["2.1", "2.2", "2.3", "2.4"] }],
	},
};
function applyPhaseWorkflows(JOB_TYPES: JobType[]) {
	JOB_TYPES.forEach(function (jt) {
		var table = PHASE_WORKFLOWS[jt.key];
		if (!table) return;
		jt.phases.forEach(function (ph) {
			var atts = table[ph.name];
			if (atts) ph.workflows = atts.map(function (a) { return { key: a.key, evidence: (a.evidence || []).slice() }; });
		});
	});
}

// The seed is the workbook copy; the two tables above are merged onto it once,
// at module load, exactly as the legacy mock's two IIFEs did. Everything after
// this point (including the ประเภทงาน editor) works on the merged list.
export function buildJobTypes(): JobType[] {
	const jobTypes = JOB_TYPE_SEED;
	applyGateRules(jobTypes);
	applyPhaseWorkflows(jobTypes);
	return jobTypes;
}
