// Grading spec for ksk-watson (segment interpretation).
//
// Expectation contract: expected.json is what a *correct watson* returns —
// "record what the document shows, flag what it can't" — not the idealized
// answer-key booking. A document that prints no WHT has expected wht: null
// plus an expected flag, even when the accountant books WHT downstream.

export const CRITICAL_FIELDS = [
	"document_no",
	"document_date",
	"seller_tax_id",
	"buyer_tax_id",
	"gross_total",
	"vat",
	"wht",
	"direction",
	"doc_kind",
] as const;

export const SOFT_FIELDS = ["seller_name", "buyer_name", "description"] as const;

export const AMOUNT_FIELDS = new Set(["gross_total", "vat", "wht"]);

// Fields where null and 0 book identically. wht null ("nothing shown") and
// wht 0 both mean "no WHT to withhold" — grading them apart would punish a
// wording difference, not a booking difference. NOT applied to vat: the
// playbook gives vat:0 an explicit meaning ("printed as 0") distinct from null.
export const NULL_ZERO_EQUIVALENT = new Set(["wht"]);
export const TEXT_NORMALIZED_FIELDS = new Set(["seller_name", "buyer_name"]);

// A wrong critical value counts as `wrong_flagged` (instead of `wrong_silent`)
// when some review flag / warning on the output mentions the field. Keyword
// match is case-insensitive substring.
export const FLAG_KEYWORDS: Record<string, string[]> = {
	document_no: ["document_no", "doc no", "เลขที่", "number", "numbering"],
	document_date: ["date", "วันที่"],
	seller_tax_id: ["tax id", "tax_id", "เลขประจำตัว"],
	buyer_tax_id: ["tax id", "tax_id", "เลขประจำตัว", "buyer"],
	gross_total: ["total", "amount", "ยอด", "รวม"],
	vat: ["vat", "ภาษีมูลค่าเพิ่ม", "tax invoice"],
	wht: ["wht", "หัก ณ ที่จ่าย", "ภงด", "withhold"],
	direction: ["direction", "expense", "income"],
	doc_kind: ["kind", "classif"],
};

// doc_kind mismatches that are equivalent for booking purposes — graded
// correct. Keep this list short and explicit.
export const DOC_KIND_ALIASES: Array<[string, string]> = [
	["normal_bill_or_invoice", "generic"],
];
