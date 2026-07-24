// PROTOTYPE — throwaway. Mock exclusion claims for the excluded/skip review
// page prototype (wayfinder ticket #34 on map #29). Reason vocabulary
// (duplicate / context_file / summary_report / blank) matches real
// dispositions.yaml / ledger.ts usage in this repo — content is fabricated,
// no real client data. In-memory only; resets on server restart.

export type ReasonKind = "duplicate" | "context_file" | "summary_report" | "blank";
export type DeclaredBy = "agent" | "agent_policy";
export type ClaimStatus = "pending" | "confirmed" | "brought_back";

export type ExclusionClaim = {
	id: string;
	file: string;
	unit: string; // page or sheet label, e.g. "หน้า 1" or "sผังบัญชี"
	kind: "pdf" | "xlsx";
	reason: ReasonKind;
	declaredBy: DeclaredBy;
	duplicateOf?: { file: string; unit: string }; // only for reason: duplicate
	status: ClaimStatus;
};

export const REASON_LABEL: Record<ReasonKind, string> = {
	duplicate: "ซ้ำกับเอกสารอื่น",
	context_file: "ไฟล์อ้างอิง (ผังบัญชี)",
	summary_report: "รายงานสรุป ไม่ใช่ต้นฉบับ",
	blank: "หน้าว่าง / ไม่มีเนื้อหา",
};

// summary_report is the historically riskiest exclusion category — a real
// past miss (client 339's ภาษีซื้อ.xlsx, ~101 invoices) was a summary
// workbook wrongly excluded this way and caught only by a dedicated
// reference-report check, not by any other review step.
export const REASON_EXTRA_SCRUTINY: Partial<Record<ReasonKind, string>> = {
	summary_report: "หมวดนี้เคยพลาดจริงมาก่อน — ตรวจสอบให้แน่ใจว่าไม่ใช่ต้นฉบับใบกำกับ",
};

export const CLIENT_LABEL = "C001 — บริษัท เอบีซี การบัญชี จำกัด — พฤษภาคม";

export const CLAIMS: ExclusionClaim[] = [
	{
		id: "cl-01",
		file: "ค่าใช้จ่าย Grab/receipt-0421 (1).pdf",
		unit: "หน้า 1",
		kind: "pdf",
		reason: "duplicate",
		declaredBy: "agent",
		duplicateOf: { file: "ค่าใช้จ่าย Grab/receipt-0421.pdf", unit: "หน้า 1" },
		status: "pending",
	},
	{
		id: "cl-02",
		file: "ค่าใช้จ่าย Grab/receipt-0421.pdf",
		unit: "หน้า 2",
		kind: "pdf",
		reason: "blank",
		declaredBy: "agent",
		status: "pending",
	},
	{
		id: "cl-03",
		file: "ผังบัญชี บจก.เอบีซี.xlsx",
		unit: "sผังบัญชี",
		kind: "xlsx",
		reason: "context_file",
		declaredBy: "agent_policy",
		status: "pending",
	},
	{
		id: "cl-04",
		file: "รายงานภาษีซื้อสรุปเดือนพฤษภาคม.xlsx",
		unit: "sSheet1",
		kind: "xlsx",
		reason: "summary_report",
		declaredBy: "agent",
		status: "pending",
	},
	{
		id: "cl-05",
		file: "ใบเสร็จร้านค้า/receipt-0099 (copy).pdf",
		unit: "หน้า 1",
		kind: "pdf",
		reason: "duplicate",
		declaredBy: "agent",
		duplicateOf: { file: "ใบเสร็จร้านค้า/receipt-0099.pdf", unit: "หน้า 1" },
		status: "pending",
	},
	{
		id: "cl-06",
		file: "สัญญาเช่าสำนักงาน.pdf",
		unit: "หน้า 4",
		kind: "pdf",
		reason: "blank",
		declaredBy: "agent",
		status: "pending",
	},
	{
		id: "cl-07",
		file: "ใบกำกับภาษี/invoice-1187.pdf",
		unit: "หน้า 1",
		kind: "pdf",
		reason: "duplicate",
		declaredBy: "agent",
		duplicateOf: { file: "ใบกำกับภาษี/invoice-1187 (2).pdf", unit: "หน้า 1" },
		status: "pending",
	},
	{
		id: "cl-08",
		file: "หน้าปกเอกสารแนบ.pdf",
		unit: "หน้า 1",
		kind: "pdf",
		reason: "blank",
		declaredBy: "agent",
		status: "pending",
	},
];
