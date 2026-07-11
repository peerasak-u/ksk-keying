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
