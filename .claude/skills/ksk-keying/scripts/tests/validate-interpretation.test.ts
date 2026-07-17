import { describe, expect, test } from "bun:test";
import {
	SEGMENT_INTERPRETATION_SCHEMA,
	interpretationWarnings,
	validateInterpretation,
} from "../validate-interpretation";

// --- fixtures: the canonical shapes ------------------------------------------

function transactionShape(): Record<string, unknown> {
	return {
		schema: SEGMENT_INTERPRETATION_SCHEMA,
		segment_id: "seg-001",
		documents: [
			{
				source_file: "บิลซื้อ.pdf",
				source_page: 5,
				doc_kind: "normal_bill_or_invoice",
				document_role: "supplier_invoice",
				usable_for_booking: true,
			},
		],
		relationship: { same_transaction: true, reason: "single invoice" },
		accounting_facts: {
			direction: "expense",
			document_date: "2026-05-22",
			document_no: "INV-001",
			gross_total: 1070,
			vat: 70,
		},
		line_items: [{ description: "ของ A", amount: 1000, vat_rate: 7 }],
		review_flags: [],
		questions_for_user: [],
		page_disposition: [{ file: "บิลซื้อ.pdf", page: 5, disposition: "used" }],
	};
}

function bundleDoc(no: string | null, page: number): Record<string, unknown> {
	return {
		source_file: "บิลซื้อ.pdf",
		source_page: page,
		doc_kind: "normal_bill_or_invoice",
		usable_for_booking: true,
		accounting_facts: {
			direction: "expense",
			document_date: "2026-04-03",
			document_no: no,
			gross_total: 856,
			vat: 56,
		},
		line_items: [{ description: "ของ", amount: 800, vat_rate: 7 }],
	};
}

function bundleShape(): Record<string, unknown> {
	return {
		schema: SEGMENT_INTERPRETATION_SCHEMA,
		segment_id: "seg-004",
		documents: [bundleDoc("IV-1", 1), bundleDoc("IV-2", 2)],
		relationship: { same_transaction: false, reason: "independent purchases" },
		review_flags: [],
		questions_for_user: [],
		page_disposition: [
			{ file: "บิลซื้อ.pdf", page: 1, disposition: "used" },
			{ file: "บิลซื้อ.pdf", page: 2, disposition: "used" },
		],
	};
}

function statementShape(): Record<string, unknown> {
	return {
		schema: SEGMENT_INTERPRETATION_SCHEMA,
		segment_id: "seg-009",
		bank: "Kasikornbank",
		account_no: "221-1-90947-4",
		transactions: [
			{ date_iso: "2026-05-02", direction: "out", amount: 100, balance: 900 },
		],
		documents: [{ source_file: "STM.pdf", source_page: 1, doc_kind: "bank_statement" }],
		page_disposition: [{ file: "STM.pdf", page: 1, disposition: "used" }],
	};
}

// --- canonical shapes pass ----------------------------------------------------

describe("validateInterpretation — canonical shapes", () => {
	test("transaction shape (single document) passes", () => {
		expect(validateInterpretation(transactionShape())).toEqual([]);
	});

	test("transaction shape with several same-transaction documents passes", () => {
		const interp = transactionShape();
		(interp.documents as unknown[]).push({
			source_file: "บิลซื้อ.pdf",
			source_page: 6,
			doc_kind: "payment_slip",
			document_role: "payment_evidence",
			usable_for_booking: false,
		});
		expect(validateInterpretation(interp)).toEqual([]);
	});

	test("bundle shape (independent documents, nested facts) passes", () => {
		expect(validateInterpretation(bundleShape())).toEqual([]);
	});

	test("bundle entry with explicit document_no: null passes", () => {
		const interp = bundleShape();
		(interp.documents as Record<string, unknown>[])[1] = bundleDoc(null, 2);
		expect(validateInterpretation(interp)).toEqual([]);
	});

	test("statement shape passes", () => {
		expect(validateInterpretation(statementShape())).toEqual([]);
	});
});

// --- the five _216 shapes: only nested-per-document is canonical --------------

