import type { Project } from "../types";

// The single master project list — the whole mock (My work, Customers,
// Month board, Project detail, the office overview) reads from this one
// list instead of each screen holding its own copy, so "same client, two
// job types" and "same project shown from four different screens" can
// never drift apart.
//
// A project's checklist is not authored per project: it is built from its
// job type's template by ensureWork() below, so two projects of the same
// job type can never drift apart and an admin editing the template is
// visible in every project that uses it. `seed` is only the demo starting
// position for that generated checklist, expressed against the CURRENT
// phase's gate indices:
//   pastDate  — วันที่เสร็จ stamped on every Gate of the already-passed Phases
//   done      — the first N Gates of the current Phase are fully closed
//   doing     — indices sitting at สถานะ "กำลังทำ"
//   awaiting  — indices the doer marked "เสร็จ" but nobody has signed
//               ผู้สอบทาน for yet: this, and ONLY this, is what puts a
//               project into the "ต้องการการตรวจสอบ" state anywhere in
//               the app. No project carries that state as a literal flag.
//   notes     — seeded หมายเหตุ text per gate index
// Nothing here is persisted; refresh resets every tick back to this.
//
// Round 10 changes two things about a project:
//   - the hand-written `reviewer` field is GONE. Who a Gate lands on is
//     now derived from the assignee's TEAM and the Gate's own rung
//     (reviewerFor()), so it can never disagree with the office's real
//     review ladder or go stale when work moves between teams.
//   - `docState` recorded where this งวด sat on the office's six-step
//     document-chase ladder. Round 20 DELETED it: it duplicated Phase 1's
//     own Gates. `seed.docs` ("asked" / "none" / "in") now describes the
//     demo's starting document situation and is applied to those Gates
//     once, by applyDocSeed().
export const PROJECT_SEED: Project[] = [
	{
		id: "srichai-monthly-jul", customerId: "srichai", assignee: "นัท",
		jobType: "monthly", periodLabel: "งวดเดือนกรกฎาคม 2569", monthKey: "2569-07",
		phaseIndex: 0,
		seed: {
			docs: "asked",
			pastDate: "3/8/2569", done: 5, awaiting: [5],
			notes: { 5: "พบเอกสารซ้ำ 2 รายการ — ขอให้ผู้สอบทานยืนยันก่อนปิดเกท" },
		},
		status: "today", actionLabel: "เปิดเช็กลิสต์",
	},
	{
		// Same customer as above, different job type — a separate
		// project, never merged into it. Consult work sits with team 3.
		id: "srichai-consult-jul", customerId: "srichai", assignee: "ข้าวหอม",
		jobType: "consult", periodLabel: "รอบเดือนกรกฎาคม 2569", monthKey: "2569-07",
		phaseIndex: 1,
		seed: { docs: "in", pastDate: "28/7/2569", done: 2, doing: [2] },
		status: "today", actionLabel: "เปิดเช็กลิสต์", primary: true,
	},
	{
		id: "ex2-monthly-jun", customerId: "ex2", assignee: "นัท",
		jobType: "monthly", periodLabel: "งวดเดือนมิถุนายน 2569", monthKey: "2569-06",
		phaseIndex: 0,
		seed: {
			docs: "none",
			pastDate: "2/8/2569", done: 1, awaiting: [5], doing: [2],
			notes: { 5: "ผังบัญชีอ่านไม่ได้ ต้องขอไฟล์ใหม่จากลูกค้า — รอผู้สอบทานตัดสิน" },
		},
		status: "today", actionLabel: "เปิดเช็กลิสต์",
	},
	{
		id: "ex3-monthly-may", customerId: "ex3", assignee: "ริบบิ้น",
		jobType: "monthly", periodLabel: "งวดเดือนพฤษภาคม 2569", monthKey: "2569-05",
		phaseIndex: 1,
		seed: {
			docs: "in",
			pastDate: "20/7/2569", done: 4, doing: [4],
			notes: { 4: "รอยืนยันรายการที่ตัดออก 4 รายการ" },
		},
		status: "today", actionLabel: "เปิดเช็กลิสต์",
	},
	{
		id: "ex4-project-aug", customerId: "ex4", assignee: "ไหม",
		jobType: "project", periodLabel: "เริ่ม 1 สิงหาคม 2569", monthKey: "2569-08",
		phaseIndex: 2,
		seed: { docs: "in", pastDate: "31/7/2569", done: 2, doing: [2] },
		status: "today", actionLabel: "เปิดเช็กลิสต์",
	},
	{
		id: "ex5-monthly-jul", customerId: "ex5", assignee: "แอ๊ว",
		jobType: "monthly", periodLabel: "งวดเดือนกรกฎาคม 2569", monthKey: "2569-07",
		phaseIndex: 3,
		seed: {
			docs: "in",
			pastDate: "1/8/2569", done: 1, doing: [3],
			notes: { 3: "กระทบยอดกับทะเบียนทรัพย์สินแล้ว 9 รายการ เหลือรอตรวจ" },
		},
		status: "today", actionLabel: "เปิดเช็กลิสต์", primary: true,
	},
	{
		id: "ex2-consult-jul", customerId: "ex2", assignee: "หยกหลิน",
		jobType: "consult", periodLabel: "รอบเดือนกรกฎาคม 2569", monthKey: "2569-07",
		phaseIndex: 0,
		seed: { docs: "asked", pastDate: "22/7/2569", done: 1, doing: [1] },
		status: "today", actionLabel: "เปิดเช็กลิสต์",
	},
	{
		// An intern-owned registry job with a Gate already ticked and
		// sitting on a reviewer's desk — this is what makes "ต้องการการ
		// ตรวจสอบ" appear for ตันหยง (รองหัวหน้าทีม) without her being the
		// assignee: she is simply the first rung of the ladder above the
		// person who did the work.
		id: "ex4-registry-aug", customerId: "ex4", assignee: "หยกหลิน",
		jobType: "registry", periodLabel: "แจ้งเปลี่ยนกรรมการ — เริ่ม 28 กรกฎาคม 2569", monthKey: "2569-08",
		phaseIndex: 1,
		seed: {
			docs: "in",
			pastDate: "30/7/2569", done: 3, awaiting: [3],
			notes: { 3: "จัดแบบครบแล้ว รอหัวหน้าทีมตรวจก่อนส่งลูกค้าเซ็น" },
		},
		status: "today", actionLabel: "เปิดเช็กลิสต์",
	},
	{
		// A team lead carries customers of her own — leaders in this
		// office are not managers-only. Her work climbs the ladder past
		// herself and lands on the COO.
		id: "ex3-yearly-2568", customerId: "ex3", assignee: "ปุ๊ก",
		jobType: "yearly", periodLabel: "ปีบัญชี 2568 (เอกสารถึงเดือนมิถุนายน)", monthKey: "2569-07",
		phaseIndex: 0,
		seed: { docs: "asked", pastDate: "15/7/2569", done: 4, doing: [4] },
		status: "today", actionLabel: "เปิดเช็กลิสต์",
	},
	{
		id: "ex4-monthly-jul", customerId: "ex4", assignee: "แพรว",
		jobType: "monthly", periodLabel: "งวดเดือนกรกฎาคม 2569", monthKey: "2569-07",
		phaseIndex: 3,
		seed: { docs: "in", pastDate: "1/8/2569", done: 1, doing: [7] },
		status: "on-track", actionLabel: "ดูรายละเอียด",
	},
	{
		id: "srichai-monthly-jun", customerId: "srichai", assignee: "นัท",
		jobType: "monthly", periodLabel: "งวดเดือนมิถุนายน 2569", monthKey: "2569-06",
		phaseIndex: 4,
		seed: { docs: "in", pastDate: "24/7/2569", done: 8 },
		status: "on-track", actionLabel: "ดูรายละเอียด",
	},
	{
		id: "ex5-monthly-jun", customerId: "ex5", assignee: "แอ๊ว",
		jobType: "monthly", periodLabel: "งวดเดือนมิถุนายน 2569", monthKey: "2569-06",
		phaseIndex: 4,
		seed: { docs: "in", pastDate: "18/7/2569", done: 8 },
		status: "on-track", actionLabel: "ดูรายละเอียด",
	},
];
