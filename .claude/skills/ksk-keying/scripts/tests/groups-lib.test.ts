import { describe, expect, test } from "bun:test";
import {
	buildDocumentGroupInterpretation,
	buildDocumentReviewData,
	buildStatementGroupInterpretation,
	buildStatementReviewData,
	classifyVat,
	docCategory,
	findDroppedBookableUnits,
	isStatementShaped,
	LOAN_DRAW_WARNING,
	looksLikeLoanDraw,
	planGroups,
	shapeIssuesOf,
	slugify,
	type GroupPlan,
	type InterpFile,
	type Interpretation,
	type LinkCluster,
} from "../groups-lib";

// --- fixtures ---------------------------------------------------------------

function invoiceInterp(overrides: Partial<Interpretation> = {}): Interpretation {
	return {
		segment_id: "seg-001",
		documents: [
			{
				source_file: "บิลซื้อ.pdf",
				source_page: 5,
				doc_kind: "normal_bill_or_invoice",
				document_role: "supplier_invoice",
			},
		],
		accounting_facts: {
			direction: "expense",
			document_date: "2026-05-22",
			document_no: "INV-001",
			seller_name: "หจก.ตัวอย่าง",
			gross_total: 1070,
			vat: 70,
			net_paid: 1070,
			description: "ซื้อสินค้า",
		},
		line_items: [
			{ description: "ของ A", amount: 1000, amount_includes_vat: false, vat_rate: 7 },
		],
		review_flags: [],
		questions_for_user: [],
		page_disposition: [
			{ file: "บิลซื้อ.pdf", page: 5, disposition: "used" },
			{ file: "บิลซื้อ.pdf", page: 6, disposition: "used" },
		],
		...overrides,
	};
}

// a multi-row report bundle (e.g. a VAT purchase-tax report parsed as one
// "generic" document per row) — must never read as a bank statement even
// though every doc_kind is "generic" (_356 seg-007)
function reportBundleInterp(): Interpretation {
	return {
		segment_id: "seg-007",
		documents: Array.from({ length: 4 }, (_, i) => ({
			source_file: "รายงานภาษีซื้อ.pdf",
			source_page: i + 1,
			doc_kind: "generic",
			document_role: "purchase_tax_report_row",
		})),
		page_disposition: [{ file: "รายงานภาษีซื้อ.pdf", page: 1, disposition: "used" }],
	};
}

function statementInterp(): Interpretation {
	return {
		segment_id: "seg-009",
		bank: "Kasikornbank",
		account_no: "221-1-90947-4",
		account_holder: "บจก. ตัวอย่าง",
		statement_period: "01/05/2026 - 31/05/2026",
		opening_balance: 1000,
		closing_balance: 900,
		transactions: [
			{
				date_iso: "2026-05-02",
				time: "10:00",
				description: "โอนออก",
				counterparty: "บจก. ผู้ขาย",
				direction: "out",
				amount: 100,
				balance: 900,
			},
		],
		documents: [{ source_file: "STM.pdf", source_page: 1, doc_kind: "bank_statement" }],
		page_disposition: [
			{ file: "STM.pdf", page: 1, disposition: "used" },
			{ file: "STM.pdf", page: 2, disposition: "used" },
		],
	};
}

const file = (segmentId: string, json: Interpretation, name = "interpretation.json"): InterpFile => ({
	path: `ข้อมูลระบบ/_segments/${segmentId}/${name}`,
	segmentId,
	json,
});

const NO_SOURCES = new Map();

// --- classification ----------------------------------------------------------

describe("classifyVat / docCategory / slugify", () => {
	test("all-vat, all-non-vat, mixed", () => {
		expect(classifyVat([{ vat_rate: 7 }, { vat_treatment: "vat_7" }], { vat: 7 })).toBe("vat");
		expect(classifyVat([{ vat_rate: 0 }, { vat_treatment: "non_vat" }], { vat: 0 })).toBe(
			"non_vat",
		);
		expect(classifyVat([{ vat_rate: 7 }, { vat_rate: 0 }], { vat: 7 })).toBe("mixed");
	});

	test("lines without evidence fall back to document-level vat amount", () => {
		expect(classifyVat([{ description: "x" }], { vat: 70 })).toBe("vat");
		expect(classifyVat([{ description: "x" }], { vat: 0 })).toBe("non_vat");
		expect(classifyVat([], { vat: null })).toBe("non_vat");
	});

	test("statement shape wins over direction; bad direction throws", () => {
		expect(docCategory(statementInterp())).toBe("bank_statement");
		expect(docCategory(invoiceInterp())).toBe("expense");
		expect(() => docCategory({ accounting_facts: { direction: "sideways" } })).toThrow();
	});

	test("an all-generic report-row bundle is not statement-shaped", () => {
		expect(isStatementShaped(reportBundleInterp())).toBe(false);
		// mixed real statement pages + incidental boilerplate generic pages
		// still book as bank_statement
		expect(
			isStatementShaped({
				documents: [
					{ doc_kind: "bank_statement" },
					{ doc_kind: "generic" },
				],
			}),
		).toBe(true);
	});

	test("slugify keeps Thai text and strips path-hostile chars", () => {
		expect(slugify("INV/2026:04*07")).toBe("INV-2026-04-07");
		expect(slugify("บิลซื้อ #5")).toBe("บิลซื้อ-5");
	});
});

// --- planning ----------------------------------------------------------------

