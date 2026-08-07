import type { Workflow, WorkflowRunData } from "../types";

// ================= automation workflows (round 11) =================
//
// The office is separately building an automated keying pipeline (the KSK
// Keying app). It overlaps Phase 2 บันทึกบัญชี, and the settled rule for how
// the two systems meet — data/ksk-console-platform-design/report.md §4.2 —
// is one-directional:
//
//   "the entire keying pipeline is one piece of evidence for one
//    requirement inside one Phase Gate: Phase 2, บันทึกบัญชี"
//
// So a workflow here is NOT a Phase, NOT a Gate, and NOT a status a Gate
// can be in. It is a separate, configurable thing that an admin ATTACHES to
// a Phase, and whose result is evidence a person reads before ticking. The
// same document's open decision #4 settles the other half: no auto-pass —
// automation may report its own result, it may never sign a checklist item
// that carries a human reviewer. Nothing below ever writes ผู้ทำ or
// ผู้สอบทาน; the automation only ever appears under its own `actor` name.
//
// A catalogue, not a hardcoded single integration — but a catalogue whose
// seed tells the truth (round 12, captain): the office has exactly ONE
// automation today, the KSK Keying pipeline, so that is the only entry
// here and the only attachment in PHASE_WORKFLOWS. Plausible-but-invented
// workflows were removed because a viewer being walked through this mock
// cannot tell an illustration from a thing that exists.
//
// What did NOT change is the shape: WORKFLOWS is a list an admin picks
// FROM, `phase.workflows` is a LIST so a Phase may carry more than one,
// and the ประเภทงาน editor can attach to any Phase of any job type. The
// seed is small; the model is not.
export const WORKFLOWS: Workflow[] = [
	{
		key: "ksk-keying",
		name: "รอบคีย์เอกสาร (KSK Keying)",
		// The automation's own name, used everywhere a person's name would
		// otherwise appear. It is never a value in the ผู้ทำ/ผู้สอบทาน
		// dropdowns — those are people, and stay people.
		actor: "ระบบคีย์เอกสาร KSK (อัตโนมัติ)",
		desc: "อ่านเอกสารทั้งงวดจากโฟลเดอร์ลูกค้า แยกชุด ตีความทีละใบ จับรายการที่เป็นธุรกรรมเดียวกัน ลงรหัสบัญชีตามผังบัญชีของลูกค้า แล้วออกไฟล์ PEAK import พร้อมหน้ารีวิวให้คนตรวจ",
		steps: [
			"อ่านโฟลเดอร์งวดและแยกชุดเอกสาร",
			"ตีความเอกสารทีละชุด",
			"จับรายการที่เป็นธุรกรรมเดียวกัน",
			"จัดกลุ่มตามประเภทและ VAT",
			"ลงรหัสบัญชีตามผังบัญชีลูกค้า",
			"สร้างหน้ารีวิวให้คนตรวจ",
			"ออกไฟล์ PEAK import",
		],
		// Reads the run's own result set, so the summary on the card and
		// the review screen behind it can never disagree.
		result: function (d: WorkflowRunData) {
			return [
				"เอกสาร " + d.totalUnits + " หน้า/รายการ · จัดกลุ่มได้ " + d.groupCount + " กลุ่ม",
				"ทำเครื่องหมายให้คนตรวจ " + d.attention + " กลุ่ม · เสนอตัดออก " + d.excluded.length + " รายการ (ข้อเสนอ — รอคนตัดสิน)",
				"ไฟล์ PEAK import พร้อมให้ตรวจ — ยังไม่ได้ import เข้า PEAK",
			];
		},
	},
];

export function workflowByKey(key: string): Workflow | null {
	for (let i = 0; i < WORKFLOWS.length; i++) if (WORKFLOWS[i].key === key) return WORKFLOWS[i];
	return null;
}