describe("validateInterpretation — _216 shape variants are rejected", () => {
	test("flat fields on documents[] entries (no nested accounting_facts)", () => {
		const interp = bundleShape();
		interp.documents = [
			{ source_file: "บิลซื้อ.pdf", source_page: 1, doc_kind: "normal_bill_or_invoice", document_no: "IV-1", gross_total: 856 },
			{ source_file: "บิลซื้อ.pdf", source_page: 2, doc_kind: "normal_bill_or_invoice", document_no: "IV-2", gross_total: 500 },
		];
		const errors = validateInterpretation(interp);
		expect(errors.join("\n")).toContain("accounting_facts missing");
	});

	test("top-level transactions[] blocks on a non-statement file", () => {
		const interp = bundleShape();
		interp.transactions = [
			{ transaction_id: "t1", document_no: "IV-1", gross_total: 856 },
			{ transaction_id: "t2", document_no: "IV-2", gross_total: 500 },
		];
		const errors = validateInterpretation(interp);
		expect(errors.join("\n")).toContain("transactions[]");
	});

	test("invented document_groups[] arrays", () => {
		const interp = bundleShape();
		interp.document_groups = [{ document_no: "IV-1" }, { document_no: "IV-2" }];
		const errors = validateInterpretation(interp);
		expect(errors.join("\n")).toContain('unexpected top-level array "document_groups"');
	});

	test("duplicate per-page entries repeating one document_no", () => {
		const interp = bundleShape();
		interp.documents = [bundleDoc("IV-1", 1), bundleDoc("IV-1", 2)];
		const errors = validateInterpretation(interp);
		expect(errors.join("\n")).toContain('repeats document_no "IV-1"');
	});

	test("mixed: top-level facts AND nested facts on a bundle file", () => {
		const interp = bundleShape();
		interp.accounting_facts = { direction: "expense", document_no: "IV-1" };
		interp.line_items = [{ description: "x", amount: 1 }];
		const errors = validateInterpretation(interp);
		expect(errors.join("\n")).toContain("top-level accounting_facts on a bundle file");
		expect(errors.join("\n")).toContain("top-level line_items on a bundle file");
	});
});

// --- other contract violations -------------------------------------------------

describe("validateInterpretation — contract violations", () => {
	test("missing schema marker / segment_id", () => {
		const interp = transactionShape();
		delete interp.schema;
		delete interp.segment_id;
		const errors = validateInterpretation(interp);
		expect(errors.join("\n")).toContain("schema marker");
		expect(errors.join("\n")).toContain("segment_id missing");
	});

	test("multi-document file without relationship.same_transaction", () => {
		const interp = bundleShape();
		delete interp.relationship;
		const errors = validateInterpretation(interp);
		expect(errors.join("\n")).toContain("relationship.same_transaction");
	});

	test("transaction shape must not nest facts or document_no on entries", () => {
		const interp = transactionShape();
		(interp.documents as unknown[]).push({
			source_file: "บิลซื้อ.pdf",
			source_page: 6,
			doc_kind: "receipt",
			document_no: "RCPT-9",
			accounting_facts: { direction: "expense", document_no: "RCPT-9" },
		});
		const errors = validateInterpretation(interp);
		expect(errors.join("\n")).toContain("nests accounting_facts in a one-transaction file");
		expect(errors.join("\n")).toContain("carries document_no");
	});

	test("direction and document_no key are required in facts", () => {
		const interp = transactionShape();
		interp.accounting_facts = { gross_total: 100 };
		const errors = validateInterpretation(interp);
		expect(errors.join("\n")).toContain('direction "missing"');
		expect(errors.join("\n")).toContain("no document_no key");
	});

	test("page_disposition must exist, cover pages, and justify exclusions", () => {
		const empty = transactionShape();
		empty.page_disposition = [];
		expect(validateInterpretation(empty).join("\n")).toContain("page_disposition[] missing or empty");

		const bad = transactionShape();
		bad.page_disposition = [
			{ file: "บิลซื้อ.pdf", disposition: "used" },
			{ file: "บิลซื้อ.pdf", page: 6, disposition: "excluded" },
		];
		const errors = validateInterpretation(bad);
		expect(errors.join("\n")).toContain("neither page nor sheet");
		expect(errors.join("\n")).toContain("excluded without a reason");
	});

	test("documents entries need doc_kind and a source", () => {
		const interp = transactionShape();
		interp.documents = [{ document_role: "supplier_invoice" }];
		const errors = validateInterpretation(interp);
		expect(errors.join("\n")).toContain("no doc_kind");
		expect(errors.join("\n")).toContain("neither source_file nor artifact");
	});

	test("statement rows need date_iso, in|out direction, numeric amount", () => {
		const interp = statementShape();
		interp.transactions = [{ date_iso: "2026-05-02", direction: "debit", amount: "100", balance: 900 }];
		const errors = validateInterpretation(interp);
		expect(errors.join("\n")).toContain('direction "debit"');
		expect(errors.join("\n")).toContain("amount is not a number");
	});

	test("non-object input", () => {
		expect(validateInterpretation(null)).toEqual(["not a JSON object"]);
		expect(validateInterpretation([1, 2])).toEqual(["not a JSON object"]);
	});
});