describe("planGroups", () => {
	test("one group per bookable doc; shared receipt becomes evidence for both", () => {
		const invoiceA = file("seg-015", invoiceInterp({ accounting_facts: { direction: "expense", document_no: "IVT-028", vat: 7 }, line_items: [{ vat_rate: 7 }] }));
		const invoiceB = file("seg-017", invoiceInterp({ accounting_facts: { direction: "expense", document_no: "IVT-029", vat: 7 }, line_items: [{ vat_rate: 7 }] }));
		const receipt = file("seg-018", invoiceInterp({ accounting_facts: { direction: "expense", document_no: "RE-007", vat: 0 }, line_items: [] }));
		const cluster: LinkCluster = {
			transaction_id: "txn-008",
			segments: ["seg-015", "seg-017", "seg-018"],
			members: [
				{ segment: "seg-015", document_no: "IVT-028", role: "primary_invoice" },
				{ segment: "seg-017", document_no: "IVT-029", role: "primary_invoice" },
				{ segment: "seg-018", document_no: "RE-007", role: "payment_receipt" },
			],
			bookable_docs: ["IVT-028", "IVT-029"],
			evidence: "sum matches receipt",
			confidence: "high",
		};
		const interps = new Map([
			["seg-015", [invoiceA]],
			["seg-017", [invoiceB]],
			["seg-018", [receipt]],
		]);
		const { groups } = planGroups([cluster], interps, NO_SOURCES);
		expect(groups).toHaveLength(2);
		expect(groups.map((g) => g.bookable_doc)).toEqual(["IVT-028", "IVT-029"]);
		for (const group of groups) {
			expect(group.populate).toBe("script");
			expect(group.path.startsWith("expense/vat/")).toBe(true);
			expect(group.evidence_interpretations).toContain(receipt.path);
		}
		// two groups never share a primary
		expect(groups[0].primary_interpretation).not.toBe(groups[1].primary_interpretation);
	});

	test("two bookable docs resolving to one interpretation file demote to agent populate", () => {
		const combined = file(
			"seg-001",
			invoiceInterp({ accounting_facts: { direction: "expense", document_no: "INV-A", vat: 7 } }),
		);
		const cluster: LinkCluster = {
			transaction_id: "txn-001",
			segments: ["seg-001"],
			members: [
				{ segment: "seg-001", document_no: "INV-A", role: "primary_invoice" },
				{ segment: "seg-001", document_no: "INV-B", role: "primary_invoice" },
			],
			bookable_docs: ["INV-A", "INV-B"],
		};
		const { groups } = planGroups([cluster], new Map([["seg-001", [combined]]]), NO_SOURCES);
		expect(groups).toHaveLength(2);
		// INV-B has no matching interpretation -> agent; INV-A resolves but is
		// not demoted (it is the only group with that file as primary)
		const byDoc = Object.fromEntries(groups.map((g) => [g.bookable_doc, g]));
		expect(byDoc["INV-B"].populate).toBe("agent");
		expect(byDoc["INV-A"].populate).toBe("script");
	});

	test("no links.yaml: one group per interpretation file, statements routed to bank_statement", () => {
		const interps = new Map([
			["seg-001", [file("seg-001", invoiceInterp())]],
			["seg-009", [file("seg-009", statementInterp())]],
		]);
		const { groups } = planGroups(null, interps, NO_SOURCES);
		expect(groups).toHaveLength(2);
		const statement = groups.find((g) => g.category === "bank_statement");
		expect(statement?.path.startsWith("bank_statement/")).toBe(true);
		expect(statement?.vat_treatment).toBeNull();
		expect(statement?.populate).toBe("script");
	});

	test("segment missing from links.yaml still becomes a group, with a warning", () => {
		const linked = file("seg-001", invoiceInterp());
		const orphan = file("seg-002", invoiceInterp({ accounting_facts: { direction: "income", document_no: "RC-01", vat: 7 }, line_items: [{ vat_rate: 7 }] }));
		const cluster: LinkCluster = {
			transaction_id: "txn-001",
			segments: ["seg-001"],
			members: [{ segment: "seg-001", document_no: "INV-001", role: "primary_invoice" }],
			bookable_docs: ["INV-001"],
		};
		const interps = new Map([
			["seg-001", [linked]],
			["seg-002", [orphan]],
		]);
		const result = planGroups([cluster], interps, NO_SOURCES);
		expect(result.groups).toHaveLength(2);
		expect(result.warnings.some((w) => w.includes("seg-002"))).toBe(true);
		expect(result.groups[1].path.startsWith("income/vat/")).toBe(true);
	});

	test("income doc mixing VAT lines lands in income/vat with a warning", () => {
		const mixedIncome = file(
			"seg-003",
			invoiceInterp({
				accounting_facts: { direction: "income", document_no: "RC-9", vat: 7 },
				line_items: [{ vat_rate: 7 }, { vat_rate: 0 }],
			}),
		);
		const { groups } = planGroups(null, new Map([["seg-003", [mixedIncome]]]), NO_SOURCES);
		expect(groups[0].path.startsWith("income/vat/")).toBe(true);
		expect(groups[0].warnings.some((w) => w.includes("income"))).toBe(true);
	});

	// docCategory files any money-in document under income — a loan/OD draw is a
	// financing inflow, not revenue (_336: RE2026050001/08/11, ~฿290K). The rule
	// only flags; it never re-routes the category.
	test("income doc describing a loan draw keeps its placement but carries the loan-draw warning", () => {
		const loanDraw = file(
			"seg-004",
			invoiceInterp({
				documents: [{ source_file: "Receipt KKC.pdf", source_page: 12, doc_kind: "normal_bill_or_invoice" }],
				accounting_facts: {
					direction: "income",
					document_no: "RE2026050011",
					gross_total: 10000,
					vat: null,
					description: "เงินกู้ยืมระยะสั้น (OD) — short-term loan received from individual",
				},
				line_items: [{ description: "เงินกู้ยืมระยะสั้น (OD)", amount: 10000, vat_treatment: "non_vat" }],
			}),
		);
		const { groups } = planGroups(null, new Map([["seg-004", [loanDraw]]]), NO_SOURCES);
		expect(groups[0].path.startsWith("income/non_vat/")).toBe(true); // placement unchanged
		expect(groups[0].warnings).toContain(LOAN_DRAW_WARNING);
	});

	test("ordinary income doc gets no loan-draw warning (incl. \"OD\" inside a longer word)", () => {
		const ordinary = file(
			"seg-005",
			invoiceInterp({
				accounting_facts: {
					direction: "income",
					document_no: "INV-77",
					gross_total: 1070,
					vat: 70,
					description: "ค่าบริการออกแบบ PRODUCT CODE 123",
				},
				line_items: [{ description: "งานออกแบบโลโก้", amount: 1000, vat_rate: 7 }],
			}),
		);
		const { groups } = planGroups(null, new Map([["seg-005", [ordinary]]]), NO_SOURCES);
		expect(groups[0].warnings).not.toContain(LOAN_DRAW_WARNING);
	});

	test("expense doc mentioning interest/loan repayment is not flagged — the rule only targets income-bound money-in", () => {
		const repayment = file(
			"seg-006",
			invoiceInterp({
				accounting_facts: {
					direction: "expense",
					document_no: "PV-12",
					gross_total: 5000,
					vat: null,
					description: "ชำระดอกเบี้ยเงินกู้ยืม OD — loan repayment with interest",
				},
				line_items: [{ description: "ดอกเบี้ยเงินกู้", amount: 5000, vat_treatment: "non_vat" }],
			}),
		);
		const { groups } = planGroups(null, new Map([["seg-006", [repayment]]]), NO_SOURCES);
		expect(groups[0].path.startsWith("expense/")).toBe(true);
		expect(groups[0].warnings).not.toContain(LOAN_DRAW_WARNING);
	});

	test("looksLikeLoanDraw signals: document_role naming a loan, word-boundary OD, Thai loan words", () => {
		expect(looksLikeLoanDraw({ description: "รับเงิน" }, [], [{ document_role: "loan_draw_receipt" }])).toBe(true);
		expect(looksLikeLoanDraw({ description: "กู้ยืมเงิน OD — overdraft loan draw" }, [])).toBe(true);
		expect(looksLikeLoanDraw({ description: "รับชำระ OD" }, [])).toBe(true);
		// lowercase "od" is caught too (case-insensitive), \b still guards
		expect(looksLikeLoanDraw({ description: "รับเงิน od จากกรรมการ" }, [])).toBe(true);
		expect(looksLikeLoanDraw({ description: "ขาย GOODS ตาม PRODUCT CODE" }, [])).toBe(false);
		expect(looksLikeLoanDraw({ description: "sale of methods and products" }, [])).toBe(false); // "od" inside a word, not standalone
		expect(looksLikeLoanDraw(null, [{ description: "เงินกู้ยืม" }])).toBe(true);
		expect(looksLikeLoanDraw({ description: "ขายสินค้า" }, [], [{ document_role: "customer_receipt" }])).toBe(false);
	});

	// A single ksk-watson dispatch window over a multi-document pdf_range
	// sub-range legitimately bundles several independent documents into one
	// interpretation-p<range>.json file, each with its own nested
	// accounting_facts/line_items inside documents[i] rather than at the file's
	// top level (see extract-playbooks.md / SKILL.md Stage 2 sub-range
	// dispatch). findPrimary must still resolve document_no matches here.
	function multiDocInterp(): Interpretation {
		return {
			segment_id: "seg-012",
			documents: [
				{
					source_file: "batch.pdf",
					source_page: 3,
					doc_kind: "normal_bill_or_invoice",
					accounting_facts: {
						direction: "expense",
						document_no: "RE-001",
						gross_total: 107,
						vat: 7,
					},
					line_items: [{ description: "ของ A", amount: 100, vat_rate: 7 }],
				} as never,
				{
					source_file: "batch.pdf",
					source_page: 5,
					doc_kind: "normal_bill_or_invoice",
					accounting_facts: {
						direction: "expense",
						document_no: "RE-002",
						gross_total: 50,
						vat: 0,
					},
					line_items: [{ description: "ของ B", amount: 50, vat_rate: 0 }],
				} as never,
			],
			page_disposition: [
				{ file: "batch.pdf", page: 3, disposition: "used" },
				{ file: "batch.pdf", page: 5, disposition: "used" },
			],
		};
	}

	// Both RE-001 and RE-002 are genuinely approved bookable documents in this
	// bundle (usable_for_booking not false, both carry a document_no) — the
	// completeness invariant requires every cluster to account for both, so
	// both are listed here even though each test below only asserts on the one
	// it targets (the sibling group's own resolution is covered by the next
	// test).
	test("bookable doc nested inside a multi-document interpretation file resolves and forces agent populate", () => {
		const batch = file("seg-012", multiDocInterp(), "interpretation-p1-15.json");
		const cluster: LinkCluster = {
			transaction_id: "txn-050",
			segments: ["seg-012"],
			members: [{ segment: "seg-012", document_no: "RE-001", role: "primary_document" }],
			bookable_docs: ["RE-001", "RE-002"],
		};
		const { groups } = planGroups([cluster], new Map([["seg-012", [batch]]]), NO_SOURCES);
		expect(groups).toHaveLength(2);
		const group = groups.find((g) => g.bookable_doc === "RE-001")!;
		// resolved correctly from the nested document, not left unmatched
		expect(group.primary_interpretation).toBe(batch.path);
		expect(group.category).toBe("expense");
		expect(group.vat_treatment).toBe("vat");
		// still needs ksk-marple: a 1:1 file copy would pull in RE-002 too
		expect(group.populate).toBe("agent");
		expect(group.warnings.some((w) => w.includes("bundled"))).toBe(true);
	});

	test("second bookable doc in the same multi-document file also resolves independently", () => {
		const batch = file("seg-012", multiDocInterp(), "interpretation-p1-15.json");
		const cluster: LinkCluster = {
			transaction_id: "txn-051",
			segments: ["seg-012"],
			members: [{ segment: "seg-012", document_no: "RE-002", role: "primary_document" }],
			bookable_docs: ["RE-002", "RE-001"],
		};
		const { groups } = planGroups([cluster], new Map([["seg-012", [batch]]]), NO_SOURCES);
		expect(groups).toHaveLength(2);
		const group = groups.find((g) => g.bookable_doc === "RE-002")!;
		expect(group.category).toBe("expense");
		expect(group.vat_treatment).toBe("non_vat");
		expect(group.populate).toBe("agent");
	});

	// Some ksk-watson children write document_no/gross_total/vat flat on each
	// documents[i] entry instead of nesting them under accounting_facts, with
	// direction/seller/buyer shared at the file level (one batch, one supplier).
	test("flat per-document fields (no nested accounting_facts) still resolve, falling back to file-level direction", () => {
		const flatBatch = file(
			"seg-012",
			{
				segment_id: "seg-012",
				documents: [
					{ source_file: "batch.pdf", source_page: 31, doc_kind: "normal_bill_or_invoice", document_no: "RE-A", gross_total: 900, vat: 0 } as never,
					{ source_file: "batch.pdf", source_page: 33, doc_kind: "normal_bill_or_invoice", document_no: "RE-B", gross_total: 500, vat: 0 } as never,
				],
				accounting_facts: { direction: "expense", seller_name: "Supplier Co.", vat_treatment: "non_vat" },
				line_items: [],
			},
			"interpretation-p31-48.json",
		);
		// RE-A is also a genuinely approved bookable document in this batch
		// (no usable_for_booking:false / duplicate flag on it) — listed here too
		// so the completeness invariant sees it accounted for; this test only
		// asserts on the RE-B group it targets.
		const cluster: LinkCluster = {
			transaction_id: "txn-060",
			segments: ["seg-012"],
			members: [{ segment: "seg-012", document_no: "RE-B", role: "primary_document" }],
			bookable_docs: ["RE-B", "RE-A"],
		};
		const { groups } = planGroups([cluster], new Map([["seg-012", [flatBatch]]]), NO_SOURCES);
		expect(groups).toHaveLength(2);
		const group = groups.find((g) => g.bookable_doc === "RE-B")!;
		expect(group.primary_interpretation).toBe(flatBatch.path);
		expect(group.category).toBe("expense");
		expect(group.vat_treatment).toBe("non_vat");
		expect(group.populate).toBe("agent");
	});

	// ksk-watson tags every page of one multi-page document with that
	// document's number (an "original" page with full facts, a "totals page"
	// repeating just the number, an excluded "duplicate copy" scan) — these
	// must collapse into one match, not read as an ambiguous multi-match.
	test("repeated document_no across an original page, a totals page, and an excluded duplicate collapses to one match", () => {
		const batch = file(
			"seg-012",
			{
				segment_id: "seg-012",
				documents: [
					{
						source_file: "batch.pdf",
						source_page: 31,
						doc_kind: "normal_bill_or_invoice",
						evidence_role: "primary_accounting_doc",
						usable_for_booking: true,
						document_no: "RE-C",
						gross_total: 9383.27,
						vat: 0,
					} as never,
					{
						source_file: "batch.pdf",
						source_page: 32,
						doc_kind: "normal_bill_or_invoice",
						evidence_role: "primary_accounting_doc_totals_page",
						usable_for_booking: true,
						document_no: "RE-C",
					} as never,
					{
						source_file: "batch.pdf",
						source_page: 35,
						doc_kind: "normal_bill_or_invoice",
						evidence_role: "duplicate_copy",
						usable_for_booking: false,
						document_no: "RE-C",
					} as never,
				],
				accounting_facts: { direction: "expense", vat_treatment: "non_vat" },
				line_items: [],
			},
			"interpretation-p31-48.json",
		);
		const cluster: LinkCluster = {
			transaction_id: "txn-061",
			segments: ["seg-012"],
			members: [{ segment: "seg-012", document_no: "RE-C", role: "primary_document" }],
			bookable_docs: ["RE-C"],
		};
		const { groups } = planGroups([cluster], new Map([["seg-012", [batch]]]), NO_SOURCES);
		expect(groups).toHaveLength(1);
		expect(groups[0].warnings.some((w) => w.includes("matches"))).toBe(false);
		expect(groups[0].category).toBe("expense");
		expect(groups[0].vat_treatment).toBe("non_vat");
	});

	// Some ksk-watson children keep the real per-document facts in a parallel
	// top-level transactions[] array (each with its own nested
	// accounting_facts/line_items) while documents[] only carries lightweight
	// per-page linkage with no facts of its own.
	test("facts living in a top-level transactions[] block (not documents[]) still resolve", () => {
		const txnBlockBatch = file(
			"seg-013",
			{
				segment_id: "seg-013",
				documents: [
					{ source_file: "batch.pdf", source_page: 91, doc_kind: "delivery_note", transaction_id: "txn-1" } as never,
				],
				transactions: [
					{
						transaction_id: "txn-1",
						doc_kind: "delivery_note",
						accounting_facts: { direction: "expense", document_no: "CO-999", gross_total: 1571.29, vat: 65.35 },
						line_items: [{ description: "ของ", amount: 933.64, vat_rate: 7 }],
					} as never,
				],
			},
			"interpretation-p91-105.json",
		);
		const cluster: LinkCluster = {
			transaction_id: "txn-070",
			segments: ["seg-013"],
			members: [{ segment: "seg-013", document_no: "CO-999", role: "primary_document" }],
			bookable_docs: ["CO-999"],
		};
		const { groups } = planGroups([cluster], new Map([["seg-013", [txnBlockBatch]]]), NO_SOURCES);
		expect(groups).toHaveLength(1);
		expect(groups[0].primary_interpretation).toBe(txnBlockBatch.path);
		expect(groups[0].category).toBe("expense");
		expect(groups[0].vat_treatment).toBe("vat");
		expect(groups[0].populate).toBe("agent");
	});

	test("document groups without a bookable doc get ID_NOT_FOUND_<n> slugs; statements keep segment-id slugs", () => {
		const noNumberA = file(
			"seg-021",
			invoiceInterp({ accounting_facts: { direction: "expense", document_no: null, vat: 0 }, line_items: [] }),
		);
		const noNumberB = file(
			"seg-022",
			invoiceInterp({ accounting_facts: { direction: "expense", document_no: null, vat: 0 }, line_items: [] }),
		);
		const interps = new Map([
			["seg-009", [file("seg-009", statementInterp())]],
			["seg-021", [noNumberA]],
			["seg-022", [noNumberB]],
		]);
		const { groups } = planGroups(null, interps, NO_SOURCES);
		expect(groups).toHaveLength(3);
		// statement first (sorted segment order) — no sentinel, bare segment-id slug
		expect(groups[0].id).toBe("seg-009");
		expect(groups[0].warnings.some((w) => w.includes("ID_NOT_FOUND"))).toBe(false);
		// each unnumbered document's placeholder index is scoped to its OWN
		// segment (not a plan-wide counter) — both draw "_1", and the segment-id
		// prefix keeps their ids/paths distinct from each other
		expect(groups[1].id).toBe("seg-021-ID_NOT_FOUND_1");
		expect(groups[1].path).toBe("expense/non_vat/seg-021-ID_NOT_FOUND_1");
		expect(
			groups[1].warnings.some(
				(w) => w.includes("document number not found") && w.includes("ID_NOT_FOUND_1"),
			),
		).toBe(true);
		expect(groups[2].id).toBe("seg-022-ID_NOT_FOUND_1");
	});

	test("cluster without bookable_docs also gets a sentinel id", () => {
		const noNumber = file(
			"seg-021",
			invoiceInterp({ accounting_facts: { direction: "expense", document_no: null, vat: 0 }, line_items: [] }),
		);
		const cluster: LinkCluster = {
			transaction_id: "txn-090",
			segments: ["seg-021"],
			members: [{ segment: "seg-021", role: "primary_document" }],
			bookable_docs: [],
		};
		const { groups } = planGroups([cluster], new Map([["seg-021", [noNumber]]]), NO_SOURCES);
		expect(groups).toHaveLength(1);
		expect(groups[0].id).toBe("seg-021-ID_NOT_FOUND_1");
		expect(groups[0].warnings.some((w) => w.includes("ID_NOT_FOUND_1"))).toBe(true);
	});

	// Yet another ksk-watson naming choice for the same shape: real facts under
	// a top-level document_groups[] array instead of documents[]/transactions[].
	// The matcher must not need to know this specific key name in advance.
	test("facts living in an arbitrarily-named top-level array (document_groups[]) still resolve", () => {
		const namedArrayBatch = file(
			"seg-013",
			{
				segment_id: "seg-013",
				documents: [
					{ source_file: "batch.pdf", source_page: 1, doc_kind: "normal_bill_or_invoice", document_group: "A" } as never,
				],
				document_groups: [
					{
						group_id: "A",
						pages: [1],
						doc_kind: "normal_bill_or_invoice",
						accounting_facts: { direction: "expense", document_no: "04050056", gross_total: 32336.07, vat: 1361.07 },
						line_items: [{ description: "Rent", amount: 11531.25, vat_rate: 0 }],
					} as never,
				],
			},
			"interpretation-p1-15.json",
		);
		const cluster: LinkCluster = {
			transaction_id: "txn-071",
			segments: ["seg-013"],
			members: [{ segment: "seg-013", document_no: "04050056", role: "primary_invoice" }],
			bookable_docs: ["04050056"],
		};
		const { groups } = planGroups([cluster], new Map([["seg-013", [namedArrayBatch]]]), NO_SOURCES);
		expect(groups).toHaveLength(1);
		expect(groups[0].primary_interpretation).toBe(namedArrayBatch.path);
		expect(groups[0].category).toBe("expense");
		// single line item is vat_rate: 0 — resolution worked, classification follows the line
		expect(groups[0].vat_treatment).toBe("non_vat");
		expect(groups[0].populate).toBe("agent");
	});
});

