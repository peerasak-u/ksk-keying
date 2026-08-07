import type { JobType } from "../types";

// ---- pure-simulation data. no backend, no persistence — refresh resets
// everything back to these two example users. every action button below
// just shows the toast; nothing here calls a real pipeline. ----
//
// A PROJECT = one client + one job type. The same client can run more than
// one project in parallel (e.g. its recurring monthly work AND a separate
// Consult engagement) — those are two different cards, never merged, even
// though the client name is the same.
//
// Confirmed 3-level model (round 5): Job type -> Phase -> Gate. A job
// type owns an ordered list of Phases (a stage of work, e.g. "คีย์ข้อมูล").
// A Phase owns a small checklist of named Gates (e.g. "ยืนยันเอกสารซ้ำ 2
// รายการ") — there is no 4th level, and no other schema name for these
// two ("GateDef"/"RequirementDef" etc. are internal design-doc names for
// the same two levels — never used here, in code or copy). Key Ink's
// auto-fill step is just one Gate inside one Phase — never the thing the
// dashboard itself is organized around.
//
// JOB_TYPES is admin-editable at runtime (see the "ประเภทงาน" page below)
// — not a fixed enum baked into code. Each Phase nests its own Gate
// template list: phases: [{ name, gates: [{ code, name, required, freq?,
// note? }] }]. `required` defaults to true. This is the job-TYPE template
// only — a per-project's actual checklist INSTANCE (PROJECTS[i].work, the
// per-run ผู้ทำ/ผู้สอบทาน/วันที่เสร็จ/สถานะ/หมายเหตุ record for one
// specific project) is a separate thing built from this template; editing
// a job type here never touches a project's own recorded work. Still a
// mock: no persistence — refresh resets everything, including any job
// type an admin adds or edits here.
//
// ALL FIVE job types are now seeded verbatim from the office's own
// workbook, Checklist_5Gates_งานบัญชี-1.xlsx (firstmate home,
// data/ksk-gate-checklist-scout/input/, not in this repo) — one job type
// per sheet, 5 Phases each:
//   monthly  ← `Master 5 Gates`, กลุ่มรายเดือน (ความถี่) column  — 37 Gates
//   yearly   ← `กลุ่มรายปี` sheet                                 — 37 Gates
//   consult  ← `ที่ปรึกษารายเดือน` sheet                          — 20 Gates
//   project  ← `งานโปรเจค` sheet                                  — 22 Gates
//   registry ← `งานทะเบียน` sheet                                 — 19 Gates
// The sheet's own word "Gate 1..5" is this project's PHASE; its
// `ขั้นตอนย่อย` rows (1.1, 1.2, …) are this project's GATES — the mapping
// the checklist scout established from the sheet's own structure
// (report.md §2). `code`/`name`/`freq`/`note` are the sheet's
// `รหัส`/`ขั้นตอนย่อย`/`ความถี่`/`หมายเหตุ` columns copied verbatim, never
// paraphrased. Only the three `ที่ปรึกษารายเดือน`/`งานโปรเจค`/`งานทะเบียน`
// sheets have no ความถี่ column at all, so their gates carry no `freq`.
//
// `required: false` is only ever set where the sheet itself says the item
// does not always apply: monthly's "4Y"/ปิดปี rows in Phase 4 (4.2, 4.3,
// 4.5, 4.6, 4.7 — the ones NOT highlighted as the 4M never-skip set),
// yearly's two "(ถ้าจด VAT)" rows (3.3, 3.4), and the rows whose own Thai
// wording is conditional — consult 4.2 "(ถ้ามีในขอบเขตงาน)" and registry
// 2.3 "(ถ้าต้องมีมติที่ประชุม)". Everything else is required.
//
// `actor` (round 9) marks the Gates the office cannot close on its own —
// the ones where the ball is in the CUSTOMER's court (documents to hand
// over, an approval to give, a signature to return). It is taken from
// the sheet's own wording, never guessed: only rows that literally say
// รับเอกสาร / รับข้อมูล / ทวงข้อมูล / ลูกค้าอนุมัติ / ลูกค้ายืนยัน /
// ลูกค้าเซ็น carry it. Everything without an `actor` is the office's own
// work. This is what lets both the overview and the customer page answer
// "what is stuck waiting on the customer" without inventing a status.
export const ACTOR_CUSTOMER = "ลูกค้า";
export const JOB_TYPE_SEED: JobType[] = [
	{
		key: "monthly", name: "กลุ่มรายเดือน",
		phases: [
			{
				name: "รวบรวมเอกสาร",
				gates: [
					{ code: "1.1", name: "ส่งข้อความขอเอกสารจากลูกค้า (ตาม template รายเดือน)", required: true, freq: "ทุกเดือน" },
					{ code: "1.2", name: "รับเอกสาร — บิลขาย / บิลซื้อ / ใบเสร็จค่าใช้จ่าย", required: true, freq: "ทุกเดือน", actor: ACTOR_CUSTOMER },
					{ code: "1.3", name: "รับ Bank Statement ทุกบัญชี", required: true, freq: "ทุกเดือน", actor: ACTOR_CUSTOMER },
					{ code: "1.4", name: "รับข้อมูลเงินเดือน + ประกันสังคม", required: true, freq: "ทุกเดือน", actor: ACTOR_CUSTOMER },
					{ code: "1.5", name: "นับและบันทึกจำนวนเอกสารแยกตามประเภท ลงใน Airtable", required: true, freq: "ทุกเดือน", note: "สำคัญมากกับกลุ่มรายปี — เห็นยอดสะสมเอกสารขาด" },
					{ code: "1.6", name: "ตรวจความครบถ้วนของเอกสาร (เทียบกับเดือนก่อน)", required: true, freq: "ทุกเดือน" },
					{ code: "1.7", name: "จัดเก็บไฟล์เข้าโฟลเดอร์ตามรหัสลูกค้า + บันทึกสถานะเอกสารครบ/รอเพิ่มเติม", required: true, freq: "ทุกเดือน", note: "กลุ่มรายปี: บันทึกสถานะราย ’เดือนเอกสาร’ เช่น ม.ค.✓ ก.พ.✗" },
				],
			},
			{
				name: "บันทึกบัญชี",
				gates: [
					{ code: "2.1", name: "ตรวจรายการขาย / รายได้ ที่ระบบคีย์มา — แก้จุดที่ไม่ถูกก่อนยืนยัน", required: true, freq: "ทุกเดือน" },
					{ code: "2.2", name: "ตรวจรายการซื้อ / ค่าใช้จ่าย ที่ระบบคีย์มา — แก้จุดที่ไม่ถูกก่อนยืนยัน", required: true, freq: "ทุกเดือน" },
					{ code: "2.3", name: "ตรวจรายการรับ–จ่ายเงินผ่านธนาคาร ที่ระบบคีย์มา — กระทบกับ Bank Statement", required: true, freq: "ทุกเดือน" },
					{ code: "2.4", name: "ตรวจเงินเดือนและรายการหัก ณ ที่จ่าย ที่ระบบคีย์มา", required: true, freq: "ทุกเดือน" },
					{ code: "2.5", name: "ตรวจงบทดลองเบื้องต้น — ยอดผิดปกติ, บัญชีพัก, ยอดติดลบ", required: true, freq: "ทุกเดือน" },
				],
			},
			{
				name: "ยื่นแบบภาษี",
				gates: [
					{ code: "3.1", name: "จัดทำ ภ.ง.ด.1 / 3 / 53 (และ ภ.ง.ด.54 ถ้ามี)", required: true, freq: "ทุกเดือน", note: "กำหนดยื่นวันที่ 7 (e-Filing วันที่ 15)" },
					{ code: "3.2", name: "จัดทำประกันสังคม (สปส.1-10)", required: true, freq: "ทุกเดือน", note: "กำหนดยื่นวันที่ 15" },
					{ code: "3.3", name: "จัดทำรายงานภาษีซื้อ–ภาษีขาย และกระทบยอดกับ GL", required: true, freq: "ทุกเดือน" },
					{ code: "3.4", name: "จัดทำ ภ.พ.30 (และ ภ.พ.36 ถ้ามี)", required: true, freq: "ทุกเดือน", note: "กำหนดยื่นวันที่ 15 (e-Filing วันที่ 23)" },
					{ code: "3.5", name: "ส่งแบบทั้งหมดให้หัวหน้าทีมตรวจสอบ ก่อนส่งลูกค้า", required: true, freq: "ทุกเดือน" },
					{ code: "3.6", name: "ส่งแบบให้ลูกค้าอนุมัติ + ยืนยันยอดภาษีที่ต้องชำระ", required: true, freq: "ทุกเดือน", actor: ACTOR_CUSTOMER },
					{ code: "3.7", name: "ยื่นแบบออนไลน์ + ชำระภาษี", required: true, freq: "ทุกเดือน" },
					{ code: "3.8", name: "เก็บใบเสร็จ/หลักฐานการยื่น เข้าโฟลเดอร์ลูกค้า", required: true, freq: "ทุกเดือน" },
					{ code: "3.9", name: "บันทึกข้อมูลแบบภาษีที่ยื่น (ประเภทแบบ / ยอดภาษี / วันที่ยื่น) ลงใน Airtable", required: true, freq: "ทุกเดือน" },
				],
			},
			{
				name: "ปรับปรุงรายการ",
				gates: [
					{ code: "4.1", name: "กระทบยอดเงินฝากธนาคาร (Bank Reconciliation)", required: true, freq: "ทุกเดือน (4M — ห้ามข้าม)" },
					{ code: "4.2", name: "ตั้งค่าใช้จ่ายค้างจ่าย / รายได้ค้างรับ", required: false, freq: "ปิดปี (4Y)" },
					{ code: "4.3", name: "ปรับปรุงค่าใช้จ่ายจ่ายล่วงหน้า / รายได้รับล่วงหน้า", required: false, freq: "ปิดปี (4Y)" },
					{ code: "4.4", name: "คำนวณและบันทึกค่าเสื่อมราคา (กระทบยอดกับทะเบียนทรัพย์สิน)", required: true, freq: "ทุกเดือน (4M)", note: "ตั้งเป็นรายการซ้ำใน PEAK ได้" },
					{ code: "4.5", name: "ปรับปรุงสินค้าคงเหลือ (เทียบกับรายงานตรวจนับ)", required: false, freq: "ปิดปี (4Y)" },
					{ code: "4.6", name: "กระทบยอดลูกหนี้–เจ้าหนี้ + พิจารณาตั้งค่าเผื่อหนี้สงสัยจะสูญ", required: false, freq: "ปิดปี (4Y)" },
					{ code: "4.7", name: "ปรับปรุงรายการระหว่างกัน / เงินกู้กรรมการ / ดอกเบี้ย", required: false, freq: "ปิดปี (4Y)" },
					{ code: "4.8", name: "ตรวจสอบรายการในบัญชีพักให้เคลียร์หมด", required: true, freq: "ทุกเดือน (4M)" },
				],
			},
			{
				name: "ปิดบัญชี",
				gates: [
					{ code: "5.1", name: "จัดทำงบทดลองหลังปรับปรุง + หัวหน้าทีมสอบทาน", required: true, freq: "ปีละครั้ง" },
					{ code: "5.2", name: "ร่างงบการเงิน + หมายเหตุประกอบงบ", required: true, freq: "ปีละครั้ง" },
					{ code: "5.3", name: "คำนวณภาษีเงินได้นิติบุคคล (บวกกลับค่าใช้จ่ายต้องห้าม)", required: true, freq: "ปีละครั้ง" },
					{ code: "5.4", name: "จัดทำ ภ.ง.ด.50 / 51", required: true, freq: "ปีละครั้ง", note: "ภ.ง.ด.51 กลางปี" },
					{ code: "5.5", name: "ประสานงานผู้สอบบัญชี + ส่งเอกสารประกอบการตรวจ", required: true, freq: "ปีละครั้ง" },
					{ code: "5.6", name: "ปรับปรุงตามผู้สอบ + ลูกค้าอนุมัติงบ", required: true, freq: "ปีละครั้ง" },
					{ code: "5.7", name: "ยื่นงบ DBD (e-Filing) + ยื่น ภ.ง.ด.50", required: true, freq: "ปีละครั้ง" },
					{ code: "5.8", name: "จัดเก็บงบและเอกสารปิดปี + อัปเดตสถานะ 'ปิดงานแล้ว' ใน Airtable", required: true, freq: "ปีละครั้ง" },
				],
			},
		],
	},
	{
		key: "yearly", name: "กลุ่มรายปี",
		phases: [
			{
				name: "รวบรวมเอกสาร",
				gates: [
					{ code: "1.1", name: "ส่งข้อความขอเอกสารจากลูกค้า (ตาม template รายเดือน)", required: true, freq: "ทุกเดือน" },
					{ code: "1.2", name: "รับเอกสาร — บิลขาย / บิลซื้อ / ใบเสร็จค่าใช้จ่าย", required: true, freq: "ทุกเดือน", actor: ACTOR_CUSTOMER },
					{ code: "1.3", name: "รับ Bank Statement ทุกบัญชี", required: true, freq: "ทุกเดือน", actor: ACTOR_CUSTOMER },
					{ code: "1.4", name: "รับข้อมูลเงินเดือน + ประกันสังคม", required: true, freq: "ทุกเดือน", actor: ACTOR_CUSTOMER },
					{ code: "1.5", name: "นับและบันทึกจำนวนเอกสารแยกตามประเภท ลงใน Airtable", required: true, freq: "ทุกเดือน", note: "สำคัญมากกับกลุ่มรายปี — เห็นยอดสะสมเอกสารขาด" },
					{ code: "1.6", name: "ตรวจความครบถ้วนของเอกสาร (เทียบกับเดือนก่อน)", required: true, freq: "ทุกเดือน" },
					{ code: "1.7", name: "จัดเก็บไฟล์เข้าโฟลเดอร์ตามรหัสลูกค้า + บันทึกสถานะเอกสารครบ/รอเพิ่มเติม", required: true, freq: "ทุกเดือน", note: "กลุ่มรายปี: บันทึกสถานะราย ’เดือนเอกสาร’ เช่น ม.ค.✓ ก.พ.✗" },
				],
			},
			{
				name: "บันทึกบัญชี",
				gates: [
					{ code: "2.1", name: "บันทึกรายการขาย / รายได้", required: true, freq: "รายไตรมาส" },
					{ code: "2.2", name: "บันทึกรายการซื้อ / ค่าใช้จ่าย", required: true, freq: "รายไตรมาส" },
					{ code: "2.3", name: "บันทึกรายการรับ–จ่ายเงินผ่านธนาคาร", required: true, freq: "รายไตรมาส" },
					{ code: "2.4", name: "บันทึกเงินเดือนและรายการหัก ณ ที่จ่าย", required: true, freq: "รายไตรมาส" },
					{ code: "2.5", name: "ตรวจงบทดลองเบื้องต้น — ยอดผิดปกติ, บัญชีพัก, ยอดติดลบ", required: true, freq: "รายไตรมาส" },
				],
			},
			{
				name: "ยื่นแบบภาษี",
				gates: [
					{ code: "3.1", name: "จัดทำ ภ.ง.ด.1 / 3 / 53 (และ ภ.ง.ด.54 ถ้ามี)", required: true, freq: "ทุกเดือน", note: "กำหนดยื่นวันที่ 7 (e-Filing วันที่ 15)" },
					{ code: "3.2", name: "จัดทำประกันสังคม (สปส.1-10)", required: true, freq: "ทุกเดือน", note: "กำหนดยื่นวันที่ 15" },
					{ code: "3.3", name: "จัดทำรายงานภาษีซื้อ–ภาษีขาย และกระทบยอดกับ GL", required: false, freq: "ทุกเดือน (ถ้าจด VAT)" },
					{ code: "3.4", name: "จัดทำ ภ.พ.30 (และ ภ.พ.36 ถ้ามี)", required: false, freq: "ทุกเดือน (ถ้าจด VAT)", note: "กำหนดยื่นวันที่ 15 (e-Filing วันที่ 23)" },
					{ code: "3.5", name: "ส่งแบบทั้งหมดให้หัวหน้าทีมตรวจสอบ ก่อนส่งลูกค้า", required: true, freq: "ทุกเดือน" },
					{ code: "3.6", name: "ส่งแบบให้ลูกค้าอนุมัติ + ยืนยันยอดภาษีที่ต้องชำระ", required: true, freq: "ทุกเดือน", actor: ACTOR_CUSTOMER },
					{ code: "3.7", name: "ยื่นแบบออนไลน์ + ชำระภาษี", required: true, freq: "ทุกเดือน" },
					{ code: "3.8", name: "เก็บใบเสร็จ/หลักฐานการยื่น เข้าโฟลเดอร์ลูกค้า", required: true, freq: "ทุกเดือน" },
					{ code: "3.9", name: "บันทึกข้อมูลแบบภาษีที่ยื่น (ประเภทแบบ / ยอดภาษี / วันที่ยื่น) ลงใน Airtable", required: true, freq: "ทุกเดือน" },
				],
			},
			{
				name: "ปรับปรุงรายการ",
				gates: [
					{ code: "4.1", name: "กระทบยอดเงินฝากธนาคาร (Bank Reconciliation)", required: true, freq: "ปิดปี" },
					{ code: "4.2", name: "ตั้งค่าใช้จ่ายค้างจ่าย / รายได้ค้างรับ", required: true, freq: "ปิดปี" },
					{ code: "4.3", name: "ปรับปรุงค่าใช้จ่ายจ่ายล่วงหน้า / รายได้รับล่วงหน้า", required: true, freq: "ปิดปี" },
					{ code: "4.4", name: "คำนวณและบันทึกค่าเสื่อมราคา (กระทบยอดกับทะเบียนทรัพย์สิน)", required: true, freq: "ปิดปี", note: "ตั้งเป็นรายการซ้ำใน PEAK ได้" },
					{ code: "4.5", name: "ปรับปรุงสินค้าคงเหลือ (เทียบกับรายงานตรวจนับ)", required: true, freq: "ปิดปี" },
					{ code: "4.6", name: "กระทบยอดลูกหนี้–เจ้าหนี้ + พิจารณาตั้งค่าเผื่อหนี้สงสัยจะสูญ", required: true, freq: "ปิดปี" },
					{ code: "4.7", name: "ปรับปรุงรายการระหว่างกัน / เงินกู้กรรมการ / ดอกเบี้ย", required: true, freq: "ปิดปี" },
					{ code: "4.8", name: "ตรวจสอบรายการในบัญชีพักให้เคลียร์หมด", required: true, freq: "ปิดปี" },
				],
			},
			{
				name: "ปิดบัญชี",
				gates: [
					{ code: "5.1", name: "จัดทำงบทดลองหลังปรับปรุง + หัวหน้าทีมสอบทาน", required: true, freq: "ปีละครั้ง" },
					{ code: "5.2", name: "ร่างงบการเงิน + หมายเหตุประกอบงบ", required: true, freq: "ปีละครั้ง" },
					{ code: "5.3", name: "คำนวณภาษีเงินได้นิติบุคคล (บวกกลับค่าใช้จ่ายต้องห้าม)", required: true, freq: "ปีละครั้ง" },
					{ code: "5.4", name: "จัดทำ ภ.ง.ด.50 / 51", required: true, freq: "ปีละครั้ง", note: "ภ.ง.ด.51 กลางปี" },
					{ code: "5.5", name: "ประสานงานผู้สอบบัญชี + ส่งเอกสารประกอบการตรวจ", required: true, freq: "ปีละครั้ง" },
					{ code: "5.6", name: "ปรับปรุงตามผู้สอบ + ลูกค้าอนุมัติงบ", required: true, freq: "ปีละครั้ง" },
					{ code: "5.7", name: "ยื่นงบ DBD (e-Filing) + ยื่น ภ.ง.ด.50", required: true, freq: "ปีละครั้ง" },
					{ code: "5.8", name: "จัดเก็บงบและเอกสารปิดปี + อัปเดตสถานะ 'ปิดงานแล้ว' ใน Airtable", required: true, freq: "ปีละครั้ง" },
				],
			},
		],
	},
	{
		key: "consult", name: "ที่ปรึกษารายเดือน",
		phases: [
			{
				name: "รับข้อมูลจากลูกค้า",
				gates: [
					{ code: "1.1", name: "ขอข้อมูลตาม checklist ประจำเดือน (GL, สต๊อก, รายงานภายใน ฯลฯ ตามแต่ละลูกค้า)", required: true },
					{ code: "1.2", name: "รับข้อมูล + นับ/บันทึกความครบถ้วนลง Airtable", required: true, actor: ACTOR_CUSTOMER },
					{ code: "1.3", name: "ตรวจคุณภาพข้อมูลเบื้องต้น (ไฟล์เปิดได้ งวดถูกต้อง ฟอร์แมตตรงตามเดิม)", required: true },
					{ code: "1.4", name: "ทวงข้อมูลที่ขาด พร้อมบันทึกวันที่ได้รับจริง", required: true, actor: ACTOR_CUSTOMER },
				],
			},
			{
				name: "ตรวจสอบและกระทบยอดข้อมูล",
				gates: [
					{ code: "2.1", name: "ตรวจ data quality (สูตรผิด ยอดซ้ำ paste error ยอดผิดปกติ)", required: true },
					{ code: "2.2", name: "กระทบยอดระหว่างแหล่งข้อมูล (เช่น ข้อมูลลูกค้า × GL × รายงานภายใน)", required: true },
					{ code: "2.3", name: "สรุปประเด็นผิดปกติ + สอบถามลูกค้าถ้าจำเป็น", required: true },
					{ code: "2.4", name: "บันทึก findings ไว้เป็นหลักฐานการตรวจ", required: true },
				],
			},
			{
				name: "วิเคราะห์และจัดทำรายงาน",
				gates: [
					{ code: "3.1", name: "จัดทำสรุปผลประกอบการ / รายงานตามขอบเขตงาน", required: true },
					{ code: "3.2", name: "เปรียบเทียบ MoM / YoY + หาสาเหตุรายการที่เปลี่ยนแปลงมีนัยสำคัญ", required: true },
					{ code: "3.3", name: "จัดทำข้อสังเกตและข้อเสนอแนะ", required: true },
					{ code: "3.4", name: "หัวหน้าทีม (หรือ CFO) สอบทานรายงานก่อนส่ง", required: true },
				],
			},
			{
				name: "ส่งมอบและนำเสนอ",
				gates: [
					{ code: "4.1", name: "ส่งรายงานให้ลูกค้า", required: true },
					{ code: "4.2", name: "ประชุม/นำเสนอผลประกอบการ (ถ้ามีในขอบเขตงาน)", required: false },
					{ code: "4.3", name: "บันทึกคำถามและประเด็นจากลูกค้า", required: true },
					{ code: "4.4", name: "ตอบข้อซักถามเพิ่มเติมให้จบภายในรอบเดือน", required: true },
				],
			},
			{
				name: "ปิดรอบและติดตาม",
				gates: [
					{ code: "5.1", name: "บันทึก action items ของลูกค้า + ผู้รับผิดชอบฝั่งลูกค้า", required: true },
					{ code: "5.2", name: "อัปเดตสถานะ action items ของเดือนก่อนว่าลูกค้าทำแล้วหรือยัง", required: true },
					{ code: "5.3", name: "จัดเก็บไฟล์งานเข้าโฟลเดอร์ + อัปเดตสถานะ 'ปิดรอบเดือน' ใน Airtable", required: true },
					{ code: "5.4", name: "จดประเด็นที่ควรปรับปรุงกระบวนการ (เช่น ข้อมูลที่ควรขอเพิ่มเดือนหน้า)", required: true },
				],
			},
		],
	},
	{
		key: "project", name: "งานโปรเจค",
		phases: [
			{
				name: "รับงานและตกลงขอบเขต",
				gates: [
					{ code: "1.1", name: "ประชุมทำความเข้าใจโจทย์ + ปัญหาที่ลูกค้าต้องการแก้", required: true },
					{ code: "1.2", name: "กำหนดขอบเขตงาน (scope) — ทำอะไร / ไม่ทำอะไร / ส่งมอบอะไร", required: true, note: "จุดสำคัญ — scope ไม่ชัด = โปรเจคขาดทุน" },
					{ code: "1.3", name: "เสนอราคา + timeline + เงื่อนไขชำระเงิน", required: true },
					{ code: "1.4", name: "ลูกค้าอนุมัติ + เซ็นข้อตกลง/ใบเสนอราคา", required: true, actor: ACTOR_CUSTOMER },
					{ code: "1.5", name: "สร้าง record โปรเจคใน Airtable + ตั้งโฟลเดอร์งาน", required: true },
				],
			},
			{
				name: "วางแผนและเก็บข้อมูล",
				gates: [
					{ code: "2.1", name: "แตกงานเป็น task ย่อย + กำหนดผู้รับผิดชอบและ deadline", required: true },
					{ code: "2.2", name: "ขอข้อมูล/เอกสารจากลูกค้าตาม checklist", required: true, actor: ACTOR_CUSTOMER },
					{ code: "2.3", name: "สัมภาษณ์/ประชุมผู้เกี่ยวข้องฝั่งลูกค้า", required: true },
					{ code: "2.4", name: "ยืนยันความครบถ้วนของข้อมูลก่อนเริ่มลงมือ", required: true },
				],
			},
			{
				name: "ลงมือทำ",
				gates: [
					{ code: "3.1", name: "ดำเนินงานตามแผน + อัปเดตสถานะ task ใน Airtable", required: true },
					{ code: "3.2", name: "รายงานความคืบหน้าให้ลูกค้าเป็นระยะ (เช่น ทุก 2 สัปดาห์)", required: true },
					{ code: "3.3", name: "บันทึก scope change ที่ลูกค้าขอเพิ่ม + ตกลงราคา/เวลาใหม่ก่อนทำ", required: true, note: "ห้ามทำฟรีเงียบๆ" },
					{ code: "3.4", name: "จัดทำร่าง deliverable", required: true },
				],
			},
			{
				name: "สอบทานและส่งมอบ",
				gates: [
					{ code: "4.1", name: "หัวหน้าทีม/CFO สอบทานร่างงานก่อนส่ง", required: true },
					{ code: "4.2", name: "ส่งร่างให้ลูกค้า review + รับ feedback", required: true, actor: ACTOR_CUSTOMER },
					{ code: "4.3", name: "แก้ไขตาม feedback (กำหนดรอบแก้ชัดเจน เช่น ไม่เกิน 2 รอบ)", required: true },
					{ code: "4.4", name: "ส่งมอบฉบับสมบูรณ์ + นำเสนอ/อธิบายการใช้งาน", required: true },
				],
			},
			{
				name: "ปิดโปรเจค",
				gates: [
					{ code: "5.1", name: "ลูกค้ายืนยันรับมอบงาน (เป็นลายลักษณ์อักษร)", required: true, actor: ACTOR_CUSTOMER },
					{ code: "5.2", name: "วางบิล + ติดตามรับชำระเงิน", required: true },
					{ code: "5.3", name: "จัดเก็บไฟล์ + สรุปบทเรียน (ทำได้ดี / ควรปรับ / เวลาจริงเทียบแผน)", required: true },
					{ code: "5.4", name: "พิจารณาโอกาสต่อยอด (ที่ปรึกษารายเดือนต่อ / โปรเจคถัดไป)", required: true },
					{ code: "5.5", name: "อัปเดตสถานะ 'ปิดโปรเจค' ใน Airtable", required: true },
				],
			},
		],
	},
	{
		key: "registry", name: "งานทะเบียน",
		phases: [
			{
				name: "รับงานและตรวจสอบข้อมูลเบื้องต้น",
				gates: [
					{ code: "1.1", name: "รับเรื่องจากลูกค้า + ระบุประเภทงานทะเบียน (จดตั้ง / แก้ไขเปลี่ยนแปลง / VAT / เพิ่มทุน / เปลี่ยนกรรมการ-ผู้ถือหุ้น / ย้ายที่ตั้ง / จดเลิก)", required: true },
					{ code: "1.2", name: "ตรวจสอบข้อมูลปัจจุบันจาก DBD (หนังสือรับรอง, บอจ.5, วัตถุประสงค์) ว่าตรงกับที่ลูกค้าเข้าใจไหม", required: true, note: "เช็คก่อนเริ่มทุกครั้ง — กันย้อนกลับมาแก้เอกสารตอนยื่น" },
					{ code: "1.3", name: "แจ้งเอกสารที่ต้องใช้ + ค่าบริการ + ค่าธรรมเนียมราชการ + ระยะเวลา", required: true },
					{ code: "1.4", name: "ลูกค้ายืนยันดำเนินการ + สร้าง record ใน Airtable", required: true, actor: ACTOR_CUSTOMER },
				],
			},
			{
				name: "รวบรวมเอกสารและจัดเตรียมแบบ",
				gates: [
					{ code: "2.1", name: "รับเอกสารจากลูกค้าตาม checklist ของงานประเภทนั้น (สำเนาบัตร, ทะเบียนบ้าน, หลักฐานที่ตั้ง ฯลฯ)", required: true, actor: ACTOR_CUSTOMER },
					{ code: "2.2", name: "ตรวจความถูกต้องครบถ้วน (ชื่อ-สะกด, ลายเซ็นตรงตัวอย่าง, เอกสารไม่หมดอายุ)", required: true },
					{ code: "2.3", name: "จัดทำแบบฟอร์ม + รายงานการประชุม + หนังสือเชิญประชุม (ถ้าต้องมีมติที่ประชุม)", required: false, note: "ระวังระยะเวลาบอกกล่าวล่วงหน้าตามกฎหมาย" },
					{ code: "2.4", name: "หัวหน้าทีมตรวจแบบก่อนส่งลูกค้าเซ็น", required: true },
				],
			},
			{
				name: "ลูกค้าลงนาม",
				gates: [
					{ code: "3.1", name: "ส่งชุดเอกสารให้ลูกค้าเซ็น พร้อมมาร์กจุดเซ็นชัดเจน", required: true, actor: ACTOR_CUSTOMER },
					{ code: "3.2", name: "ติดตามรับเอกสารคืน + บันทึกวันที่ได้รับ", required: true, actor: ACTOR_CUSTOMER },
					{ code: "3.3", name: "ตรวจลายเซ็น/ตราประทับครบทุกจุดก่อนยื่น", required: true },
				],
			},
			{
				name: "ยื่นจดทะเบียน",
				gates: [
					{ code: "4.1", name: "ยื่นต่อนายทะเบียน (DBD e-Registration หรือ walk-in) / กรมสรรพากร (กรณี VAT)", required: true },
					{ code: "4.2", name: "ชำระค่าธรรมเนียม + เก็บใบเสร็จ", required: true },
					{ code: "4.3", name: "ติดตามผล — ถ้านายทะเบียนมีคำสั่งแก้ไข บันทึกประเด็นและแก้ให้จบ", required: true },
					{ code: "4.4", name: "รับเอกสารสำคัญ (หนังสือรับรองฉบับใหม่, ใบทะเบียนภาษีมูลค่าเพิ่ม ฯลฯ)", required: true },
				],
			},
			{
				name: "ส่งมอบและปิดงาน",
				gates: [
					{ code: "5.1", name: "ส่งมอบเอกสารสำคัญให้ลูกค้า + อธิบายผลที่เปลี่ยนแปลง", required: true },
					{ code: "5.2", name: "แจ้งงานต่อเนื่องที่ลูกค้าต้องทำ (เช่น อัปเดตธนาคาร, แจ้งสรรพากร/ประกันสังคม)", required: true },
					{ code: "5.3", name: "อัปเดตข้อมูลลูกค้าใน Airtable ให้ตรงกับทะเบียนใหม่", required: true, note: "เงื่อนไขผ่าน Gate — ทีมบัญชีใช้ข้อมูลนี้ต่อ" },
					{ code: "5.4", name: "วางบิล + รับชำระ + ปิดสถานะงาน", required: true },
				],
			},
		],
	},
];
