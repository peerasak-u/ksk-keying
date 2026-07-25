// Pure document-review helper tests — fixed fixture lines/pages/coaRows, no
// file I/O (same describe/test + fixture-builder style as
// review-edit.test.ts/xlsx-preview.test.ts). renderDocumentReviewPage itself
// gets a couple of smoke assertions only (key content appears in the
// rendered string for a representative fixture) — the real verification of
// the rendered page is a manual smoke test, not a unit-test job (per the
// ticket's own instruction).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoaRow } from "./coa";
import type { DocumentReviewGuard, DocumentReviewPage } from "./document-review";
import {
	bucketExportUrl,
	bucketLabel,
	computeLineSubtotals,
	factLabel,
	isNumericFactKey,
	pageEditUrl,
	peakDateHint,
	renderDocumentReviewPage,
} from "./document-review";
import type { DocumentBucket, ReviewLine, ReviewPage } from "./review-data";

// --- fixture builders --------------------------------------------------

function coaRows(): CoaRow[] {
	return [
		{ account_code: "520211", sub_code: "001", name_th: "ค่าที่ปรึกษา", name_en: "Consulting" },
		{ account_code: "530301", sub_code: "", name_th: "ค่าไฟฟ้า", name_en: "Electricity" },
		{ account_code: "111301", sub_code: "", name_th: "เงินสด", name_en: "Cash" },
	];
}

function line(overrides: Partial<ReviewLine> = {}): ReviewLine {
	return {
		line_index: 0,
		description: "Performance Marketing",
		qty: 1,
		unit: null,
		unit_price: 22500,
		amount: 22500,
		amount_includes_vat: false,
		vat_treatment: null,
		account_code: "520211",
		sub_code: "001",
		account_name_th: "ค่าที่ปรึกษา",
		confidence: "high",
		reason: "จับคู่กับผู้ขายรายนี้",
		needs_review: false,
		...overrides,
	};
}

function page(overrides: Partial<ReviewPage> = {}): ReviewPage {
	return {
		ref: "a.pdf/page-001",
		short_ref: "page-001",
		source_src: "a.pdf",
		source_page: 1,
		source_sheet: null,
		image_src: null,
		extract_path: "x",
		categorize_path: "y",
		facts: { date: "2026-04-07", seller: "บริษัท เอบีซี จำกัด", total: 24075, vat_treatment: "vat_7" },
		lines: [line()],
		initial_status: "reviewed",
		skipped: false,
		group_id: "seg-001",
		group_label: "บริษัท เอบีซี จำกัด — INV001",
		group_review_flags: [],
		page_index_in_group: 0,
		...overrides,
	};
}

function guard(overrides: Partial<DocumentReviewGuard> = {}): DocumentReviewGuard {
	return { disabled: false, message: null, ...overrides };
}

function reviewPageData(overrides: Partial<DocumentReviewPage> = {}): DocumentReviewPage {
	return {
		clientId: "client-a",
		monthId: "2026-04",
		companyName: "บริษัท เอบีซี จำกัด",
		bucket: "expense/vat" as DocumentBucket,
		coaRows: coaRows(),
		guard: guard(),
		pages: [page()],
		...overrides,
	};
}

// --- computeLineSubtotals ---------------------------------------------------

describe("computeLineSubtotals", () => {
	test("sums amounts for lines sharing the same account_code+sub_code", () => {
		const lines = [line({ line_index: 0, amount: 100 }), line({ line_index: 1, amount: 50 })];
		const result = computeLineSubtotals(lines, coaRows());
		expect(result).toEqual([{ key: "520211||001", label: "520211-001 ค่าที่ปรึกษา", total: 150 }]);
	});

	test("keeps distinct accounts as separate groups, in first-seen order", () => {
		const lines = [
			line({ line_index: 0, account_code: "530301", sub_code: "", account_name_th: "ค่าไฟฟ้า", amount: 200 }),
			line({ line_index: 1, account_code: "520211", sub_code: "001", amount: 100 }),
		];
		const result = computeLineSubtotals(lines, coaRows());
		expect(result.map((r) => r.key)).toEqual(["530301||", "520211||001"]);
		expect(result[0].total).toBe(200);
		expect(result[1].total).toBe(100);
	});

	test("treats a null amount as 0 rather than throwing or skipping the line", () => {
		const lines = [line({ line_index: 0, amount: null }), line({ line_index: 1, amount: 30 })];
		const result = computeLineSubtotals(lines, coaRows());
		expect(result).toEqual([{ key: "520211||001", label: "520211-001 ค่าที่ปรึกษา", total: 30 }]);
	});

	test("falls back to a coaLabel()-shaped label built from the line's own account_name_th when the code isn't in coaRows", () => {
		const lines = [line({ line_index: 0, account_code: "999999", sub_code: "", account_name_th: "บัญชีที่ไม่รู้จัก", amount: 10 })];
		const result = computeLineSubtotals(lines, coaRows());
		expect(result).toEqual([{ key: "999999||", label: "999999 บัญชีที่ไม่รู้จัก", total: 10 }]);
	});

	test("empty lines[] returns an empty array", () => {
		expect(computeLineSubtotals([], coaRows())).toEqual([]);
	});
});