// _356 lost counterparty tax ids: readers embedded the 13-digit id inside the
// name string (or dropped it) instead of filling seller_tax_id/buyer_tax_id.
describe("interpretationWarnings — tax id embedded in name strings", () => {
	test("structured tax ids produce no warnings", () => {
		const interp = transactionShape();
		const facts = interp.accounting_facts as Record<string, unknown>;
		facts.seller_name = "บริษัท ปิโตรเลียมไทยคอร์ปอเรชั่น จำกัด";
		facts.seller_tax_id = "0105535099511";
		expect(interpretationWarnings(interp)).toEqual([]);
	});

	test("13-digit id inside seller_name with empty seller_tax_id warns", () => {
		const interp = transactionShape();
		const facts = interp.accounting_facts as Record<string, unknown>;
		facts.seller_name = "บริษัท ปิโตรเลียมไทย จำกัด, tax id 0105535099511, branch 00486";
		facts.seller_tax_id = null;
		const warnings = interpretationWarnings(interp);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("seller_name embeds a tax id");
		expect(warnings[0]).toContain("seller_tax_id");
	});

	test("Thai tax-id phrase without the digits still warns", () => {
		const interp = transactionShape();
		const facts = interp.accounting_facts as Record<string, unknown>;
		facts.buyer_name = "หจก.ทรีที 2009 (เลขประจำตัวผู้เสียภาษีตามเอกสาร)";
		const warnings = interpretationWarnings(interp);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("buyer_name embeds a tax id");
	});

	test("bundle shape warns per nested documents[] entry", () => {
		const interp = bundleShape();
		const docs = interp.documents as Array<Record<string, unknown>>;
		(docs[1].accounting_facts as Record<string, unknown>).seller_name =
			"ร้านค้า 1234567890123";
		const warnings = interpretationWarnings(interp);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("documents[1] seller_name");
	});

	test("statement shape and clean names never warn", () => {
		expect(interpretationWarnings(statementShape())).toEqual([]);
		expect(interpretationWarnings(transactionShape())).toEqual([]);
		expect(interpretationWarnings(null)).toEqual([]);
	});
});

