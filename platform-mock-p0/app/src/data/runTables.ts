import type { CoaRow } from "../types";

// ================= what a finished run produced (round 13) =================
//
// The pipeline in this repo already writes its own review surfaces —
// `ตรวจทาน/index.html` (the hub: coverage figures + one card per bucket) and
// one `ตรวจทาน.html` per bucket (evidence pane + group selector + the
// document's own รายการ, each line carrying ผังบัญชี / รายละเอียด / ยอด and a
// เหตุผลการจัดหมวด). See .claude/skills/ksk-keying/scripts/review-index-template.ts
// and review-template.ts. The screens below deliberately reuse THAT
// vocabulary and structure — the same buckets, the same Thai bucket names
// from paths.ts (CATEGORY_TH / VAT_TH), the same statuses (ตรวจแล้ว /
// ต้องตรวจสอบ), the same "ข้อเสนอเท่านั้น ยังไม่ใช่ข้อสรุป" framing for the
// excluded list — so this reads as the same product seen through the
// platform's shell, not a second review tool.
//
// What is NOT reproduced is the document PREVIEW pane, which is the left
// half of the real page: it renders the actual PDF/image/xlsx out of the
// client's month folder. There are no such files in a mock, and a fake
// document image would be the one part of this screen that lies. Everything
// derived from the documents — groups, pages, line items, accounts,
// reasons, flags, exclusions — is here.
export const WF_BUCKETS = [
	{ key: "expense/vat", label: "ค่าใช้จ่าย มีภาษี", path: "ตรวจทาน/ค่าใช้จ่าย/มีภาษี", n: 34 },
	{ key: "expense/non_vat", label: "ค่าใช้จ่าย ไม่มีภาษี", path: "ตรวจทาน/ค่าใช้จ่าย/ไม่มีภาษี", n: 20 },
	{ key: "expense/mixed", label: "ค่าใช้จ่าย คละภาษี", path: "ตรวจทาน/ค่าใช้จ่าย/คละภาษี", n: 4 },
	{ key: "income/vat", label: "รายได้ มีภาษี", path: "ตรวจทาน/รายได้/มีภาษี", n: 23 },
	{ key: "income/non_vat", label: "รายได้ ไม่มีภาษี", path: "ตรวจทาน/รายได้/ไม่มีภาษี", n: 8 },
	{ key: "bank_statement", label: "รายการเดินบัญชี", path: "ตรวจทาน/รายการเดินบัญชี", n: 2 },
];
// A small chart of accounts, in the same code + ชื่อบัญชี shape the real
// review page's ผังบัญชี dropdown uses.
// [รหัสบัญชี, ชื่อบัญชี, รายละเอียดที่มักมาคู่กัน, ทิศทางเงิน (เฉพาะรายการเดินบัญชี)].
// The description travels WITH the account rather than being drawn
// separately — an อ่านค่าน้ำประปา line posted to ค่าขนส่ง would be the one
// thing on this screen a bookkeeper spots as fake in a second.
export const WF_COA_EXPENSE: CoaRow[] = [
	["510101", "ซื้อสินค้า", "ค่าสินค้าตามใบกำกับภาษี"],
	["520211", "ค่าจ้างที่ปรึกษาการตลาด", "ค่าที่ปรึกษาการตลาดรายเดือน"],
	["530101", "ค่าน้ำมันเชื้อเพลิง", "ค่าน้ำมันรถบรรทุก"],
	["530301", "ค่าไฟฟ้า", "ค่าไฟฟ้าประจำงวด"],
	["530302", "ค่าน้ำประปา", "ค่าน้ำประปาประจำงวด"],
	["530401", "ค่าโทรศัพท์และอินเทอร์เน็ต", "ค่าอินเทอร์เน็ตสำนักงาน"],
	["540101", "ค่าขนส่ง", "ค่าขนส่งสินค้า"],
	["540301", "ค่าวัสดุสิ้นเปลืองสำนักงาน", "ค่าวัสดุสำนักงาน"],
	["540501", "ค่าซ่อมแซมและบำรุงรักษา", "ค่าซ่อมเครื่องจักร"],
];
export const WF_COA_INCOME: CoaRow[] = [
	["410101", "รายได้จากการขาย", "ขายสินค้าตามใบกำกับภาษี"],
	["410102", "รายได้ค่าบริการ", "ค่าบริการติดตั้ง"],
	["410901", "รายได้อื่น", "ขายเศษวัสดุ"],
];
export const WF_COA_BANK: CoaRow[] = [
	["212101", "เจ้าหนี้การค้า", "ชำระค่าสินค้า (K BIZ)", "เงินออก"],
	["113101", "ลูกหนี้การค้า", "รับชำระจากลูกค้า", "เงินเข้า"],
	["530301", "ค่าไฟฟ้า", "จ่ายค่าไฟฟ้า", "เงินออก"],
	["540101", "ค่าขนส่ง", "จ่ายค่าขนส่ง", "เงินออก"],
	["213101", "ภาษีหัก ณ ที่จ่ายค้างจ่าย", "นำส่งภาษีหัก ณ ที่จ่าย", "เงินออก"],
	["521101", "เงินเดือน", "จ่ายเงินเดือนพนักงาน", "เงินออก"],
	["540701", "ค่าธรรมเนียมธนาคาร", "ค่าธรรมเนียมโอนเงิน", "เงินออก"],
	["410101", "รายได้จากการขาย", "รับโอนค่าสินค้า", "เงินเข้า"],
	["113101", "ลูกหนี้การค้า", "รับชำระตามใบแจ้งหนี้", "เงินเข้า"],
	["111301", "เงินฝากออมทรัพย์", "โอนระหว่างบัญชีของกิจการ", "เงินเข้า"],
];
// Written the way the pipeline writes its own review_flags: Thai sentences
// that say what to check, not error codes.
export const WF_FLAGS = [
	"ไม่พบเลขประจำตัวผู้เสียภาษีของผู้ขายบนเอกสาร — ตรวจกับทะเบียนผู้ขายก่อนยืนยัน",
	"ยอดรวมบนเอกสารไม่ตรงกับผลรวมรายการ ต่างกัน 0.50 บาท — ตรวจว่าเป็นการปัดเศษหรือคีย์ผิด",
	"เอกสารนี้น่าจะมีภาษีหัก ณ ที่จ่าย แต่ไม่พบหนังสือรับรอง — ตรวจสอบก่อนส่งออก",
	"เอกสารมีสำเนาซ้อนกันสองใบในไฟล์เดียว — ยืนยันว่าไม่ได้บันทึกซ้ำ",
];
// A เหตุผลการจัดหมวด has to agree with the confidence beside it — a "ระบุ
// ชัดเจน" reason under ความมั่นใจ ต่ำ is the sort of thing that makes a
// reviewer stop trusting the whole screen. Two sets, picked by confidence.
export const WF_REASONS_SURE = [
	"ชื่อผู้ขายและรายละเอียดตรงกับรายการที่เคยลงบัญชีนี้ในงวดก่อน",
	"เข้าเกณฑ์ค่าใช้จ่ายดำเนินงานตามผังบัญชีของลูกค้า",
	"รายละเอียดบนเอกสารระบุประเภทงานชัดเจน จึงลงตามบัญชีที่ตรงที่สุด",
];
export const WF_REASONS_UNSURE = [
	"ยังไม่มีประวัติการลงบัญชีของผู้ขายรายนี้ — เลือกจากลักษณะรายการเป็นหลัก ควรให้คนยืนยัน",
	"รายละเอียดบนเอกสารกว้างเกินกว่าจะชี้บัญชีได้ชัด — เลือกบัญชีที่ใกล้เคียงที่สุดไว้ก่อน",
	"รายการนี้เข้าได้สองบัญชี ขึ้นกับนโยบายของลูกค้า — ยังไม่ตัดสินแทน",
];
// The pipeline's own exclusion reasons. "duplicate" is the one that must
// also carry duplicate_of — naming the original (kept) page as a Page-Ledger
// unit id — because "ซ้ำ" alone does not tell a reviewer WHICH page to
// compare against (see references/schemas/segment-interpretation.md, and
// validate-interpretation rejects a duplicate claim without it).
export const WF_EXCLUDE_REASONS = ["duplicate", "blank_page", "not_accounting_document", "unreadable_scan"];
export const WF_EXCLUDE_REASON_TH: Record<string, string> = {
	duplicate: "ซ้ำกับหน้าอื่น",
	blank_page: "หน้าว่าง",
	not_accounting_document: "ไม่ใช่เอกสารทางบัญชี",
	unreadable_scan: "สแกนไม่ชัด อ่านไม่ออก",
};
// The source file a document came out of follows its bucket — an expense
// document does not come out of the bank statement PDF.
export const WF_SRC_FILES: Record<string, string[]> = {
	expense: ["บิลซื้อ เดือน กรกฎาคม.pdf", "ใบเสร็จค่าใช้จ่าย.pdf"],
	income: ["บิลขาย เดือน กรกฎาคม.pdf"],
	bank_statement: ["statement_ka.pdf"],
};