// --- peakDateHint ---------------------------------------------------

describe("peakDateHint", () => {
	test("blank/null value produces no hint", () => {
		expect(peakDateHint(null)).toBe("");
		expect(peakDateHint(undefined)).toBe("");
		expect(peakDateHint("")).toBe("");
		expect(peakDateHint("   ")).toBe("");
	});

	test("a cleanly-parseable ISO date shows the PEAK YYYYMMDD form", () => {
		expect(peakDateHint("2026-04-07")).toBe("PEAK: 20260407");
	});

	test("a Thai spelled-out date normalizes the same way", () => {
		expect(peakDateHint("7 เมษายน 2569")).toBe("PEAK: 20260407");
	});

	test("an unparseable value produces a warning-shaped hint instead of a bare PEAK: line", () => {
		const hint = peakDateHint("ไม่ทราบวันที่");
		expect(hint).toContain("⚠");
		expect(hint).toContain("ไม่ทราบวันที่");
	});
});

// --- bucketLabel ---------------------------------------------------

describe("bucketLabel", () => {
	test("maps every document bucket to a distinct Thai label", () => {
		const buckets: DocumentBucket[] = ["expense/vat", "expense/non_vat", "expense/mixed", "income/vat", "income/non_vat"];
		const labels = buckets.map(bucketLabel);
		expect(new Set(labels).size).toBe(buckets.length);
		for (const label of labels) expect(label.length).toBeGreaterThan(0);
	});

	test("expense/mixed's label mentions both VAT and non-VAT", () => {
		expect(bucketLabel("expense/mixed")).toContain("VAT");
	});
});

// --- factLabel ---------------------------------------------------

describe("factLabel", () => {
	test("known keys resolve to a Thai label", () => {
		expect(factLabel("date")).toBe("วันที่เอกสาร");
		expect(factLabel("seller_tax_id")).toBe("เลขผู้เสียภาษี (ผู้ขาย)");
	});

	test("an unknown key falls back to the raw key rather than being hidden", () => {
		expect(factLabel("some_new_field")).toBe("some_new_field");
	});
});

// --- isNumericFactKey ---------------------------------------------------

describe("isNumericFactKey", () => {
	test("well-known money fields are numeric", () => {
		for (const key of ["subtotal", "vat", "total", "paid", "wht", "exchange_rate", "original_amount"]) {
			expect(isNumericFactKey(key)).toBe(true);
		}
	});

	test("text-shaped fields are not numeric", () => {
		for (const key of ["date", "seller", "buyer", "document_no", "vat_treatment", "summary"]) {
			expect(isNumericFactKey(key)).toBe(false);
		}
	});
});

// --- pageEditUrl ---------------------------------------------------

describe("pageEditUrl", () => {
	test("builds the exact route someone else wires in server.ts", () => {
		expect(pageEditUrl("client-a", "2026-04", "expense", "vat", "seg-001", 0)).toBe(
			"/api/review/client-a/2026-04/expense/vat/seg-001/pages/0",
		);
	});

	test("encodes clientId/monthId/groupId but leaves category/vat as literal path segments", () => {
		const url = pageEditUrl("ลูกค้า A/B", "2026-04", "expense", "mixed", "seg 001", 3);
		expect(url).toBe(`/api/review/${encodeURIComponent("ลูกค้า A/B")}/2026-04/expense/mixed/${encodeURIComponent("seg 001")}/pages/3`);
		expect(url).not.toContain(" ");
	});
});

// --- bucketExportUrl -----------------------------------------------------