// A VAT-registered document must be internally consistent: vat ≈ 7% of
// (gross_total − vat). A mismatch beyond ±0.02 means a misread digit.
describe("interpretationWarnings — VAT arithmetic", () => {
	test("consistent 7% document produces no warning", () => {
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "expense",
			document_no: "INV-777",
			gross_total: 1500,
			vat: 98.13,
		};
		expect(interpretationWarnings(interp)).toEqual([]);
	});

	test("vat inconsistent with 7% of the implied base warns with tag", () => {
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "expense",
			document_no: "INV-25312",
			gross_total: 25312,
			vat: 1623.22,
		};
		const warnings = interpretationWarnings(interp);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("vat_arithmetic_mismatch");
		expect(warnings[0]).toContain('document_no "INV-25312"');
		expect(warnings[0]).toContain("25312");
		expect(warnings[0]).toContain("1623.22");
		expect(warnings[0]).toContain("1658.21");
	});

	test("non-VAT document (vat null) produces no warning", () => {
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "expense",
			document_no: "CASH-1",
			gross_total: 500,
			vat: null,
		};
		expect(interpretationWarnings(interp)).toEqual([]);
	});

	test("vat 0 and missing gross_total produce no warning", () => {
		const zeroVat = transactionShape();
		zeroVat.accounting_facts = {
			direction: "expense",
			document_no: "EX-1",
			gross_total: 321,
			vat: 0,
		};
		expect(interpretationWarnings(zeroVat)).toEqual([]);

		const noGross = transactionShape();
		noGross.accounting_facts = {
			direction: "expense",
			document_no: "EX-2",
			gross_total: null,
			vat: 70,
		};
		expect(interpretationWarnings(noGross)).toEqual([]);
	});

	test("bundle shape checks nested facts per documents[] entry", () => {
		const interp = bundleShape();
		const docs = interp.documents as Array<Record<string, unknown>>;
		const facts = docs[1].accounting_facts as Record<string, unknown>;
		facts.gross_total = 856;
		facts.vat = 76; // implied base 780, 7% of it is 54.60 — inconsistent
		const warnings = interpretationWarnings(interp);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("documents[1] vat_arithmetic_mismatch");
		expect(warnings[0]).toContain('document_no "IV-2"');
	});

	test("fx-consistent THB facts with face-value fields produce no VAT warning", () => {
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "income",
			document_no: "CA2026050219",
			gross_total: 8849.78,
			vat: 0,
			net_paid: 8849.78,
			currency: "THB",
			original_currency: "USD",
			original_amount: 272.3,
			exchange_rate: 32.5001,
		};
		expect(interpretationWarnings(interp)).toEqual([]);
	});

	test("net_paid above gross_total warns; net_paid below (WHT) does not", () => {
		const above = transactionShape();
		above.accounting_facts = {
			direction: "expense",
			document_no: "INV-9",
			gross_total: 1070,
			vat: 70,
			net_paid: 1100,
		};
		const warnings = interpretationWarnings(above);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("vat_arithmetic_mismatch");
		expect(warnings[0]).toContain("net_paid 1100 exceeding gross_total 1070");

		const wht = transactionShape();
		wht.accounting_facts = {
			direction: "expense",
			document_no: "INV-10",
			gross_total: 1070,
			vat: 70,
			wht_amount: 30,
			net_paid: 1040,
		};
		expect(interpretationWarnings(wht)).toEqual([]);
	});
});