// --- completeness invariant (T07): a bookable Stage-2 document must never
// silently disappear between interpsBySegment (the full Stage-2 truth) and
// the finished group plan (what links.yaml/clustering actually produced).
// "sherlock link-drop" class of bug.
describe("findDroppedBookableUnits / planGroups completeness invariant", () => {
	// a Shape-B bundle entry: nested accounting_facts, real sourceEntry (so the
	// isExcludedFromMatch path is exercised, not the Shape-A file-level fallback)
	function bundleDoc(
		documentNo: string,
		overrides: Record<string, unknown> = {},
	): Record<string, unknown> {
		return {
			source_file: "batch.pdf",
			source_page: 1,
			doc_kind: "normal_bill_or_invoice",
			evidence_role: "primary_accounting_doc",
			usable_for_booking: true,
			accounting_facts: { direction: "expense", document_no: documentNo, gross_total: 100, vat: 0 },
			line_items: [],
			...overrides,
		};
	}

	test("DROP (red -> green): two approved bookable docs in one segment, only one lands in the cluster's bookable_docs — planGroups throws naming the exact pair", () => {
		const bundle = file("seg-030", {
			segment_id: "seg-030",
			documents: [
				bundleDoc("A100", { source_page: 1 }),
				bundleDoc("A200", { source_page: 2, accounting_facts: { direction: "expense", document_no: "A200", gross_total: 200, vat: 0 } }),
			],
		});
		const cluster: LinkCluster = {
			transaction_id: "txn-100",
			segments: ["seg-030"],
			members: [{ segment: "seg-030", document_no: "A100", role: "primary_document" }],
			bookable_docs: ["A100"], // A200 lost by the linker — the true regression
		};
		const interps = new Map([["seg-030", [bundle]]]);
		expect(() => planGroups([cluster], interps, NO_SOURCES)).toThrow(/seg-030 \/ A200/);

		// findDroppedBookableUnits in isolation, against the group set group-skeleton
		// would have written pre-fix (no group ever created for A200)
		const groups: GroupPlan[] = [
			{
				id: "001-A100",
				path: "expense/non_vat/001-A100",
				label: "A100 (seg-030)",
				category: "expense",
				vat_treatment: "non_vat",
				segments: ["seg-030"],
				bookable_doc: "A100",
				transaction_id: "txn-100",
				confidence: "high",
				populate: "script",
				primary_interpretation: bundle.path,
				evidence_interpretations: [],
				source_ref: null,
				warnings: [],
			},
		];
		expect(findDroppedBookableUnits(interps, groups)).toEqual(["seg-030 / A200"]);
	});

	test("BUG-2 lock (always-green): two different segments each with a doc numbered \"46\" stay two distinct groups — no false drop from bare document_no matching", () => {
		const docA = file(
			"seg-001",
			invoiceInterp({ accounting_facts: { direction: "expense", document_no: "46", vat: 0 }, line_items: [] }),
		);
		const docB = file(
			"seg-007",
			invoiceInterp({ accounting_facts: { direction: "expense", document_no: "46", vat: 0 }, line_items: [] }),
		);
		const interps = new Map([
			["seg-001", [docA]],
			["seg-007", [docB]],
		]);
		const { groups } = planGroups(null, interps, NO_SOURCES);
		expect(groups).toHaveLength(2);
		expect(groups.every((g) => g.bookable_doc === "46")).toBe(true);
		// segment-prefixed ids/paths keep the two "46" groups distinct
		expect(new Set(groups.map((g) => g.id)).size).toBe(2);
		expect(new Set(groups.map((g) => g.path)).size).toBe(2);
		expect(findDroppedBookableUnits(interps, groups)).toEqual([]);
	});

	test("no false positive: one booked doc plus a legitimately excluded (usable_for_booking:false) entry in the same segment", () => {
		const bundle = file("seg-031", {
			segment_id: "seg-031",
			documents: [
				bundleDoc("B900"),
				bundleDoc("C901", {
					source_page: 2,
					evidence_role: "supporting_evidence",
					usable_for_booking: false,
					accounting_facts: { direction: "expense", document_no: "C901", gross_total: 500, vat: 0 },
				}),
			],
		});
		const cluster: LinkCluster = {
			transaction_id: "txn-101",
			segments: ["seg-031"],
			members: [{ segment: "seg-031", document_no: "B900", role: "primary_document" }],
			bookable_docs: ["B900"],
		};
		const interps = new Map([["seg-031", [bundle]]]);
		let result: ReturnType<typeof planGroups> | null = null;
		expect(() => {
			result = planGroups([cluster], interps, NO_SOURCES);
		}).not.toThrow();
		expect(findDroppedBookableUnits(interps, result!.groups)).toEqual([]);
	});

	test("no false positive: one document split across two ≤15-page dispatch windows (same document_no, same gross) is one booking, not a drop", () => {
		// The invariant must NOT reuse findPrimary's cross-file collapse (that erases
		// the "46"/"46" regression), so a window-straddling document surfaces twice —
		// distinguished from a real collision by having the SAME gross (one document),
		// which the distinct-gross count folds back to a single unit.
		const win1 = file("seg-050", { segment_id: "seg-050", documents: [bundleDoc("INV-777", { source_page: 15 })] }, "interpretation-p1-15.json");
		const win2 = file("seg-050", { segment_id: "seg-050", documents: [bundleDoc("INV-777", { source_page: 16 })] }, "interpretation-p16-30.json");
		const cluster: LinkCluster = {
			transaction_id: "txn-102",
			segments: ["seg-050"],
			members: [{ segment: "seg-050", document_no: "INV-777", role: "primary_document" }],
			bookable_docs: ["INV-777"],
		};
		const interps = new Map([["seg-050", [win1, win2]]]);
		let result: ReturnType<typeof planGroups> | null = null;
		expect(() => {
			result = planGroups([cluster], interps, NO_SOURCES);
		}).not.toThrow();
		expect(findDroppedBookableUnits(interps, result!.groups)).toEqual([]);
	});

	test("no false positive: a statement-shaped file carrying its own reference document_no is not a bookable drop", () => {
		// planGroups routes statements to statementDraft (bookable_doc: null), so they
		// never enter `booked`; the invariant must likewise skip isStatementShaped files
		// or a statement/reference number would throw on a clean run.
		const stmt = file("seg-060", {
			...statementInterp(),
			segment_id: "seg-060",
			accounting_facts: { direction: "expense", document_no: "STM-2026-05" },
		} as never);
		const interps = new Map([["seg-060", [stmt]]]);
		let result: ReturnType<typeof planGroups> | null = null;
		expect(() => {
			result = planGroups(null, interps, NO_SOURCES);
		}).not.toThrow();
		expect(findDroppedBookableUnits(interps, result!.groups)).toEqual([]);
	});

	// Mirrors run full-345/20260713-1819b, group 171-TF690410110024: a supplier
	// document with no printed invoice number where the Stage-2 reader
	// substituted an internal payment-voucher number as a placeholder (flagging
	// the deviation with a document_no_not_found warning, per
	// references/schemas/segment-interpretation.md) — sherlock later merged it
	// as evidence into a DIFFERENT document's booking. The placeholder number
	// must never count as its own approved bookable unit.
	test("no false positive: a placeholder document_no (document_no_not_found warning) is never its own bookable unit", () => {
		const bundle = file("seg-033", {
			segment_id: "seg-033",
			documents: [
				bundleDoc("E800"),
				bundleDoc("PV-INTERNAL-01", {
					source_page: 2,
					warnings: [
						"document_no_not_found: no printed invoice number found; used the internal payment voucher number as a placeholder identifier instead.",
					],
					accounting_facts: { direction: "expense", document_no: "PV-INTERNAL-01", gross_total: 500, vat: 0 },
				}),
			],
		});
		const cluster: LinkCluster = {
			transaction_id: "txn-103",
			segments: ["seg-033"],
			members: [{ segment: "seg-033", document_no: "E800", role: "primary_document" }],
			bookable_docs: ["E800"],
		};
		const interps = new Map([["seg-033", [bundle]]]);
		let result: ReturnType<typeof planGroups> | null = null;
		expect(() => {
			result = planGroups([cluster], interps, NO_SOURCES);
		}).not.toThrow();
		expect(findDroppedBookableUnits(interps, result!.groups)).toEqual([]);
	});

	test("no false positive: duplicate-copy page (evidence_role includes duplicate) never counts as its own bookable unit", () => {
		const bundle = file("seg-032", {
			segment_id: "seg-032",
			documents: [
				bundleDoc("D700"),
				bundleDoc("D700", {
					source_page: 2,
					evidence_role: "duplicate_copy",
					usable_for_booking: false,
				}),
			],
		});
		const cluster: LinkCluster = {
			transaction_id: "txn-102",
			segments: ["seg-032"],
			members: [{ segment: "seg-032", document_no: "D700", role: "primary_document" }],
			bookable_docs: ["D700"],
		};
		const interps = new Map([["seg-032", [bundle]]]);
		const { groups } = planGroups([cluster], interps, NO_SOURCES);
		expect(findDroppedBookableUnits(interps, groups)).toEqual([]);
	});

	// Mirrors the real run #1b regression (group 110-46, client _345): the SAME
	// document_no appears in two DIFFERENT dispatch sub-files of one segment as
	// two genuinely different physical documents (different seller, different
	// amount) — not the same document split across an adjacent window boundary.
	// findPrimary's cross-file collapseByDocumentNo (correctly, for the split-
	// document case) merges them into one match when resolving the cluster's
	// single "46" bookable_docs entry — group-skeleton then writes only ONE
	// group. findDroppedBookableUnits must not use that same cross-file collapse
	// for its own "how many approved bookable units exist" count, or this
	// regression is invisible to it.
	test("same-segment document_no collision across two dispatch sub-files (real regression): the merged-away document must be flagged", () => {
		const windowA = file(
			"seg-006",
			{
				segment_id: "seg-006",
				documents: [
					bundleDoc("46", {
						doc_kind: "handwritten_bill",
						accounting_facts: {
							direction: "expense",
							document_date: null,
							document_no: "46",
							seller_name: "ร้านยนต์ทวี",
							gross_total: 1400,
							vat: 0,
						},
					}),
				],
			},
			"interpretation-p16-30.json",
		);
		const windowB = file(
			"seg-006",
			{
				segment_id: "seg-006",
				documents: [
					bundleDoc("46", {
						doc_kind: "handwritten_bill",
						accounting_facts: {
							direction: "expense",
							document_date: "2026-04-07",
							document_no: "46",
							seller_name: "หจก.หงส์ทิพย์",
							gross_total: 45,
							vat: 0,
						},
					}),
				],
			},
			"interpretation-p46-55.json",
		);
		const cluster: LinkCluster = {
			transaction_id: "txn-107",
			segments: ["seg-006"],
			members: [{ segment: "seg-006", document_no: "46", role: "primary_document" }],
			bookable_docs: ["46"],
		};
		const interps = new Map([["seg-006", [windowA, windowB]]]);
		expect(() => planGroups([cluster], interps, NO_SOURCES)).toThrow(/seg-006 \/ 46/);
	});

	// The actual failure mode found in run 20260713-1819b restart, group
	// 182-46 (client _345): TWO separate transactions/clusters each legitimately
	// claim document_no "46" from the same segment (because the segment really
	// does contain two different physical "46" documents). Each cluster's own
	// documentDraft call independently resolves findPrimary against the SAME
	// segment file set, so — pre-fix — both wrongly collapsed to the identical
	// "best by richness" file as primary; the completeness invariant then missed
	// it because booked count (2) happened to equal distinct-gross count (2),
	// even though both groups had the WRONG primary. The fix must make each
	// call return an ambiguous match instead: primary_interpretation: null,
	// populate: agent, and evidence_interpretations naming BOTH candidate files
	// (never one candidate silently as primary, the other silently as evidence
	// only) — this manifest self-inconsistency (evidence lists the file that
	// isn't primary, primary is a file evidence doesn't list) is exactly what
	// group-skeleton must no longer be able to produce.
	test("two DIFFERENT clusters both legitimately claim the same colliding document_no in one segment — neither group may silently pick the wrong file as primary", () => {
		const windowA = file(
			"seg-006",
			{
				segment_id: "seg-006",
				documents: [
					bundleDoc("46", {
						doc_kind: "handwritten_bill",
						accounting_facts: {
							direction: "expense",
							document_no: "46",
							seller_name: "ร้านยนต์ทวี",
							gross_total: 1400,
							vat: 0,
						},
					}),
				],
			},
			"interpretation-p16-30.json",
		);
		const windowB = file(
			"seg-006",
			{
				segment_id: "seg-006",
				documents: [
					bundleDoc("46", {
						doc_kind: "handwritten_bill",
						accounting_facts: {
							direction: "expense",
							document_no: "46",
							seller_name: "หจก.หงส์ทิพย์",
							gross_total: 45,
							vat: 0,
						},
					}),
				],
			},
			"interpretation-p46-55.json",
		);
		const clusterA: LinkCluster = {
			transaction_id: "txn-110",
			segments: ["seg-006"],
			members: [{ segment: "seg-006", document_no: "46", role: "primary_document" }],
			bookable_docs: ["46"],
		};
		const clusterB: LinkCluster = {
			transaction_id: "txn-174",
			segments: ["seg-006"],
			members: [{ segment: "seg-006", document_no: "46", role: "primary_document" }],
			bookable_docs: ["46"],
		};
		const interps = new Map([["seg-006", [windowA, windowB]]]);
		const { groups } = planGroups([clusterA, clusterB], interps, NO_SOURCES);
		expect(groups).toHaveLength(2);
		for (const group of groups) {
			// never a wrong-file (or any) silent pick — ambiguity must surface, not resolve
			expect(group.primary_interpretation).toBeNull();
			expect(group.populate).toBe("agent");
			// both candidate files must be offered as evidence — never one as primary
			// while the other is silently dropped, and never the collision hidden
			expect(new Set(group.evidence_interpretations)).toEqual(
				new Set([windowA.path, windowB.path]),
			);
			expect(group.warnings.join(" ")).toMatch(/conflicting facts/);
		}
	});

	// Same collision, but within ONE file's documents[] array (two entries that
	// happen to share document_no "46" without being the same physical page
	// repeated) — collapseByDocumentNo's per-file pass must apply the same
	// conflict check, not just the cross-file pass in findPrimary.
	test("same-file document_no collision (two documents[] entries, same number, conflicting facts) — collapsed record must not silently merge them", () => {
		const bundle = file("seg-070", {
			segment_id: "seg-070",
			documents: [
				bundleDoc("46", {
					source_page: 1,
					accounting_facts: {
						direction: "expense",
						document_no: "46",
						seller_name: "ร้านยนต์ทวี",
						gross_total: 1400,
						vat: 0,
					},
				}),
				bundleDoc("46", {
					source_page: 2,
					accounting_facts: {
						direction: "expense",
						document_no: "46",
						seller_name: "หจก.หงส์ทิพย์",
						gross_total: 45,
						vat: 0,
					},
				}),
			],
		});
		const cluster: LinkCluster = {
			transaction_id: "txn-201",
			segments: ["seg-070"],
			members: [{ segment: "seg-070", document_no: "46", role: "primary_document" }],
			bookable_docs: ["46"],
		};
		const interps = new Map([["seg-070", [bundle]]]);
		expect(() => planGroups([cluster], interps, NO_SOURCES)).toThrow(/seg-070 \/ 46/);
	});
});

