import { describe, expect, test } from "bun:test";
import { assignUnitOrdinals, buildDraft, collapseSameSegmentDuplicates, fingerprintsOf, type Fingerprint } from "../prelink";
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
		sourceFile: null,
		sourcePage: null,
		sourceSheet: null,
		unitOrdinal: 1,
		...overrides,
	};
}

describe("fingerprintsOf", () => {
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
		const prints = fingerprintsOf(file);
		expect(prints).toHaveLength(1);
		const fp = prints[0];
		expect(fp.documentNo).toBe("INV-1");
		expect(fp.reference).toBe("PO-9");
		expect(fp.amounts).toEqual([1070]); // deduped
		expect(fp.taxIds).toEqual(["1111111111111"]);
		expect(fp.statement).toBe(false);
		// statement-shaped rows (date_iso/balance) mark a statement…
		expect(
			fingerprintsOf({
				path: "p",
				segmentId: "s",
				json: { transactions: [{ date_iso: "2026-05-01", direction: "in", amount: 100, balance: 100 }] },
			} as never)[0].statement,
		).toBe(true);
		// …but an improvised invoice-cluster list under the same key does not (_262 seg-024),
		// and an empty array proves nothing
		expect(
			fingerprintsOf({
				path: "p",
				segmentId: "s",
				json: { transactions: [{ group: "A", accounting_facts: { document_no: "INV-1" } }] },
			} as never)[0].statement,
		).toBe(false);
		expect(fingerprintsOf({ path: "p", segmentId: "s", json: { transactions: [] } })[0].statement).toBe(false);
	});

	test("a multi-document file yields one fingerprint per bundled document", () => {
		const file: InterpFile = {
			path: "ข้อมูลระบบ/_segments/seg-012/interpretation-p1-15.json",
			segmentId: "seg-012",
			json: {
				accounting_facts: { seller_tax_id: "1111111111111", direction: "expense" },
				documents: [
					{ accounting_facts: { document_no: "INV-1", document_date: "2026-05-01", gross_total: 100 } },
					// flat shape — fields directly on the entry
					{ document_no: "INV-2", document_date: "2026-05-02", gross_total: 200 },
					// evidence-only duplicate copy of INV-1: collapsed into INV-1's record upstream
					{ document_no: "INV-1", usable_for_booking: false },
				],
			} as never,
		};
		const prints = fingerprintsOf(file);
		expect(prints.map((p) => p.documentNo).sort()).toEqual(["INV-1", "INV-2"]);
		expect(prints.every((p) => p.path === file.path)).toBe(true);
		const inv2 = prints.find((p) => p.documentNo === "INV-2");
		expect(inv2?.amounts).toEqual([200]);
		// flat entries inherit the file-level counterparty
		expect(inv2?.taxIds).toEqual(["1111111111111"]);
		expect(inv2?.bookable).toBe(true);
	});

	test("a bank-statement file that also bundles real documents surfaces both (_345 seg-007)", () => {
		// Stage 2 wrote a sub-range interpretation whose top-level doc_kind
		// is bank_statement (statement-shaped transactions[] rows), but it
		// ALSO bundles independent payment vouchers plus an orphan bank slip
		// under documents[]. Those must not vanish — they need their own
		// fingerprints alongside the statement's.
		const file: InterpFile = {
			path: "ข้อมูลระบบ/_segments/seg-007/interpretation-p16-30.json",
			segmentId: "seg-007",
			json: {
				doc_kind: "bank_statement",
				accounting_facts: { seller_tax_id: "1111111111111" },
				transactions: [{ date_iso: "2026-05-01", direction: "in", amount: 4220.47, balance: 100000 }],
				documents: [
					{ accounting_facts: { document_no: "PSL2026/087", document_date: "2026-05-02", gross_total: 1000 } },
					{ accounting_facts: { document_no: "PSL2026/098", document_date: "2026-05-03", gross_total: 2000 } },
					// orphan bank slip — no document_no, nested facts only
					{ accounting_facts: { document_date: "2026-05-04", gross_total: 4220.47 } },
				],
			} as never,
		};
		const prints = fingerprintsOf(file);
		const statementPrint = prints.find((p) => p.statement);
		expect(statementPrint).toBeDefined();
		expect(prints.map((p) => p.documentNo).filter(Boolean).sort()).toEqual(["PSL2026/087", "PSL2026/098"]);
		// the orphan slip has no document_no but must still get its own
		// fingerprint (matchable on amount/date instead)
		expect(prints).toHaveLength(4); // statement + 2 vouchers + 1 orphan slip
		expect(prints.filter((p) => !p.statement && p.amounts.includes(4220.47))).toHaveLength(1);
	});

	test("carries source_file/source_page from documents[i].source_file/source_page", () => {
		const file: InterpFile = {
			path: "p",
			segmentId: "seg-012",
			json: {
				accounting_facts: { direction: "expense" },
				documents: [
					{ source_file: "a.pdf", source_page: 77, accounting_facts: { document_no: "INV-1", gross_total: 100 } },
				],
			} as never,
		};
		const fp = fingerprintsOf(file)[0];
		expect(fp.sourceFile).toBe("a.pdf");
		expect(fp.sourcePage).toBe(77);
	});

	test("reference falls back to reference_no free text", () => {
		const file: InterpFile = {
			path: "p",
			segmentId: "seg-020",
			json: { accounting_facts: { document_no: "CN-1", reference_no: "INV-9" } } as never,
		};
		expect(fingerprintsOf(file)[0].reference).toBe("INV-9");
	});
});