describe("bucketExportUrl", () => {
	test("builds the bucket-wide export route", () => {
		expect(bucketExportUrl("client-a", "2026-04", "expense", "vat")).toBe("/api/export/client-a/2026-04/expense/vat");
	});

	test("encodes clientId/monthId", () => {
		expect(bucketExportUrl("ลูกค้า A/B", "2026-04", "income", "non_vat")).toBe(`/api/export/${encodeURIComponent("ลูกค้า A/B")}/2026-04/income/non_vat`);
	});
});

// --- renderDocumentReviewPage (smoke tests only) ---------------------------

describe("renderDocumentReviewPage", () => {
	let dir: string;

	function withScratchDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
		const d = mkdtempSync(join(tmpdir(), "ksk-document-review-test-"));
		return fn(d).finally(() => rmSync(d, { recursive: true, force: true }));
	}

	test("renders known field values and labels for a representative expense/vat page", async () => {
		const html = await withScratchDir((d) => renderDocumentReviewPage(d, reviewPageData()));
		expect(html).toContain("บริษัท เอบีซี จำกัด");
		expect(html).toContain("page-001");
		expect(html).toContain("Performance Marketing");
		expect(html).toContain("520211-001 ค่าที่ปรึกษา"); // coaLabel() for the pre-selected account
		expect(html).toContain("PEAK: 20260407"); // peakDateHint next to facts.date
	});

	test("the empty-pages state renders the Thai empty message, not a blank layout", async () => {
		const html = await withScratchDir((d) => renderDocumentReviewPage(d, reviewPageData({ pages: [] })));
		expect(html).toContain("ไม่มีเอกสารในหมวดนี้");
	});

	test("shows the guard banner and disables inputs when guard.disabled is true", async () => {
		const html = await withScratchDir((d) =>
			renderDocumentReviewPage(d, reviewPageData({ guard: guard({ disabled: true, message: "กำลังประมวลผลอยู่" }) })),
		);
		expect(html).toContain("กำลังประมวลผลอยู่");
		expect(html).toContain("disabled");
	});

	test("expense/mixed pages show a per-line vat_treatment <select>; other buckets don't", async () => {
		const mixedHtml = await withScratchDir((d) => renderDocumentReviewPage(d, reviewPageData({ bucket: "expense/mixed" })));
		expect(mixedHtml).toContain('data-field="vat_treatment"');

		const vatHtml = await withScratchDir((d) => renderDocumentReviewPage(d, reviewPageData({ bucket: "expense/vat" })));
		expect(vatHtml).not.toContain('data-field="vat_treatment"');
	});

	test("a page with no source_src shows the 'no preview' placeholder", async () => {
		const html = await withScratchDir((d) =>
			renderDocumentReviewPage(d, reviewPageData({ pages: [page({ source_src: null })] })),
		);
		expect(html).toContain("ไม่มีเอกสารตัวอย่าง");
	});

	test("group_review_flags render an amber flags banner with the flag text", async () => {
		const html = await withScratchDir((d) =>
			renderDocumentReviewPage(d, reviewPageData({ pages: [page({ group_review_flags: ["ยอดเงินไม่ตรงกับใบเสร็จ"] })] })),
		);
		expect(html).toContain("ยอดเงินไม่ตรงกับใบเสร็จ");
		expect(html).toContain("flags-banner");
	});

	test("a needs_attention page shows the attention badge", async () => {
		const html = await withScratchDir((d) =>
			renderDocumentReviewPage(d, reviewPageData({ pages: [page({ initial_status: "needs_attention" })] })),
		);
		expect(html).toContain("badge-attention");
		expect(html).toContain("ต้องตรวจสอบ");
	});

	test("the Save button posts to the exact pageEditUrl for that page's group/pageIndex", async () => {
		const html = await withScratchDir((d) =>
			renderDocumentReviewPage(d, reviewPageData({ pages: [page({ group_id: "seg-042", page_index_in_group: 2 })] })),
		);
		expect(html).toContain(pageEditUrl("client-a", "2026-04", "expense", "vat", "seg-042", 2));
	});

	test("an xlsx source_src that doesn't exist on disk falls back to the unreadable-file placeholder instead of throwing", async () => {
		const html = await withScratchDir((d) =>
			renderDocumentReviewPage(d, reviewPageData({ pages: [page({ source_src: "missing.xlsx", source_sheet: "Sheet1" })] })),
		);
		expect(html).toContain("ไม่สามารถแสดงตัวอย่างไฟล์ Excel นี้ได้");
		expect(html).toContain("missing.xlsx");
	});
});
