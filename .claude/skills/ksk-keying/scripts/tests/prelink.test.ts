import { describe, expect, test } from "bun:test";
import { buildDraft, fingerprintOf, type Fingerprint } from "../prelink";
import type { InterpFile, Interpretation } from "../groups-lib";

function print(overrides: Partial<Fingerprint>): Fingerprint {
	return {
		segmentId: "seg-000",
		path: "ข้อมูลระบบ/_segments/seg-000/interpretation.json",
		documentNo: null,
		reference: null,
		date: null,
		amounts: [],
		taxIds: [],
		statement: false,
		bookable: true,
		...overrides,
	};
}

describe("fingerprintOf", () => {
	test("extracts numbers, amounts, tax ids and statement shape", () => {
		const file: InterpFile = {
			path: "p",
			segmentId: "seg-001",
			json: {
				accounting_facts: {
					document_no: "INV-1",
					reference: "PO-9",
					document_date: "2026-05-01",
					gross_total: 1070,
					net_paid: 1070,
					seller_tax_id: "1111111111111",
				},
			} as Interpretation,
		};
		const fp = fingerprintOf(file);
		expect(fp.documentNo).toBe("INV-1");
		expect(fp.reference).toBe("PO-9");
		expect(fp.amounts).toEqual([1070]); // deduped
		expect(fp.taxIds).toEqual(["1111111111111"]);
		expect(fp.statement).toBe(false);
		// statement-shaped rows (date_iso/balance) mark a statement…
		expect(
			fingerprintOf({
				path: "p",
				segmentId: "s",
				json: { transactions: [{ date_iso: "2026-05-01", direction: "in", amount: 100, balance: 100 }] },
			} as never).statement,
		).toBe(true);
		// …but an improvised invoice-cluster list under the same key does not (_262 seg-024),
		// and an empty array proves nothing
		expect(
			fingerprintOf({
				path: "p",
				segmentId: "s",
				json: { transactions: [{ group: "A", accounting_facts: { document_no: "INV-1" } }] },
			} as never).statement,
		).toBe(false);
		expect(fingerprintOf({ path: "p", segmentId: "s", json: { transactions: [] } }).statement).toBe(false);
	});
});

describe("buildDraft", () => {
	test("clusters on exact shared document number, slip as supporting evidence", () => {
		const invoice = print({ segmentId: "seg-001", documentNo: "INV-1", date: "2026-05-01", amounts: [1070] });
		const slip = print({ segmentId: "seg-002", reference: "INV-1", amounts: [1070] });
		const { proposed, residue } = buildDraft([invoice, slip]);
		expect(residue).toHaveLength(0);
		expect(proposed).toHaveLength(1);
		expect(proposed[0].segments).toEqual(["seg-001", "seg-002"]);
		expect(proposed[0].bookable_docs).toEqual(["INV-1"]);
		expect(proposed[0].rules).toEqual(["same_document_no"]);
		expect(proposed[0].confidence).toBe("high");
		expect(proposed[0].members.map((m) => m.proposed_role)).toEqual([
			"primary_invoice",
			"supporting_evidence",
		]);
	});

	test("clusters on exact amount+date+tax-id triple at medium confidence", () => {
		const invoice = print({ segmentId: "seg-001", documentNo: "INV-1", date: "2026-05-01", amounts: [500], taxIds: ["1111111111111"] });
		const wht = print({ segmentId: "seg-003", date: "2026-05-01", amounts: [500], taxIds: ["1111111111111"] });
		const { proposed, residue } = buildDraft([invoice, wht]);
		expect(residue).toHaveLength(0);
		expect(proposed).toHaveLength(1);
		expect(proposed[0].rules).toEqual(["amount_date_counterparty"]);
		expect(proposed[0].confidence).toBe("medium");
	});

	test("same amount+date but no shared tax id does NOT cluster", () => {
		const a = print({ segmentId: "seg-001", documentNo: "A", date: "2026-05-01", amounts: [500], taxIds: ["1111111111111"] });
		const b = print({ segmentId: "seg-002", documentNo: "B", date: "2026-05-01", amounts: [500], taxIds: ["2222222222222"] });
		const { proposed } = buildDraft([a, b]);
		expect(proposed).toHaveLength(2);
		expect(proposed.every((c) => c.segments.length === 1)).toBe(true);
	});

	test("duplicate document numbers demote the whole cluster to residue", () => {
		const original = print({ segmentId: "seg-001", documentNo: "INV-1" });
		const copy = print({ segmentId: "seg-002", documentNo: "INV-1" });
		const { proposed, residue } = buildDraft([original, copy]);
		expect(proposed).toHaveLength(0);
		expect(residue).toHaveLength(2);
		expect(residue[0].reason).toContain("INV-1");
	});

	test("two invoices + one evidence-only receipt: one cluster, two bookable docs", () => {
		const invoiceA = print({ segmentId: "seg-015", documentNo: "IVT-028", reference: "RE-007" });
		const invoiceB = print({ segmentId: "seg-017", documentNo: "IVT-029", reference: "RE-007" });
		const receipt = print({ segmentId: "seg-018", documentNo: "RE-007", bookable: false });
		const { proposed, residue } = buildDraft([invoiceA, invoiceB, receipt]);
		expect(residue).toHaveLength(0);
		expect(proposed).toHaveLength(1);
		expect(proposed[0].bookable_docs.sort()).toEqual(["IVT-028", "IVT-029"].sort());
		const receiptMember = proposed[0].members.find((m) => m.segment === "seg-018");
		expect(receiptMember?.proposed_role).toBe("supporting_evidence");
	});

	test("fingerprint marks a file bookable: false only when every flagged document says so", () => {
		const evidenceOnly: InterpFile = {
			path: "p",
			segmentId: "seg-018",
			json: {
				documents: [{ usable_for_booking: false, document_role: "payment_receipt" }],
				accounting_facts: { document_no: "RE-007" },
			} as Interpretation,
		};
		expect(fingerprintOf(evidenceOnly).bookable).toBe(false);
		const unflagged: InterpFile = {
			path: "p",
			segmentId: "seg-001",
			json: { accounting_facts: { document_no: "INV-1" } } as Interpretation,
		};
		expect(fingerprintOf(unflagged).bookable).toBe(true);
	});

	test("standalone document with a number proposes itself; without one it is residue", () => {
		const withNo = print({ segmentId: "seg-001", documentNo: "INV-1" });
		const without = print({ segmentId: "seg-002" });
		const { proposed, residue } = buildDraft([withNo, without]);
		expect(proposed).toHaveLength(1);
		expect(proposed[0].bookable_docs).toEqual(["INV-1"]);
		expect(residue).toHaveLength(1);
		expect(residue[0].segment).toBe("seg-002");
	});

	test("statements become standalone proposals and never auto-cluster", () => {
		const statement = print({ segmentId: "seg-009", statement: true, date: "2026-05-01", amounts: [100], taxIds: ["1111111111111"] });
		const invoice = print({ segmentId: "seg-001", documentNo: "INV-1", date: "2026-05-01", amounts: [100], taxIds: ["1111111111111"] });
		const { proposed } = buildDraft([statement, invoice]);
		expect(proposed).toHaveLength(2);
		const stmtCluster = proposed.find((c) => c.segments[0] === "seg-009");
		expect(stmtCluster?.rules).toEqual(["standalone_statement"]);
		expect(stmtCluster?.bookable_docs).toEqual([]);
	});
});