// --- non-canonical shape detection --------------------------------------------

// The tolerant reader normalizes the _216 shape variants silently;
// shapeIssuesOf is what keeps them visible — planGroups/prelink turn each
// issue into a warning telling the parent to re-dispatch the writing child.
describe("shapeIssuesOf", () => {
	test("canonical shapes raise no issues", () => {
		expect(shapeIssuesOf(file("seg-001", invoiceInterp()))).toEqual([]);
		expect(shapeIssuesOf(file("seg-009", statementInterp()))).toEqual([]);
		// canonical bundle: nested per-document accounting_facts in documents[]
		const bundle = file("seg-012", {
			segment_id: "seg-012",
			documents: [
				{ source_file: "batch.pdf", source_page: 1, accounting_facts: { direction: "expense", document_no: "A-1" } } as never,
				{ source_file: "batch.pdf", source_page: 2, accounting_facts: { direction: "expense", document_no: "A-2" } } as never,
			],
		});
		expect(shapeIssuesOf(bundle)).toEqual([]);
	});

	test("flat per-document fields are flagged", () => {
		const flat = file("seg-012", {
			segment_id: "seg-012",
			documents: [
				{ source_file: "batch.pdf", document_no: "RE-A", gross_total: 900 } as never,
				{ source_file: "batch.pdf", document_no: "RE-B", gross_total: 500 } as never,
			],
			accounting_facts: { direction: "expense" },
		});
		expect(shapeIssuesOf(flat).join("\n")).toContain("flat document fields");
	});

	test("documents bundled under transactions[]/document_groups[] are flagged", () => {
		const txnBlock = file("seg-013", {
			segment_id: "seg-013",
			transactions: [
				{ accounting_facts: { direction: "expense", document_no: "CO-999" } } as never,
			],
		});
		expect(shapeIssuesOf(txnBlock).join("\n")).toContain('top-level "transactions"');
		const namedArray = file("seg-013", {
			segment_id: "seg-013",
			document_groups: [
				{ accounting_facts: { direction: "expense", document_no: "04050056" } },
			],
		} as never);
		expect(shapeIssuesOf(namedArray).join("\n")).toContain('top-level "document_groups"');
	});

	test("repeated document_no across entries is flagged", () => {
		const repeated = file("seg-012", {
			segment_id: "seg-012",
			documents: [
				{ source_file: "batch.pdf", source_page: 31, document_no: "RE-C" } as never,
				{ source_file: "batch.pdf", source_page: 32, document_no: "RE-C" } as never,
			],
			accounting_facts: { direction: "expense" },
		});
		expect(shapeIssuesOf(repeated).join("\n")).toContain('repeat document_no "RE-C"');
	});

	test("planGroups surfaces shape issues as run warnings", () => {
		const flat = file(
			"seg-012",
			{
				segment_id: "seg-012",
				documents: [
					{ source_file: "batch.pdf", document_no: "RE-A", gross_total: 900 } as never,
				],
				accounting_facts: { direction: "expense" },
			},
			"interpretation-p31-48.json",
		);
		const { warnings } = planGroups(null, new Map([["seg-012", [flat]]]), NO_SOURCES);
		expect(
			warnings.some(
				(w) => w.includes("non-canonical interpretation shape") && w.includes(flat.path),
			),
		).toBe(true);
	});
});