describe("collapseSameSegmentDuplicates", () => {
	test("merges one document straddling two dispatch windows of a segment", () => {
		const a = print({ segmentId: "seg-012", path: "…/interpretation-p1-15.json", documentNo: "INV-7", amounts: [100], taxIds: ["1111111111111"] });
		const b = print({ segmentId: "seg-012", path: "…/interpretation-p16-30.json", documentNo: "INV-7", date: "2026-05-01", amounts: [100, 107] });
		const merged = collapseSameSegmentDuplicates([a, b]);
		expect(merged).toHaveLength(1);
		expect(merged[0].date).toBe("2026-05-01");
		expect(merged[0].amounts.sort()).toEqual([100, 107]);
		expect(merged[0].taxIds).toEqual(["1111111111111"]);
	});

	test("keeps the same number in two different segments apart (duplicate copies)", () => {
		const a = print({ segmentId: "seg-001", documentNo: "INV-7" });
		const b = print({ segmentId: "seg-002", documentNo: "INV-7" });
		expect(collapseSameSegmentDuplicates([a, b])).toHaveLength(2);
	});

	// DEFECT FIX (client 345, seg-010): two genuinely different handwritten
	// receipts, page 29 (฿1,400) and page 51 (฿90), both numbered "46" —
	// segment+document_no alone collapsed them into one fingerprint, so the
	// page-51 receipt ended up with no identity in either
	// proposed_transactions or residue_segments at all. The physical unit
	// (source_file + cover page) must keep them apart.
	test("two SAME-segment documents reusing a number on DIFFERENT physical pages stay separate", () => {
		const a = print({
			segmentId: "seg-010",
			documentNo: "46",
			amounts: [1400],
			sourceFile: "เอกสารค่าใช้จ่าย/ใบสำคัญจ่าย PSL.pdf",
			sourcePage: 29,
		});
		const b = print({
			segmentId: "seg-010",
			documentNo: "46",
			amounts: [90],
			sourceFile: "เอกสารค่าใช้จ่าย/ใบสำคัญจ่าย PSL.pdf",
			sourcePage: 51,
		});
		const collapsed = collapseSameSegmentDuplicates([a, b]);
		expect(collapsed).toHaveLength(2);
		expect(collapsed.map((p) => p.sourcePage).sort()).toEqual([29, 51]);
		expect(collapsed.map((p) => p.amounts[0]).sort((x, y) => x - y)).toEqual([90, 1400]);
	});

	// Acceptance counterpart: one document legitimately split across two
	// adjacent ≤15-page dispatch windows (or an original plus its sparse
	// totals page) still merges — Stage-2 anchors a document's identity to
	// its own cover/first page, so both windows describing the SAME document
	// write that SAME source_file/source_page even though only one window
	// physically rendered it.
	test("one document split across two dispatch windows, same physical cover page, still merges", () => {
		const a = print({
			segmentId: "seg-012",
			path: "…/interpretation-p1-15.json",
			documentNo: "INV-7",
			amounts: [100],
			taxIds: ["1111111111111"],
			sourceFile: "ใบกำกับภาษี.pdf",
			sourcePage: 15,
		});
		const b = print({
			segmentId: "seg-012",
			path: "…/interpretation-p16-30.json",
			documentNo: "INV-7",
			date: "2026-05-01",
			amounts: [100, 107],
			sourceFile: "ใบกำกับภาษี.pdf",
			sourcePage: 15,
		});
		const merged = collapseSameSegmentDuplicates([a, b]);
		expect(merged).toHaveLength(1);
		expect(merged[0].date).toBe("2026-05-01");
		expect(merged[0].amounts.sort()).toEqual([100, 107]);
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
		expect(fingerprintsOf(evidenceOnly)[0].bookable).toBe(false);
		const unflagged: InterpFile = {
			path: "p",
			segmentId: "seg-001",
			json: { accounting_facts: { document_no: "INV-1" } } as Interpretation,
		};
		expect(fingerprintsOf(unflagged)[0].bookable).toBe(true);
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

	// Real defect, client 345 (samples/_incidents/345-04-69-2026-07-28-demoted):
	// seg-012's interpretation-u006.json bundles THREE separate handwritten
	// payment slips scanned onto ONE physical page (77) of "เอกสารค่าใช้จ่าย/
	// ใบสำคัญจ่าย PSL.pdf". None carries a document_no, so before this fix all
	// three residue entries were byte-for-byte identical apart from
	// date/amount — nothing named which physical page slot each one was, and
	// the page they live on could never be claimed by any group. A green test
	// here is worthless unless it fails on the OLD shape (document_no: null,
	// no unit fields) — assert the three residue entries are now
	// distinguishable by unit_key even though document_no stays null on all
	// three, matching the real evidence: amount+date rules never pair them
	// (each date is different) so all three land in residue as singles.
	test("three unnumbered documents sharing one physical page get distinct unit keys (client-345 page 77)", () => {
		const file: InterpFile = {
			path: "ข้อมูลระบบ/_segments/seg-012/interpretation-u006.json",
			segmentId: "seg-012",
			json: {
				accounting_facts: { direction: "expense", buyer_tax_id: "0423535000129" },
				documents: [
					{
						source_file: "เอกสารค่าใช้จ่าย/ใบสำคัญจ่าย PSL.pdf",
						source_page: 77,
						usable_for_booking: false,
						accounting_facts: { document_date: "2026-04-04", gross_total: 3000, seller_name: "นายอำไพ วันสวัสดิ์" },
					},
					{
						source_file: "เอกสารค่าใช้จ่าย/ใบสำคัญจ่าย PSL.pdf",
						source_page: 77,
						usable_for_booking: false,
						accounting_facts: { document_date: "2026-04-11", gross_total: 2000, seller_name: "นายอำไพ วันสวัสดิ์" },
					},
					{
						source_file: "เอกสารค่าใช้จ่าย/ใบสำคัญจ่าย PSL.pdf",
						source_page: 77,
						usable_for_booking: false,
						accounting_facts: { document_date: "2026-04-27", gross_total: 3000, seller_name: "นายอำไพ วันสวัสดิ์" },
					},
				],
			} as never,
		};
		const prints = collapseSameSegmentDuplicates(fingerprintsOf(file));
		expect(prints).toHaveLength(3);
		assignUnitOrdinals(prints);
		const { residue, proposed } = buildDraft(prints);
		expect(proposed).toHaveLength(0); // none carry a document_no or match another print exactly
		expect(residue).toHaveLength(3);
		// all three still carry document_no: null (the bug's original symptom)…
		expect(residue.every((r) => r.document_no === null)).toBe(true);
		// …but each is now individually addressable: same file+page, distinct ordinal/unit_key
		expect(residue.every((r) => r.source_file === "เอกสารค่าใช้จ่าย/ใบสำคัญจ่าย PSL.pdf")).toBe(true);
		expect(residue.every((r) => r.source_page === 77)).toBe(true);
		const ordinals = residue.map((r) => r.unit_ordinal).sort();
		expect(ordinals).toEqual([1, 2, 3]);
		const keys = new Set(residue.map((r) => r.unit_key));
		expect(keys.size).toBe(3); // three distinct physical units, not one repeated key
	});
});
