// Pure document-review helper tests — fixed fixture lines/pages/coaRows, no
// file I/O (same describe/test + fixture-builder style as
// review-edit.test.ts/xlsx-preview.test.ts). renderDocumentReviewPage itself
// gets a couple of smoke assertions only (key content appears in the
// rendered string for a representative fixture) — the real verification of
// the rendered page is a manual smoke test, not a unit-test job (per the
// ticket's own instruction).
import { describe, expect, test } from "bun:test";
import { reviewHubUrl } from "./nav";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoaRow } from "./coa";
import type { DocumentReviewGuard, DocumentReviewPage } from "./document-review";
import {
	bucketExportUrl,
	bucketLabel,
	computeLineSubtotals,
	factGroups,
	factLabel,
	isNumericFactKey,
	isPdfSourced,
	pageEditUrl,
	peakDateHint,
	reconcileFacts,
	renderDocumentReviewPage,
} from "./document-review";
import type { DocumentBucket, ReviewLine, ReviewPage, ReviewPageFacts } from "./review-data";

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

describe("factGroups", () => {
	function facts(overrides: ReviewPageFacts = {}): ReviewPageFacts {
		return { date: "2026-04-07", document_no: "INV-1", seller: "ก", subtotal: 100, vat: 7, total: 107, ...overrides };
	}

	test("splits facts into the four display blocks, in canonical field order", () => {
		const groups = factGroups(facts());
		expect(groups.map((g) => g.title)).toEqual(["เอกสาร", "คู่ค้า", "ยอดเงิน"]);
		expect(groups[0].keys).toEqual(["date", "document_no"]);
		expect(groups[2].keys).toEqual(["subtotal", "vat", "total"]); // not the object's own key order
	});

	test("omits a block entirely when the page carries none of its fields", () => {
		const groups = factGroups({ date: "2026-04-07" });
		expect(groups.map((g) => g.title)).toEqual(["เอกสาร"]);
	});

	test("keeps only keys the page actually has — a block never invents blank fields", () => {
		const groups = factGroups(facts());
		const money = groups.find((g) => g.title === "ยอดเงิน");
		expect(money?.keys).not.toContain("wht");
		expect(money?.keys).not.toContain("paid");
	});

	test("an unrecognized fact key stays visible, in อื่นๆ, rather than being dropped", () => {
		const groups = factGroups({ date: "x", weird_custom_field: "keep me" });
		const other = groups.find((g) => g.title === "อื่นๆ");
		expect(other?.keys).toEqual(["weird_custom_field"]);
	});

	test("a blank-but-present field is still grouped (dimming is a render concern, not a data one)", () => {
		const groups = factGroups({ date: "2026-04-07", reference: null });
		expect(groups[0].keys).toEqual(["date", "reference"]);
	});
});

describe("reconcileFacts", () => {
	test("passes every check when the document's own arithmetic holds", () => {
		const rows = reconcileFacts({ subtotal: 100, vat: 7, total: 107, wht: 3, paid: 104 }, [line({ amount: 100 })]);
		expect(rows).toHaveLength(3);
		expect(rows.every((r) => r.ok)).toBe(true);
	});

	test("flags subtotal + vat that does not reach the stated total, and says what it should be", () => {
		const rows = reconcileFacts({ subtotal: 100, vat: 7, total: 999 }, []);
		expect(rows[0].ok).toBe(false);
		expect(rows[0].detail).toContain("107.00");
		expect(rows[0].detail).toContain("999.00");
	});

	test("flags a line-item sum that disagrees with the subtotal", () => {
		const rows = reconcileFacts({ subtotal: 100 }, [line({ amount: 60 }), line({ line_index: 1, amount: 10 })]);
		expect(rows).toHaveLength(1);
		expect(rows[0].ok).toBe(false);
		expect(rows[0].detail).toContain("70.00");
	});

	test("a blank input SKIPS its check rather than failing it — most fact fields are legitimately empty", () => {
		const rows = reconcileFacts({ subtotal: 100, vat: null, total: 107 }, []);
		expect(rows).toEqual([]);
	});

	test("wht/paid is only checked once both are present alongside the total", () => {
		const withoutWht = reconcileFacts({ total: 107, paid: 104 }, []);
		expect(withoutWht).toEqual([]);
		const withWht = reconcileFacts({ total: 107, wht: 3, paid: 104 }, []);
		expect(withWht.map((r) => r.ok)).toEqual([true]);
	});

	test("tolerates satang-level float drift instead of crying wolf", () => {
		const rows = reconcileFacts({ subtotal: 1471.28, vat: 102.99, total: 1574.27 }, []);
		expect(rows[0].ok).toBe(true);
	});

	test("a null line amount counts as zero, not as a crash", () => {
		const rows = reconcileFacts({ subtotal: 50 }, [line({ amount: 50 }), line({ line_index: 1, amount: null })]);
		expect(rows[0].ok).toBe(true);
	});
});