// --- populate ----------------------------------------------------------------

describe("group interpretation build", () => {
	const plan: GroupPlan = {
		id: "001-INV-001",
		path: "expense/vat/001-INV-001",
		label: "INV-001 (seg-001)",
		category: "expense",
		vat_treatment: "vat",
		segments: ["seg-001", "seg-018"],
		bookable_doc: "INV-001",
		transaction_id: "txn-001",
		confidence: "high",
		populate: "script",
		primary_interpretation: "ข้อมูลระบบ/_segments/seg-001/interpretation.json",
		evidence_interpretations: ["ข้อมูลระบบ/_segments/seg-018/interpretation.json"],
		source_ref: "บิลซื้อ.pdf p.5-6",
		warnings: [],
	};

	test("copies facts + lines from primary, evidence docs carry lines_owner: false and their used pages", () => {
		const receipt = invoiceInterp({
			documents: [{ source_file: "slip.jpg", source_page: null, doc_kind: "payment_slip" }],
			page_disposition: [],
		});
		const group = buildDocumentGroupInterpretation(plan, invoiceInterp(), [receipt], "shared receipt");
		expect(group.facts.document_no).toBe("INV-001");
		expect(group.line_items).toHaveLength(1);
		expect(group.transaction).toEqual({ transaction_id: "txn-001", evidence: "shared receipt" });
		expect(group.documents).toHaveLength(2);
		expect(group.documents[0].lines_owner).toBe(true);
		expect(group.documents[0].source_pages).toEqual([5, 6]); // from page_disposition used
		expect(group.documents[1].lines_owner).toBe(false);
	});

	test("statement group copies statement fields and derives source from the segment manifest", () => {
		const statementPlan: GroupPlan = {
			...plan,
			id: "002-seg-009",
			path: "bank_statement/002-seg-009",
			category: "bank_statement",
			vat_treatment: null,
			segments: ["seg-009"],
			bookable_doc: null,
			transaction_id: null,
			evidence_interpretations: [],
		};
		const group = buildStatementGroupInterpretation(statementPlan, statementInterp(), {
			file: "STM.pdf",
			pages: [1, 3],
			sheets: null,
		});
		expect(group.statement?.bank).toBe("Kasikornbank");
		expect(group.statement?.period).toBe("01/05/2026 - 31/05/2026");
		expect(group.source).toEqual({
			source_src: "STM.pdf",
			source_page: 1,
			source_pages: [1, 2, 3],
			source_sheet: null,
			image_src: null,
		});
		expect(group.transactions).toHaveLength(1);
	});
});

