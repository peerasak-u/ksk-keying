import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildOriginalBankAccountKey,
	buildOriginalDocumentSnapshot,
	buildOriginalLines,
	buildOriginalPageFacts,
	buildOriginalStatementRows,
	lineVat,
	loadGroupCategorize,
	loadGroupInterpretation,
	type SourceAccountingFacts,
	type SourceCategorizeLine,
	type SourceLineItem,
} from "./group-source";

// --- lineVat -------------------------------------------------------------

describe("lineVat", () => {
	test("explicit vat_treatment wins", () => {
		expect(lineVat({ vat_treatment: "vat_7" })).toBe("vat");
		expect(lineVat({ vat_treatment: "non_vat" })).toBe("non_vat");
	});

	test("falls back to a numeric vat_rate", () => {
		expect(lineVat({ vat_rate: 7 })).toBe("vat");
		expect(lineVat({ vat_rate: 0 })).toBe("non_vat");
	});

	test("unknown when neither signal is present", () => {
		expect(lineVat({})).toBe("unknown");
	});
});

// --- buildOriginalPageFacts ------------------------------------------------

describe("buildOriginalPageFacts", () => {
	function facts(overrides: Partial<SourceAccountingFacts> = {}): SourceAccountingFacts {
		return {
			document_date: "2026-05-05",
			document_no: "RT-20260500001",
			reference: null,
			seller_name: "บริษัท ชามหวาน จำกัด",
			seller_tax_id: "0105564068776",
			buyer_name: "บริษัท เจริญโภคภัณฑ์อาหาร จำกัด",
			buyer_tax_id: "0107537000246",
			gross_total: 380.92,
			vat: 24.92,
			wht: 0,
			net_paid: 380.92,
			currency: "THB",
			description: "ขายอาหารและเครื่องดื่ม ชำระเงินสด",
			...overrides,
		};
	}

	test("derives subtotal from gross_total - vat, rounded to 2dp", () => {
		const result = buildOriginalPageFacts(facts(), "vat", null);
		expect(result.subtotal).toBe(356);
		expect(result.total).toBe(380.92);
		expect(result.vat).toBe(24.92);
	});

	test("vat_treatment: vat->vat_7, non_vat->non_vat, mixed->''", () => {
		expect(buildOriginalPageFacts(facts(), "vat", null).vat_treatment).toBe("vat_7");
		expect(buildOriginalPageFacts(facts(), "non_vat", null).vat_treatment).toBe("non_vat");
		expect(buildOriginalPageFacts(facts(), "mixed", null).vat_treatment).toBe("");
	});

	test("buyer/buyer_tax_id fall back to defaultBuyer only when the document's own facts are null", () => {
		const noBuyer = facts({ buyer_name: null, buyer_tax_id: null });
		const result = buildOriginalPageFacts(noBuyer, "vat", { name: "Default Co", tax_id: "999" });
		expect(result.buyer).toBe("Default Co");
		expect(result.buyer_tax_id).toBe("999");

		const withBuyer = buildOriginalPageFacts(facts(), "vat", { name: "Default Co", tax_id: "999" });
		expect(withBuyer.buyer).toBe("บริษัท เจริญโภคภัณฑ์อาหาร จำกัด");
	});

	test("subtotal falls back to gross_total unchanged when vat is null", () => {
		const result = buildOriginalPageFacts(facts({ vat: null }), "vat", null);
		expect(result.subtotal).toBe(380.92);
	});
});

// --- buildOriginalLines ----------------------------------------------------