describe("isPdfSourced", () => {
	test("a PDF source previews through the shared PDF.js viewer", () => {
		expect(isPdfSourced(page({ source_src: "บิลซื้อ.pdf" }))).toBe(true);
	});

	test("a workbook source does not — it is server-rendered as a sheet table", () => {
		expect(isPdfSourced(page({ source_src: "ภาษีซื้อ.xlsx" }))).toBe(false);
		expect(isPdfSourced(page({ source_src: "ภาษีซื้อ.xls" }))).toBe(false);
	});

	test("a page with no source at all is not PDF-sourced (placeholder, not viewer)", () => {
		expect(isPdfSourced(page({ source_src: null }))).toBe(false);
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

	test("a PDF page emits no <embed> — it is drawn by the one shared PDF.js viewer", async () => {
		const html = await withScratchDir((d) => renderDocumentReviewPage(d, reviewPageData({ pages: [page({ source_src: "บิลซื้อ.pdf", source_page: 5 })] })));
		// No embed ELEMENT in the served markup — the native viewer survives only
		// as a client-side fallback built by script if PDF.js fails to load.
		expect(html).not.toContain('type="application/pdf"');
		expect(html).toContain('id="pdfScroll"');
		expect(html).toContain("/public/vendor/pdf.min.js");
		expect(html).toContain('"page":5'); // PAGES metadata drives the viewer's scroll target
	});

	test("a non-PDF page still gets its server-rendered preview, wrapped for client-side toggling", async () => {
		const html = await withScratchDir((d) => renderDocumentReviewPage(d, reviewPageData({ pages: [page({ source_src: null })] })));
		expect(html).toContain('<div class="static-preview" data-index="0">');
		expect(html).toContain("ไม่มีเอกสารตัวอย่าง");
	});

	test("only ONE preview column is rendered no matter how many documents the bucket holds", async () => {
		const pages = [page({ ref: "a", source_src: "x.pdf" }), page({ ref: "b", source_src: "y.pdf" }), page({ ref: "c", source_src: "z.pdf" })];
		const html = await withScratchDir((d) => renderDocumentReviewPage(d, reviewPageData({ pages })));
		expect(html.match(/class="preview-col"/g)?.length).toBe(1);
		expect(html.match(/id="pdfScroll"/g)?.length).toBe(1);
		expect(html.match(/class="detail-panel/g)?.length).toBe(3); // one form panel each
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

describe("save → next document", () => {
	function withScratchDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
		const d = mkdtempSync(join(tmpdir(), "ksk-document-review-test-"));
		return fn(d).finally(() => rmSync(d, { recursive: true, force: true }));
	}

	test("each list row carries a check mark and the script advances on save", async () => {
		const html = await withScratchDir((d) =>
			renderDocumentReviewPage(d, reviewPageData({ pages: [page({ group_id: "g1" }), page({ group_id: "g2", ref: "r2", short_ref: "s2" })] })),
		);
		expect(html).toContain('<span class="row-check"');
		expect(html).toContain("advanceAfterSave(index);");
		expect(html).toContain("function nextPending(from)");
	});

	test("a page already skipped starts marked done, so it can't block completion", async () => {
		const html = await withScratchDir((d) => renderDocumentReviewPage(d, reviewPageData({ pages: [page({ skipped: true })] })));
		expect(html).toContain('class="list-row is-active is-done"');
		expect(html).toContain('"skipped":true');
	});

	test("an unskipped page is not pre-marked", async () => {
		const html = await withScratchDir((d) => renderDocumentReviewPage(d, reviewPageData({ pages: [page({ skipped: false })] })));
		expect(html).toContain('class="list-row is-active"');
		expect(html).toContain('"skipped":false');
	});

	test("the completion dialog offers export, the hub, and staying put", async () => {
		const html = await withScratchDir((d) => renderDocumentReviewPage(d, reviewPageData({ pages: [page()] })));
		expect(html).toContain('id="doneModal"');
		expect(html).toContain("บันทึกครบทุกเอกสารแล้ว");
		expect(html).toContain("ส่งออก PEAK XLSX</button>");
		expect(html).toContain(`href="${reviewHubUrl("client-a", "2026-04")}"`);
		expect(html).toContain("อยู่หน้านี้ต่อ");
	});

	test("a running gate disables the dialog's export action too", async () => {
		const html = await withScratchDir((d) =>
			renderDocumentReviewPage(d, reviewPageData({ pages: [page()], guard: { disabled: true, message: "กำลังรันอยู่" } })),
		);
		expect(html).toContain('class="done-primary" disabled');
	});
});