// --- review-data build ---------------------------------------------------------

describe("review-data build", () => {
	const plan: GroupPlan = {
		id: "001-INV-001",
		path: "expense/vat/001-INV-001",
		label: "INV-001 (seg-001)",
		category: "expense",
		vat_treatment: "vat",
		segments: ["seg-001"],
		bookable_doc: "INV-001",
		transaction_id: null,
		confidence: "high",
		populate: "script",
		primary_interpretation: "ข้อมูลระบบ/_segments/seg-001/interpretation.json",
		evidence_interpretations: [],
		source_ref: null,
		warnings: [],
	};

	test("merges categorize by line_index, fills buyer from CLIENT.md, claims full span", () => {
		const group = buildDocumentGroupInterpretation(plan, invoiceInterp(), [], null);
		const data = buildDocumentReviewData(
			group,
			{
				group_id: "001-INV-001",
				lines: [
					{
						line_index: 0,
						account_code: "510111",
						sub_code: "",
						account_name_th: "ซื้อสินค้า",
						confidence: "high",
						reason: "matched keyword",
						needs_review: false,
					},
				],
			},
			{ name: "บจก. ลูกค้า", tax_id: "0123456789012" },
			"ข้อมูลระบบ/_doc_groups/expense/vat/001-INV-001",
		) as any;
		expect(data.schema).toBe("ksk_review_group_data.v1");
		expect(data.pages).toHaveLength(1);
		const page = data.pages[0];
		expect(page.source_src).toBe("บิลซื้อ.pdf");
		expect(page.source_page).toBe(5);
		expect(page.source_pages).toEqual([5, 6]);
		expect(page.facts.buyer).toBe("บจก. ลูกค้า");
		expect(page.facts.buyer_tax_id).toBe("0123456789012");
		expect(page.facts.subtotal).toBe(1000);
		expect(page.facts.total).toBe(1070);
		expect(page.facts.vat_treatment).toBe("vat_7");
		expect(page.lines[0].account_code).toBe("510111");
		expect(page.lines[0].vat_treatment).toBeNull(); // not a mixed group
		expect(page.initial_status).toBe("reviewed");
	});

	test("missing categorize line flags needs_review; evidence file gets its own lineless page", () => {
		const receipt = invoiceInterp({
			documents: [{ source_file: "slip.jpg", source_page: null, doc_kind: "payment_slip" }],
			page_disposition: [],
		});
		const group = buildDocumentGroupInterpretation(plan, invoiceInterp(), [receipt], null);
		const data = buildDocumentReviewData(group, { lines: [] }, null, "g") as any;
		expect(data.pages).toHaveLength(2);
		const [primary, evidence] = data.pages;
		expect(primary.lines[0].needs_review).toBe(true);
		expect(primary.lines[0].confidence).toBe("low");
		expect(primary.initial_status).toBe("needs_attention");
		expect(evidence.source_src).toBe("slip.jpg");
		expect(evidence.lines).toEqual([]);
	});

	// The loan-draw flag's needs-review path: script populate appends
	// LOAN_DRAW_WARNING to review_flags, and review_flags is what flips every
	// page of the group to initial_status: needs_attention.
	test("income loan-draw group carries LOAN_DRAW_WARNING in review_flags and lands needs_attention despite clean categorize lines", () => {
		const incomePlan: GroupPlan = {
			...plan,
			path: "income/non_vat/001-INV-001",
			category: "income",
			vat_treatment: "non_vat",
		};
		const loanDraw = invoiceInterp({
			accounting_facts: {
				direction: "income",
				document_no: "INV-001",
				gross_total: 50000,
				description: "เงินกู้ยืม OD — short-term loan received from individual",
			},
			line_items: [{ description: "เงินกู้ยืม OD", amount: 50000, vat_treatment: "non_vat" }],
		});
		const group = buildDocumentGroupInterpretation(incomePlan, loanDraw, [], null);
		expect(group.category).toBe("income"); // placement untouched
		expect(group.review_flags).toContain(LOAN_DRAW_WARNING);
		const cleanLine = {
			line_index: 0,
			account_code: "410000",
			sub_code: "",
			account_name_th: "รายได้",
			confidence: "high",
			reason: "",
			needs_review: false,
		};
		const data = buildDocumentReviewData(group, { lines: [cleanLine] }, null, "g") as any;
		expect(data.pages[0].initial_status).toBe("needs_attention");
	});

	test("ordinary income group gets no loan-draw flag and stays reviewed with clean lines", () => {
		const incomePlan: GroupPlan = {
			...plan,
			path: "income/vat/001-INV-001",
			category: "income",
			vat_treatment: "vat",
		};
		const ordinary = invoiceInterp({
			accounting_facts: {
				direction: "income",
				document_no: "INV-001",
				gross_total: 1070,
				vat: 70,
				description: "ค่าบริการออกแบบ",
			},
		});
		const group = buildDocumentGroupInterpretation(incomePlan, ordinary, [], null);
		expect(group.review_flags).not.toContain(LOAN_DRAW_WARNING);
		const cleanLine = {
			line_index: 0,
			account_code: "410000",
			sub_code: "",
			account_name_th: "รายได้",
			confidence: "high",
			reason: "",
			needs_review: false,
		};
		const data = buildDocumentReviewData(group, { lines: [cleanLine] }, null, "g") as any;
		expect(data.pages[0].initial_status).toBe("reviewed");
	});

	// Fix 5 regression: the interpretation-time check (buildDocumentGroupInterpretation)
	// only consults primary.documents, so a loan-role EVIDENCE doc writes no flag
	// text. buildDocumentReviewData must consult the SAME set (lines_owner/primary
	// docs) so it can't flip needs_attention with no matching flag to explain why.
	// Direction chosen: filter review-data to lines_owner docs (documented in report).
	test("ordinary income group with a loan-role EVIDENCE doc does NOT flip needs_attention (both sites consult primary docs only)", () => {
		const incomePlan: GroupPlan = {
			...plan,
			path: "income/vat/001-INV-001",
			category: "income",
			vat_treatment: "vat",
		};
		const ordinaryPrimary = invoiceInterp({
			accounting_facts: {
				direction: "income",
				document_no: "INV-001",
				gross_total: 1070,
				vat: 70,
				description: "ค่าบริการออกแบบ",
			},
		});
		// evidence interp whose document names a loan role — joins group.documents
		// with lines_owner: false
		const loanEvidence = invoiceInterp({
			documents: [
				{
					source_file: "slip.jpg",
					source_page: null,
					doc_kind: "payment_slip",
					document_role: "loan_receipt",
				},
			],
			page_disposition: [],
		});
		const group = buildDocumentGroupInterpretation(incomePlan, ordinaryPrimary, [loanEvidence], null);
		// interpretation-time: no flag written (only primary consulted)
		expect(group.review_flags).not.toContain(LOAN_DRAW_WARNING);
		// review-data: must agree — no needs_attention, and no phantom flag text
		const cleanLine = {
			line_index: 0,
			account_code: "410000",
			sub_code: "",
			account_name_th: "รายได้",
			confidence: "high",
			reason: "",
			needs_review: false,
		};
		const data = buildDocumentReviewData(group, { lines: [cleanLine] }, null, "g") as any;
		expect(data.review_flags).not.toContain(LOAN_DRAW_WARNING);
		expect(data.pages[0].initial_status).toBe("reviewed");
		expect(data.pages[1].initial_status).toBe("reviewed"); // the evidence page too
	});

	// Fix 8: the group interpretation's review_flags (and the deterministic
	// loan-draw net) are surfaced at the top level of review-data so a
	// needs_attention group tells the reviewer WHY.
	test("review-data carries a group-level review_flags including LOAN_DRAW_WARNING", () => {
		const incomePlan: GroupPlan = {
			...plan,
			path: "income/non_vat/001-INV-001",
			category: "income",
			vat_treatment: "non_vat",
		};
		const loanDraw = invoiceInterp({
			accounting_facts: {
				direction: "income",
				document_no: "INV-001",
				gross_total: 50000,
				description: "เงินกู้ยืม OD — short-term loan received from individual",
			},
			line_items: [{ description: "เงินกู้ยืม OD", amount: 50000, vat_treatment: "non_vat" }],
		});
		const group = buildDocumentGroupInterpretation(incomePlan, loanDraw, [], null);
		const cleanLine = {
			line_index: 0,
			account_code: "410000",
			sub_code: "",
			account_name_th: "รายได้",
			confidence: "high",
			reason: "",
			needs_review: false,
		};
		const data = buildDocumentReviewData(group, { lines: [cleanLine] }, null, "g") as any;
		expect(Array.isArray(data.review_flags)).toBe(true);
		expect(data.review_flags).toContain(LOAN_DRAW_WARNING);
	});

	// Fix 8 net: an agent-populated income loan-draw group whose interpretation
	// dropped the flag from review_flags still gets it surfaced at review-data time.
	test("review-data adds the loan-draw net flag when the interpretation omitted it", () => {
		const incomePlan: GroupPlan = {
			...plan,
			path: "income/non_vat/001-INV-001",
			category: "income",
			vat_treatment: "non_vat",
		};
		// simulate an agent-written group interpretation: loan wording in facts,
		// but review_flags empty (the flag was not carried over)
		const group: any = {
			schema: "ksk_group_interpretation.v1",
			group_id: "001-INV-001",
			category: "income",
			vat_treatment: "non_vat",
			bookable_doc: "INV-001",
			segments: ["seg-001"],
			transaction: null,
			facts: {
				direction: "income",
				document_no: "INV-001",
				gross_total: 50000,
				description: "เงินกู้ยืม OD",
			},
			documents: [
				{ source_file: "slip.jpg", source_page: 1, doc_kind: "payment_slip", lines_owner: true },
			],
			line_items: [{ description: "เงินกู้ยืม OD", amount: 50000 }],
			review_flags: [],
			questions_for_user: [],
		};
		const data = buildDocumentReviewData(group, { lines: [] }, null, "g") as any;
		expect(data.review_flags).toContain(LOAN_DRAW_WARNING);
		expect(data.pages[0].initial_status).toBe("needs_attention");
	});

	// Fix 7: currency + original_* fields are surfaced in page facts.
	test("review-data page facts surface currency and original_* fields (FX visibility)", () => {
		const fxInterp = invoiceInterp({
			accounting_facts: {
				direction: "expense",
				document_no: "INV-FX",
				gross_total: 3500,
				vat: 0,
				currency: "USD",
				original_currency: "USD",
				original_amount: 100,
				exchange_rate: 35,
				description: "imported service",
			},
		});
		const group = buildDocumentGroupInterpretation(plan, fxInterp, [], null);
		const data = buildDocumentReviewData(group, { lines: [] }, null, "g") as any;
		expect(data.pages[0].facts.currency).toBe("USD");
		expect(data.pages[0].facts.original_currency).toBe("USD");
		expect(data.pages[0].facts.original_amount).toBe(100);
		expect(data.pages[0].facts.exchange_rate).toBe(35);
	});

	test("expense loan-repayment group is untouched by the loan-draw rule", () => {
		const repayment = invoiceInterp({
			accounting_facts: {
				direction: "expense",
				document_no: "INV-001",
				gross_total: 5000,
				description: "ชำระดอกเบี้ยเงินกู้ยืม OD — loan repayment",
			},
			line_items: [{ description: "ดอกเบี้ยเงินกู้", amount: 5000, vat_treatment: "non_vat" }],
		});
		const group = buildDocumentGroupInterpretation(plan, repayment, [], null);
		expect(group.review_flags).not.toContain(LOAN_DRAW_WARNING);
	});

	// agent-populated groups (ksk-marple writes interpretation.json directly,
	// bypassing buildDocumentGroupInterpretation) — buildDocumentReviewData's own
	// check is the net that still forces needs_attention
	test("agent-written income loan-draw group without the flag in review_flags still lands needs_attention", () => {
		const group = {
			schema: "ksk_group_interpretation.v1" as const,
			group_id: "624-RE2026050011",
			category: "income" as const,
			vat_treatment: "non_vat" as const,
			bookable_doc: "RE2026050011",
			segments: ["seg-356"],
			transaction: null,
			facts: {
				direction: "income",
				document_no: "RE2026050011",
				gross_total: 10000,
				description: "เงินกู้ยืมระยะสั้น (OD) — short-term loan received from individual",
			},
			documents: [
				{ source_file: "Receipt KKC.pdf", source_page: 12, source_pages: [12], lines_owner: true },
			],
			line_items: [{ description: "เงินกู้ยืมระยะสั้น (OD)", amount: 10000 }],
			review_flags: [],
			questions_for_user: [],
		};
		const cleanLine = {
			line_index: 0,
			account_code: "410000",
			sub_code: "",
			account_name_th: "รายได้",
			confidence: "high",
			reason: "",
			needs_review: false,
		};
		const data = buildDocumentReviewData(group, { lines: [cleanLine] }, null, "g") as any;
		expect(data.pages[0].initial_status).toBe("needs_attention");
	});

	test("facts.wht passes through from the document, null when the document shows none", () => {
		const withWht = invoiceInterp();
		// 3% withheld on the 1000 base: paid = 1070 − 30
		withWht.accounting_facts = { ...withWht.accounting_facts, wht: 30, net_paid: 1040 };
		const group = buildDocumentGroupInterpretation(plan, withWht, [], null);
		const data = buildDocumentReviewData(group, { lines: [] }, null, "g") as any;
		expect(data.pages[0].facts.wht).toBe(30);
		expect(data.pages[0].facts.paid).toBe(1040);
		const noWht = buildDocumentGroupInterpretation(plan, invoiceInterp(), [], null);
		const data2 = buildDocumentReviewData(noWht, { lines: [] }, null, "g") as any;
		expect(data2.pages[0].facts.wht).toBeNull();
	});

	test("expense/mixed group sets per-line vat_treatment", () => {
		const mixed = invoiceInterp({
			line_items: [{ amount: 100, vat_rate: 7 }, { amount: 50, vat_rate: 0 }],
		});
		const mixedPlan = { ...plan, vat_treatment: "mixed" as const };
		const group = buildDocumentGroupInterpretation(mixedPlan, mixed, [], null);
		const data = buildDocumentReviewData(group, { lines: [] }, null, "g") as any;
		expect(data.pages[0].facts.vat_treatment).toBe("");
		expect(data.pages[0].lines.map((l: any) => l.vat_treatment)).toEqual(["vat_7", "non_vat"]);
	});

	test("statement review-data merges rows and takes bank_account_code from categorize", () => {
		const statementPlan: GroupPlan = {
			...plan,
			id: "002-seg-009",
			path: "bank_statement/002-seg-009",
			category: "bank_statement",
			vat_treatment: null,
		};
		const group = buildStatementGroupInterpretation(statementPlan, statementInterp(), {
			file: "STM.pdf",
			pages: [1, 2],
			sheets: null,
		});
		const data = buildStatementReviewData(group, {
			bank_account_code: "111301",
			bank_sub_code: "",
			lines: [
				{
					line_index: 0,
					account_code: "212101",
					sub_code: "",
					account_name_th: "เจ้าหนี้การค้า",
					confidence: "medium",
					reason: "recurring supplier",
					needs_review: true,
				},
			],
		}) as any;
		expect(data.schema).toBe("ksk_review_statement_data.v1");
		expect(data.statement.bank_account_code).toBe("111301");
		expect(data.source.source_pages).toEqual([1, 2]);
		expect(data.rows[0].account_code).toBe("212101");
		expect(data.rows[0].direction).toBe("out");
	});

	test("statement rows with a bad direction throw", () => {
		const bad = statementInterp();
		bad.transactions![0].direction = "sideways";
		const statementPlan: GroupPlan = {
			...plan,
			category: "bank_statement",
			vat_treatment: null,
		};
		const group = buildStatementGroupInterpretation(statementPlan, bad, null);
		expect(() => buildStatementReviewData(group, {})).toThrow(/direction/);
	});
});
