import type { Customer } from "../types";

// Customers — field list per data/ksk-console-platform-design/report.md
// §5.2's Customer/CustomerContact design (round 5), not the round-1
// 3-field placeholder. `dropboxRoot` is deliberately left out per the
// brief (filesystem plumbing, not a customer-detail-screen field);
// `code` and `lineGroupId` are included even though the design flags
// them as still needing an office-side answer.
//
// Round 9 adds two fields, both because the office's own checklist
// already depends on them and neither is derivable from anything else
// here — not because a customer page looked thin:
//   vatRegistered — the yearly job type's Gates 3.3/3.4 are literally
//     conditioned on "(ถ้าจด VAT)", so whether a customer is VAT
//     registered decides whether two Gates apply to them at all.
//   fiscalYearEnd — Phase 5 (ปิดบัญชี) and the ภ.ง.ด.50 / DBD filing
//     Gates hang off the customer's own accounting year end, which is
//     not always 31 ธันวาคม.
// Nothing else was added: no invented CRM fields, no revenue, no rating.
//
// Round 16 adds `packages` — the services this customer has actually bought
// from the office. It is not a CRM field either: it is the thing that
// answers "what work does this customer generate for us", and an active
// recurring package is what makes a งวด come into existence at all (see
// the schedule engine below PROJECTS). One entry carries the job type it
// maps to, how often it recurs (monthly / yearly / oneoff), when it
// started, whether it has ended, the fee, and any occurrences a person
// deliberately skipped. Not every customer buys everything, and the six
// hand-written ones below are deliberately a varied mix so the recurring
// behaviour visibly differs per customer:
//   srichai — the full monthly package (บัญชีรายเดือน + ปิดงบรายปี + ที่ปรึกษา)
//   ex2     — รายเดือนอย่างเดียว ไม่จด VAT (+ a consult package that ENDED)
//   ex3     — รายเดือน + รายปี, plus a one-off งานทะเบียน not yet opened
//   ex4     — รายเดือน + งานโปรเจคครั้งเดียว + งานทะเบียนครั้งเดียว
//   ex5     — moved off รายเดือน onto ที่ปรึกษาอย่างเดียว from งวดสิงหาคม
//   ex6     — dormant: its package ended, so it recurs nothing
//
// A customer can hold more
// than one active project at once — see PROJECTS below: "srichai" runs
// both a monthly job and a separate Consult engagement in parallel.
export const CUSTOMER_SEED: Record<string, Customer> = {
	srichai: {
		code: "216", legalName: "บริษัท ศรีชัยศึกษาภัณฑ์สกลนคร จำกัด",
		displayName: "บจก. ศรีชัยศึกษาภัณฑ์สกลนคร", taxId: "0-0000-00000-00-0 (ตัวอย่าง)",
		businessNature: "จำหน่ายอุปกรณ์การศึกษาและเครื่องเขียน", status: "active",
		lineGroupId: "ksk-216-srichai (ตัวอย่าง)", note: "",
		onboardedAt: "15 ม.ค. 2568", vatRegistered: true, fiscalYearEnd: "31 ธันวาคม",
		packages: [
			{ id: "pk-srichai-1", jobType: "monthly", recurrence: "monthly", startedAt: "2568-01", endedAt: null, paused: false, fee: 6500, note: "รวมยื่นแบบภาษีทุกประเภท", skips: [] },
			{ id: "pk-srichai-2", jobType: "yearly", recurrence: "yearly", startedAt: "2569-01", endedAt: null, paused: false, fee: 18000, note: "ปิดงบและยื่น ภ.ง.ด.50", skips: [] },
			{ id: "pk-srichai-3", jobType: "consult", recurrence: "monthly", startedAt: "2569-01", endedAt: null, paused: false, fee: 8000, note: "", skips: [] },
		],
		contacts: [
			{ name: "ผู้ประสานงานฝ่ายบัญชี", role: "ฝ่ายบัญชี", phone: "0X-XXX-XXXX", email: "accounting@example.com", lineId: "@srichai-acc", isPrimary: true },
		],
	},
	ex2: {
		code: "801", legalName: "ตัวอย่าง สอง (บุคคลธรรมดา)",
		displayName: "บจก. ตัวอย่าง สอง", taxId: null,
		businessNature: "ตัวอย่างธุรกิจบริการรายย่อย", status: "active",
		lineGroupId: null, note: "เจ้าของกิจการดำเนินการเอง ไม่ใช่นิติบุคคล",
		onboardedAt: "1 มี.ค. 2568", vatRegistered: false, fiscalYearEnd: "31 ธันวาคม",
		packages: [
			{ id: "pk-ex2-1", jobType: "monthly", recurrence: "monthly", startedAt: "2568-03", endedAt: null, paused: false, fee: 3500, note: "ไม่จด VAT — ไม่มีเกท ภ.พ.30", skips: [] },
			{ id: "pk-ex2-2", jobType: "consult", recurrence: "monthly", startedAt: "2568-10", endedAt: "2569-07", paused: false, fee: 5000, note: "ลูกค้าขอหยุดหลังงวดกรกฎาคม", skips: [] },
		],
		contacts: [
			{ name: "ผู้ประสานงานฝ่ายบัญชี", role: "เจ้าของกิจการ", phone: "0X-XXX-XXXX", email: null, lineId: null, isPrimary: true },
		],
	},
	ex3: {
		code: "802", legalName: "บริษัท ตัวอย่าง สาม จำกัด",
		displayName: "บจก. ตัวอย่าง สาม", taxId: "0-0000-00000-00-0 (ตัวอย่าง)",
		businessNature: "ตัวอย่างธุรกิจการค้า", status: "active",
		lineGroupId: null, note: "",
		onboardedAt: "10 พ.ค. 2568", vatRegistered: true, fiscalYearEnd: "31 ธันวาคม",
		packages: [
			{ id: "pk-ex3-1", jobType: "monthly", recurrence: "monthly", startedAt: "2568-05", endedAt: null, paused: false, fee: 5200, note: "", skips: [] },
			{ id: "pk-ex3-2", jobType: "yearly", recurrence: "yearly", startedAt: "2569-01", endedAt: null, paused: false, fee: 15000, note: "", skips: [] },
			// A one-off nobody has opened yet — this is what makes the
			// "งานครั้งเดียว" case visible on the schedule instead of only
			// being described.
			{ id: "pk-ex3-3", jobType: "registry", recurrence: "oneoff", startedAt: "2569-08", endedAt: null, paused: false, fee: 12000, note: "จดเปลี่ยนแปลงที่ตั้งสำนักงาน", skips: [] },
		],
		contacts: [
			{ name: "ผู้ประสานงานฝ่ายบัญชี", role: "ฝ่ายบัญชี", phone: "0X-XXX-XXXX", email: "acc@example.com", lineId: null, isPrimary: true },
		],
	},
	ex4: {
		code: "803", legalName: "บริษัท ตัวอย่าง สี่ จำกัด",
		displayName: "บจก. ตัวอย่าง สี่", taxId: "0-0000-00000-00-0 (ตัวอย่าง)",
		businessNature: "ตัวอย่างธุรกิจที่ปรึกษา", status: "active",
		lineGroupId: "ksk-803-ex4 (ตัวอย่าง)", note: "",
		onboardedAt: "22 ก.ค. 2568", vatRegistered: true, fiscalYearEnd: "30 กันยายน",
		packages: [
			{ id: "pk-ex4-1", jobType: "monthly", recurrence: "monthly", startedAt: "2568-07", endedAt: null, paused: false, fee: 7800, note: "", skips: [] },
			{ id: "pk-ex4-2", jobType: "project", recurrence: "oneoff", startedAt: "2569-08", endedAt: null, paused: false, fee: 45000, note: "วางระบบบัญชีต้นทุน", skips: [] },
			{ id: "pk-ex4-3", jobType: "registry", recurrence: "oneoff", startedAt: "2569-07", endedAt: null, paused: false, fee: 9500, note: "แจ้งเปลี่ยนกรรมการ", skips: [] },
		],
		contacts: [
			{ name: "ผู้ประสานงานฝ่ายบัญชี", role: "ผู้จัดการฝ่ายบัญชี", phone: "0X-XXX-XXXX", email: "acc@example.com", lineId: "@ex4-acc", isPrimary: true },
			{ name: "ผู้ประสานงานรอง", role: "ผู้ช่วยผู้จัดการ", phone: "0X-XXX-XXXX", email: null, lineId: null, isPrimary: false },
		],
	},
	ex5: {
		code: "804", legalName: "บริษัท ตัวอย่าง ห้า จำกัด",
		displayName: "บจก. ตัวอย่าง ห้า", taxId: "0-0000-00000-00-0 (ตัวอย่าง)",
		businessNature: "ตัวอย่างธุรกิจผลิต", status: "active",
		lineGroupId: null, note: "",
		onboardedAt: "3 มิ.ย. 2568", vatRegistered: true, fiscalYearEnd: "31 ธันวาคม",
		// Moved off the monthly package onto advisory only — so from งวด
		// สิงหาคม onwards this customer recurs a ที่ปรึกษา period and no
		// bookkeeping period at all.
		packages: [
			{ id: "pk-ex5-1", jobType: "monthly", recurrence: "monthly", startedAt: "2568-06", endedAt: "2569-07", paused: false, fee: 4800, note: "ลูกค้าย้ายงานบันทึกบัญชีไปทำเอง", skips: [] },
			{ id: "pk-ex5-2", jobType: "consult", recurrence: "monthly", startedAt: "2569-08", endedAt: null, paused: false, fee: 9000, note: "", skips: [] },
		],
		contacts: [
			{ name: "ผู้ประสานงานฝ่ายบัญชี", role: "ฝ่ายบัญชี", phone: "0X-XXX-XXXX", email: null, lineId: null, isPrimary: true },
		],
	},
	// No project runs for this one — exists to show the "0 โปรเจกต์"/
	// dormant-status case on the Customers list, which the field list
	// alone wouldn't otherwise demonstrate.
	ex6: {
		code: "805", legalName: "บริษัท ตัวอย่าง หก จำกัด",
		displayName: "บจก. ตัวอย่าง หก", taxId: "0-0000-00000-00-0 (ตัวอย่าง)",
		businessNature: "ตัวอย่างธุรกิจที่หยุดดำเนินการชั่วคราว", status: "dormant",
		lineGroupId: null, note: "ลูกค้าหยุดพักงานชั่วคราว ยังไม่มีโปรเจกต์เดือนนี้",
		onboardedAt: "5 ก.พ. 2567", vatRegistered: false, fiscalYearEnd: "31 ธันวาคม",
		packages: [
			{ id: "pk-ex6-1", jobType: "monthly", recurrence: "monthly", startedAt: "2567-02", endedAt: "2569-05", paused: false, fee: 3900, note: "หยุดพักหลังงวดพฤษภาคม", skips: [] },
		],
		contacts: [
			{ name: "ผู้ประสานงานฝ่ายบัญชี", role: "ฝ่ายบัญชี", phone: "0X-XXX-XXXX", email: null, lineId: null, isPrimary: true },
		],
	},
};
export const CUSTOMER_STATUS_LABEL: Record<string, string> = { active: "ดำเนินการอยู่", dormant: "หยุดพักชั่วคราว", resigned: "เลิกใช้บริการแล้ว" };
