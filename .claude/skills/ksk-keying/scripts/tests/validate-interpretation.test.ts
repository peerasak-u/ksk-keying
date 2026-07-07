import { describe, expect, test } from "bun:test";
import {
	SEGMENT_INTERPRETATION_SCHEMA,
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