describe("buildOriginalLines", () => {
	function item(overrides: Partial<SourceLineItem> = {}): SourceLineItem {
		return { description: "อาหารและเครื่องดื่ม", qty: 1, unit: null, unit_price: null, amount: 356, amount_includes_vat: false, ...overrides };
	}

	function catLine(overrides: Partial<SourceCategorizeLine> = {}): SourceCategorizeLine {
		return { line_index: 0, account_code: "410101", sub_code: "", account_name_th: "รายได้จากการขายสินค้า", confidence: "high", reason: "matched", needs_review: false, ...overrides };
	}

	test("merges an interpretation line with its categorize entry by line_index", () => {
		const result = buildOriginalLines([item()], [catLine()], false);
		expect(result).toEqual([
			{
				line_index: 0,
				description: "อาหารและเครื่องดื่ม",
				qty: 1,
				unit: null,
				unit_price: null,
				amount: 356,
				amount_includes_vat: false,
				vat_treatment: null,
				account_code: "410101",
				sub_code: "",
				account_name_th: "รายได้จากการขายสินค้า",
				confidence: "high",
				reason: "matched",
				needs_review: false,
			},
		]);
	});

	test("a line with no matching categorize entry gets needs_review:true and a placeholder reason", () => {
		const result = buildOriginalLines([item()], [], false);
		expect(result[0].account_code).toBe("");
		expect(result[0].confidence).toBe("low");
		expect(result[0].needs_review).toBe(true);
		expect(result[0].reason).toBe("no categorize entry for this line");
	});

	test("an invalid confidence value on disk falls back to low", () => {
		const result = buildOriginalLines([item()], [catLine({ confidence: "extremely-sure" })], false);
		expect(result[0].confidence).toBe("low");
	});

	test("perLineVat=true sets vat_treatment from lineVat(); perLineVat=false always leaves it null", () => {
		const vatItem = item({ vat_rate: 7 });
		const nonVatItem = item({ vat_rate: 0 });
		expect(buildOriginalLines([vatItem], [catLine()], true)[0].vat_treatment).toBe("vat_7");
		expect(buildOriginalLines([nonVatItem], [catLine()], true)[0].vat_treatment).toBe("non_vat");
		expect(buildOriginalLines([vatItem], [catLine()], false)[0].vat_treatment).toBeNull();
	});
});

// --- buildOriginalDocumentSnapshot ------------------------------------------

describe("buildOriginalDocumentSnapshot", () => {
	test("perLineVat is true only for expense+mixed", () => {
		const interp = {
			category: "expense" as const,
			vat_treatment: "mixed" as const,
			facts: { gross_total: 100, vat: 0 },
			line_items: [{ description: "x", amount: 100, vat_rate: 7 }],
		};
		const snapshot = buildOriginalDocumentSnapshot(interp, { lines: [] }, null);
		expect(snapshot.lines[0].vat_treatment).toBe("vat_7");
	});

	test("perLineVat is false for expense+vat (not mixed)", () => {
		const interp = {
			category: "expense" as const,
			vat_treatment: "vat" as const,
			facts: {},
			line_items: [{ description: "x", amount: 100, vat_rate: 7 }],
		};
		const snapshot = buildOriginalDocumentSnapshot(interp, { lines: [] }, null);
		expect(snapshot.lines[0].vat_treatment).toBeNull();
	});
});

// --- buildOriginalStatementRows ---------------------------------------------

describe("buildOriginalStatementRows", () => {
	test("row_index tracks array position; amount is always positive regardless of sign", () => {
		const rows = buildOriginalStatementRows(
			[
				{ date_iso: "2026-05-01", direction: "out", amount: -500, description: "โอนเงิน" },
				{ date_iso: "2026-05-02", direction: "in", amount: 200 },
			],
			[{ line_index: 0, account_code: "530301", sub_code: "", account_name_th: "ค่าไฟฟ้า", confidence: "high", reason: "x", needs_review: false }],
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ row_index: 0, amount: 500, account_code: "530301" });
		expect(rows[1]).toMatchObject({ row_index: 1, amount: 200, account_code: "", needs_review: true });
	});
});

// --- buildOriginalBankAccountKey ---------------------------------------------

describe("buildOriginalBankAccountKey", () => {
	test("null when categorize.json never assigned a bank account", () => {
		expect(buildOriginalBankAccountKey({})).toBeNull();
	});

	test("composite key when assigned", () => {
		expect(buildOriginalBankAccountKey({ bank_account_code: "111301", bank_sub_code: "" })).toBe("111301||");
	});
});

// --- thin I/O ---------------------------------------------------------------

describe("loadGroupInterpretation / loadGroupCategorize", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ksk-group-source-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("returns null when the file doesn't exist", async () => {
		expect(await loadGroupInterpretation(dir)).toBeNull();
		expect(await loadGroupCategorize(dir)).toBeNull();
	});

	test("returns null on malformed JSON rather than throwing", async () => {
		writeFileSync(join(dir, "interpretation.json"), "{not json", "utf8");
		expect(await loadGroupInterpretation(dir)).toBeNull();
	});

	test("reads a real file", async () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "categorize.json"), JSON.stringify({ group_id: "seg-001", lines: [] }), "utf8");
		expect(await loadGroupCategorize(dir)).toEqual({ group_id: "seg-001", lines: [] });
	});
});
