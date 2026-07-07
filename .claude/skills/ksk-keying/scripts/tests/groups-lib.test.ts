import { describe, expect, test } from "bun:test";
import {
	buildDocumentGroupInterpretation,
	buildDocumentReviewData,
	buildStatementGroupInterpretation,
	buildStatementReviewData,
	classifyVat,
	docCategory,
	planGroups,
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
