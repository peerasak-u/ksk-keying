import { describe, expect, test } from "bun:test";
import { claimViews, renderExcludedReview, sideView, unitLabel, type ExcludedReviewPage } from "./excluded-review";
import type { Claim } from "./review-claims";

function claim(over: Partial<Claim> = {}): Claim {
	return {
		unitKey: "a.pdf#1",
		file: "a.pdf",
		page: 1,
		sheet: null,
		reasonCategory: "duplicate",
		reasonLabel: "ซ้ำกับเอกสารอื่น",
		declaredBy: "agent",
		extraScrutiny: false,
		duplicateOf: null,
		conflictGroup: null,
		referenceReportCheckMissing: false,
		...over,
	} as Claim;
}

function page(over: Partial<ExcludedReviewPage> = {}): ExcludedReviewPage {
	return {
		clientId: "216",
		monthId: "เดือนเมษายน",
		companyName: "บริษัท ทดสอบ จำกัด",
		claims: [claim()],
		guard: { disabled: false, message: null },
		hasAnyExcludedEntries: true,
		xlsxPreviews: new Map(),
		...over,
	};
}

describe("unitLabel", () => {
	test("prefers page over sheet", () => {
		expect(unitLabel(7, "Sheet1")).toBe("หน้า 7");
	});
	test("falls back to sheet, then whole file", () => {
		expect(unitLabel(null, "Sheet1")).toBe("ชีต Sheet1");
		expect(unitLabel(null, null)).toBe("ทั้งไฟล์");
	});
});

describe("sideView", () => {
	const ref = (over: object) => ({ unitKey: "k", file: "a.pdf", page: 3, sheet: null, ...over }) as any;

	test("pdf side carries a files URL and the claimed page", () => {
		const v = sideView("216", "เดือนเมษายน", ref({}), "0-cut");
		expect(v.kind).toBe("pdf");
		if (v.kind !== "pdf") throw new Error("unreachable");
		expect(v.page).toBe(3);
		expect(v.src).toBe("/files/216/%E0%B9%80%E0%B8%94%E0%B8%B7%E0%B8%AD%E0%B8%99%E0%B9%80%E0%B8%A1%E0%B8%A9%E0%B8%B2%E0%B8%A2%E0%B8%99/a.pdf");
	});

	test("a page-less pdf ref still pins to a real page number", () => {
		const v = sideView("216", "m", ref({ page: null }), "0-cut");
		if (v.kind !== "pdf") throw new Error("unreachable");
		expect(v.page).toBe(1);
	});

	test("xlsx side points at a template key instead of a URL", () => {
		const v = sideView("216", "m", ref({ file: "b.xlsx", page: null, sheet: "งบ" }), "2-kept");
		expect(v.kind).toBe("xlsx");
		if (v.kind !== "xlsx") throw new Error("unreachable");
		expect(v.tpl).toBe("2-kept");
		expect(v.unit).toBe("ชีต งบ");
	});

	test("file and unit stay separate from the joined label", () => {
		const v = sideView("216", "m", ref({}), "0-cut");
		expect(v.file).toBe("a.pdf");
		expect(v.unit).toBe("หน้า 3");
		expect(v.label).toBe("a.pdf · หน้า 3");
	});
});

describe("claimViews", () => {
	test("a duplicate claim gets both sides, keyed to matching templates", () => {
		const [v] = claimViews(
			page({
				claims: [claim({ duplicateOf: { unitKey: "a.pdf#5", file: "a.pdf", page: 5, sheet: null } as any })],
			}),
		);
		expect(v.cut.kind).toBe("pdf");
		expect(v.kept?.unit).toBe("หน้า 5");
		expect(v.dupNote).toBe("ซ้ำกับ: a.pdf · หน้า 5");
	});

	test("a non-duplicate claim has no kept side", () => {
		const [v] = claimViews(page());
		expect(v.kept).toBeNull();
		expect(v.dupNote).toBeNull();
	});

	test("declaredBy is translated for display", () => {
		expect(claimViews(page())[0].declaredBy).toBe("Agent");
		expect(claimViews(page({ claims: [claim({ declaredBy: "agent_policy" })] }))[0].declaredBy).toBe("นโยบายระบบ");
	});
});

describe("renderExcludedReview", () => {
	test("uses PDF.js, not a native pdf embed, for the previews", () => {
		const html = renderExcludedReview(page());
		expect(html).toContain('<script src="/public/vendor/pdf.min.js">');
		expect(html).toContain("/public/vendor/pdf.worker.min.js");
		// A literal <embed> string survives in the PDF.js-missing fallback
		// branch, so assert on the real thing: no embed is SERVED in markup.
		expect(html).not.toContain('<embed class=');
	});

	test("renders exactly one compare viewer no matter how many claims", () => {
		const html = renderExcludedReview(
			page({ claims: [claim(), claim({ unitKey: "b.pdf#1", file: "b.pdf" }), claim({ unitKey: "c.pdf#1", file: "c.pdf" })] }),
		);
		expect(html.match(/id="scroll-cut"/g)?.length).toBe(1);
		expect(html.match(/id="scroll-kept"/g)?.length).toBe(1);
		expect(html.match(/class="rail-row/g)?.length).toBe(3);
	});

	test("claim metadata reaches the script without breaking out of it", () => {
		const html = renderExcludedReview(page({ claims: [claim({ file: "</script><img src=x>.pdf" })] }));
		expect(html).not.toContain("</script><img src=x>");
		expect(html).toContain("\\u003c/script>");
	});

	test("escapes claim text in the rail", () => {
		const html = renderExcludedReview(page({ claims: [claim({ file: "<b>x</b>.pdf" })] }));
		expect(html).toContain("&lt;b&gt;x&lt;/b&gt;.pdf");
	});

	test("distinguishes 'reviewed to completion' from 'never had exclusions'", () => {
		expect(renderExcludedReview(page({ claims: [], hasAnyExcludedEntries: true }))).toContain("ตรวจสอบครบทุกรายการแล้ว");
		expect(renderExcludedReview(page({ claims: [], hasAnyExcludedEntries: false }))).toContain("ไม่มีรายการที่ต้องตรวจสอบสำหรับเดือนนี้");
	});

	test("a disabled guard shows its banner and disables every action", () => {
		const html = renderExcludedReview(page({ guard: { disabled: true, message: "กำลังรันอยู่" } }));
		expect(html).toContain("กำลังรันอยู่");
		expect(html).toContain("btn btn-confirm\" disabled");
		expect(html).toContain("var guardDisabled = true;");
	});

	test("conflict and missing-check warnings surface on the row", () => {
		const html = renderExcludedReview(
			page({ claims: [claim({ conflictGroup: "grp-1", referenceReportCheckMissing: true })] }),
		);
		expect(html).toContain("grp-1");
		expect(html).toContain("reference-report-check ยังไม่รัน");
	});

	test("an xlsx claim ships its pre-rendered table as a template", () => {
		const html = renderExcludedReview(
			page({
				claims: [claim({ unitKey: "b.xlsx#s", file: "b.xlsx", page: null, sheet: "งบ" })],
				xlsxPreviews: new Map([["b.xlsx#s", "<div class='xlsx-sheet-table'>TABLE</div>"]]),
			}),
		);
		expect(html).toContain('<template class="xlsx-tpl" data-key="0-cut">');
		expect(html).toContain("TABLE");
	});
});