// _336 export-sale invoices: readers kept USD face value in gross_total
// (currency "USD") and parked the printed THB settlement in description free
// text, so downstream booked ~32x low. Money fields must carry THB; the
// optional original_currency/original_amount/exchange_rate fields preserve
// the face-value evidence and must agree with gross_total.
describe("interpretationWarnings — foreign currency", () => {
	test('currency "THB" produces no warning', () => {
		const interp = transactionShape();
		(interp.accounting_facts as Record<string, unknown>).currency = "THB";
		expect(interpretationWarnings(interp)).toEqual([]);
	});

	test("missing currency produces no warning", () => {
		expect(interpretationWarnings(transactionShape())).toEqual([]);
	});

	test('currency "USD" in the money fields warns with tag', () => {
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "income",
			document_no: "CA2026050219",
			gross_total: 272.3,
			vat: 0,
			net_paid: 272.3,
			currency: "USD",
		};
		const warnings = interpretationWarnings(interp);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("non_thb_currency");
		expect(warnings[0]).toContain('document_no "CA2026050219"');
		expect(warnings[0]).toContain('currency "USD"');
		expect(warnings[0]).toContain("original_currency/original_amount/exchange_rate");
	});

	test("lowercase foreign code still warns; lowercase thb does not", () => {
		const usd = transactionShape();
		(usd.accounting_facts as Record<string, unknown>).currency = "usd";
		expect(interpretationWarnings(usd).join("\n")).toContain("non_thb_currency");

		const thb = transactionShape();
		(thb.accounting_facts as Record<string, unknown>).currency = "thb";
		expect(interpretationWarnings(thb)).toEqual([]);
	});

	test("gross_total agreeing with original_amount × exchange_rate passes (printed-figure drift tolerated)", () => {
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "income",
			document_no: "CA2026050219",
			gross_total: 8849.78, // printed payment-block THB; 272.30 × 32.5001 = 8849.7772…
			vat: 0,
			currency: "THB",
			original_currency: "USD",
			original_amount: 272.3,
			exchange_rate: 32.5001,
		};
		expect(interpretationWarnings(interp)).toEqual([]);
	});

	test("gross_total disagreeing with original_amount × exchange_rate warns with tag", () => {
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "income",
			document_no: "CA2026050219",
			gross_total: 272.3, // USD face value left in the THB field
			vat: 0,
			currency: "THB",
			original_currency: "USD",
			original_amount: 272.3,
			exchange_rate: 32.5001,
		};
		const warnings = interpretationWarnings(interp);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("fx_arithmetic_mismatch");
		expect(warnings[0]).toContain("gross_total 272.3");
		expect(warnings[0]).toContain("8849.78");
	});

	test("original_amount without exchange_rate (or vice versa) skips the fx check", () => {
		const noRate = transactionShape();
		(noRate.accounting_facts as Record<string, unknown>).original_amount = 272.3;
		expect(interpretationWarnings(noRate)).toEqual([]);

		const noAmount = transactionShape();
		(noAmount.accounting_facts as Record<string, unknown>).exchange_rate = 32.5001;
		expect(interpretationWarnings(noAmount)).toEqual([]);
	});

	test("bundle shape warns per nested documents[] entry", () => {
		const interp = bundleShape();
		const docs = interp.documents as Array<Record<string, unknown>>;
		(docs[1].accounting_facts as Record<string, unknown>).currency = "USD";
		const warnings = interpretationWarnings(interp);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("documents[1] non_thb_currency");
		expect(warnings[0]).toContain('document_no "IV-2"');
	});

	test("statement shape never warns about currency", () => {
		const interp = statementShape();
		interp.accounting_facts = { currency: "USD" };
		expect(interpretationWarnings(interp)).toEqual([]);
	});
});

describe("interpretationWarnings — loan role", () => {
	test("income + loan wording in facts, no loan document_role → warns", () => {
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "income",
			document_no: "RE2026050001",
			gross_total: 100000,
			vat: 0,
			description: "รับเงินกู้ยืม OD จากกรรมการ",
		};
		// document_role stays "supplier_invoice" (not a loan role)
		const warnings = interpretationWarnings(interp);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("loan_role_missing");
		expect(warnings[0]).toContain('document_no "RE2026050001"');
		expect(warnings[0]).toContain("loan_receipt");
	});

	test("income + loan wording only in a line item description → warns", () => {
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "income",
			document_no: "RE2026050002",
			gross_total: 50000,
			vat: 0,
			description: "รับเงิน",
		};
		interp.line_items = [{ description: "เงินกู้ยืมระยะสั้น", amount: 50000 }];
		const warnings = interpretationWarnings(interp);
		expect(warnings.some((w) => w.includes("loan_role_missing"))).toBe(true);
	});

	test("silent when a loan document_role is already present", () => {
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "income",
			document_no: "RE2026050003",
			gross_total: 100000,
			vat: 0,
			description: "รับเงินกู้ยืม OD",
		};
		(interp.documents as Array<Record<string, unknown>>)[0].document_role = "loan_receipt";
		expect(interpretationWarnings(interp)).toEqual([]);
	});

	test("silent for expense direction even with loan wording (loan repayment, not a draw)", () => {
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "expense",
			document_no: "PV-1",
			gross_total: 10000,
			vat: 0,
			description: "ชำระคืนเงินกู้ยืม OD",
		};
		expect(interpretationWarnings(interp)).toEqual([]);
	});

	test("silent for ordinary income (no loan wording)", () => {
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "income",
			document_no: "IV-9",
			gross_total: 1070,
			vat: 70,
			description: "ค่าบริการออกแบบ",
		};
		expect(interpretationWarnings(interp)).toEqual([]);
	});

	test("bundle shape warns on the specific nested income loan-draw document", () => {
		const interp = bundleShape();
		const docs = interp.documents as Array<Record<string, unknown>>;
		docs[1].accounting_facts = {
			direction: "income",
			document_no: "RE-2",
			gross_total: 50000,
			vat: 0,
			description: "เงินกู้ยืม OD",
		};
		const warnings = interpretationWarnings(interp);
		expect(warnings.some((w) => w.includes("documents[1] loan_role_missing"))).toBe(true);
		expect(warnings.some((w) => w.includes("documents[0] loan_role_missing"))).toBe(false);
	});
});

describe("interpretationWarnings — credit note sign", () => {
	test("document_role names credit_note but gross_total is positive → warns", () => {
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "expense",
			document_no: "CN690410110028",
			gross_total: 7983.62,
			vat: 522.29,
			description: "ใบลดหนี้ — คืนค่าเช่าของบิลเลขที่ RR69040328",
		};
		(interp.documents as Array<Record<string, unknown>>)[0].document_role = "credit_note";
		const warnings = interpretationWarnings(interp);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("credit_note_sign_positive");
		expect(warnings[0]).toContain('document_no "CN690410110028"');
		expect(warnings[0]).toContain("gross_total 7983.62");
	});

	test("description wording alone, no document_role — deliberately silent (unlike loan role)", () => {
		// The _345 run showed an ORIGINAL invoice's own description mentioning
		// "a same-day credit note ... reduces this invoice" just as often as the
		// note itself says "represents a reduction" — a text fallback here would
		// flag the wrong document. document_role is the only signal on purpose.
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "expense",
			document_no: "CDGHBKRF01A-690413-0003",
			gross_total: 45,
			vat: 2.94,
			description: "ใบรับคืนสินค้า — คืนรายการค่าจัดส่งเต็มจำนวน",
		};
		// document_role stays "supplier_invoice" (not tagged credit_note)
		expect(interpretationWarnings(interp)).toEqual([]);
	});

	test("original invoice's description mentioning a credit note elsewhere stays silent", () => {
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "expense",
			document_no: "TF690410110143",
			gross_total: 59877.16,
			vat: 3917.2,
			description: "ค่าเช่าอุปกรณ์นั่งร้าน; a same-day credit note (source_page 5) partially reduces this invoice",
		};
		// document_role stays "supplier_invoice" — this IS the original invoice,
		// not the credit note that reduces it
		expect(interpretationWarnings(interp)).toEqual([]);
	});

	test("already-negative gross_total stays silent", () => {
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "expense",
			document_no: "CN690410110028",
			gross_total: -7983.62,
			vat: -522.29,
			description: "ใบลดหนี้ — คืนค่าเช่าของ",
		};
		(interp.documents as Array<Record<string, unknown>>)[0].document_role = "credit_note";
		expect(interpretationWarnings(interp)).toEqual([]);
	});

	test("silent for an ordinary positive invoice (no credit-note signal)", () => {
		const interp = transactionShape();
		interp.accounting_facts = {
			direction: "expense",
			document_no: "INV-9",
			gross_total: 1070,
			vat: 70,
			description: "ซื้อวัสดุอุปกรณ์ก่อสร้าง",
		};
		expect(interpretationWarnings(interp)).toEqual([]);
	});

	test("bundle shape warns on the specific nested credit-note document", () => {
		const interp = bundleShape();
		const docs = interp.documents as Array<Record<string, unknown>>;
		docs[1].document_role = "credit_note";
		docs[1].accounting_facts = {
			direction: "expense",
			document_no: "CN-2",
			gross_total: 1040,
			vat: 68,
			description: "ใบลดหนี้ — คืนสินค้าเต็มจำนวน",
		};
		const warnings = interpretationWarnings(interp);
		expect(warnings.some((w) => w.includes("documents[1] credit_note_sign_positive"))).toBe(true);
		expect(warnings.some((w) => w.includes("documents[0] credit_note_sign_positive"))).toBe(false);
	});
});
