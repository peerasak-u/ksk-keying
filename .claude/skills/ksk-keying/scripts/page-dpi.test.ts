import { describe, expect, test } from "bun:test";
import {
	bucketIntoRuns,
	classifyPageDpis,
	decidePageDpis,
	MAX_RENDER_DPI,
	MIN_RENDER_DPI,
	parsePageSizesPts,
	parsePdfImagesList,
	parsePdfTextPages,
} from "./page-dpi";

const A4_W = 595.276;
const A4_H = 841.89;

// What `pdfinfo -f 1 -l <n>` really prints (verified against poppler 25.03 on
// a real client PDF): one "Page N size:" line per page, and NO document-level
// "Page size:" line.
function pageInfo(pageCount: number, size: (page: number) => [number, number] = () => [A4_W, A4_H]) {
	const lines: string[] = ["Pages:           " + pageCount];
	for (let page = 1; page <= pageCount; page++) {
		const [w, h] = size(page);
		lines.push(`Page  ${String(page).padStart(3)} size:  ${w} x ${h} pts (A4)`);
		lines.push(`Page  ${String(page).padStart(3)} rot:   0`);
	}
	return lines.join("\n") + "\n";
}

const PAGE_INFO = pageInfo(3);

// Every page is A4 — the common case, spelled out per page so no test can
// accidentally rely on one page's size standing in for another's.
function A4_SIZES(pageCount: number) {
	const sizes = new Map<number, { widthPts: number; heightPts: number }>();
	for (let page = 1; page <= pageCount; page++) sizes.set(page, { widthPts: A4_W, heightPts: A4_H });
	return sizes;
}

function pdfImagesHeader() {
	return "page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio";
}

// A single image sized/positioned to exactly cover the A4 page at the given
// native ppi (width/height computed backwards from the page's point size so
// the "full page" check in decidePageDpis passes).
function fullPageImageRow(page: number, ppi: number) {
	const widthPx = Math.round((595.276 / 72) * ppi);
	const heightPx = Math.round((841.89 / 72) * ppi);
	return `   ${page}     0 image ${widthPx} ${heightPx}  gray    1   8  jpeg   no        13  0  ${ppi}   ${ppi}  245K 2.4%`;
}

function pdfTextWithPages(pagesText: string[]) {
	// pdftotext separates pages with \f and trails one after the last page.
	return pagesText.join("\f") + "\f";
}

describe("parsePdfImagesList", () => {
	test("parses a well-formed single-image row", () => {
		const out = [pdfImagesHeader(), "-".repeat(90), fullPageImageRow(1, 176)].join("\n");
		const rows = parsePdfImagesList(out);
		expect(rows).not.toBeNull();
		expect(rows).toHaveLength(1);
		expect(rows![0]).toMatchObject({ page: 1, xPpi: 176, yPpi: 176 });
	});

	test("returns null when the header can't be found at all", () => {
		expect(parsePdfImagesList("garbage\nmore garbage\n")).toBeNull();
	});

	test("returns an empty array (not null) for a page with no images", () => {
		const out = [pdfImagesHeader(), "-".repeat(90)].join("\n");
		expect(parsePdfImagesList(out)).toEqual([]);
	});

	// Named for what it actually proves. It does NOT isolate the
	// `cols.length <= maxIdx` guard — the Number.isFinite check catches a
	// short row too (missing column -> undefined -> NaN), so deleting that
	// guard leaves this test green. See the comment on it in page-dpi.ts.
	test("returns null for a truncated data row rather than parsing garbage", () => {
		const out = [pdfImagesHeader(), "-".repeat(90), "   1     0 image"].join("\n");
		expect(parsePdfImagesList(out)).toBeNull();
	});

	test("returns null when a full-width row carries a non-numeric value", () => {
		const row = fullPageImageRow(1, 176).replace(" 176   176 ", " n/a   176 ");
		const out = [pdfImagesHeader(), "-".repeat(90), row].join("\n");
		expect(parsePdfImagesList(out)).toBeNull();
	});

	// D5: a row whose on-page resolution poppler could not report is EVIDENCE
	// OF SOMETHING WE CANNOT SEE, not a row to discard. Dropping it used to
	// turn "a full-page scan plus one unreadable image" into "exactly one
	// image" — the cheap answer, reached by throwing away the doubt.
	test("keeps a zero-ppi row so the page it sits on stays unproven", () => {
		const zeroPpiRow = "   1     0 image  100  100  gray    1   8  image  no        13  0    0     0   1K 0.1%";
		const out = [pdfImagesHeader(), "-".repeat(90), fullPageImageRow(1, 176), zeroPpiRow].join("\n");
		const rows = parsePdfImagesList(out);
		expect(rows).toHaveLength(2);
		const dpis = decidePageDpis({
			pageCount: 1,
			images: rows,
			textCharsByPage: new Map([[1, 0]]),
			pageSizesPts: A4_SIZES(1),
		});
		expect(dpis).toEqual([MAX_RENDER_DPI]);
	});

	test("a lone zero-ppi row cannot pass the full-page match either", () => {
		const dpis = decidePageDpis({
			pageCount: 1,
			images: [{ page: 1, widthPx: 1447, heightPx: 2047, xPpi: 0, yPpi: 0 }],
			textCharsByPage: new Map([[1, 0]]),
			pageSizesPts: A4_SIZES(1),
		});
		expect(dpis).toEqual([MAX_RENDER_DPI]);
	});
});

describe("parsePdfTextPages", () => {
	test("splits on form-feed and counts non-whitespace chars per page", () => {
		const out = pdfTextWithPages(["", "Invoice No. 123\nTotal: 500"]);
		const map = parsePdfTextPages(out, 2);
		expect(map).not.toBeNull();
		expect(map!.get(1)).toBe(0);
		expect(map!.get(2)).toBeGreaterThan(0);
	});

	test("returns null when the page count doesn't match", () => {
		const out = pdfTextWithPages(["only one page"]);
		expect(parsePdfTextPages(out, 2)).toBeNull();
	});
});

describe("parsePageSizesPts", () => {
	test("parses one entry per page from pdfinfo -f/-l output", () => {
		const sizes = parsePageSizesPts(PAGE_INFO);
		expect(sizes.size).toBe(3);
		expect(sizes.get(2)).toEqual({ widthPts: A4_W, heightPts: A4_H });
	});

	// The D5 defect this shape exists to kill: a mixed-size document must not
	// hand page 2 the dimensions of page 1.
	test("keeps each page's own size when they differ", () => {
		const sizes = parsePageSizesPts(pageInfo(2, (page) => (page === 1 ? [200, 400] : [A4_W, A4_H])));
		expect(sizes.get(1)).toEqual({ widthPts: 200, heightPts: 400 });
		expect(sizes.get(2)).toEqual({ widthPts: A4_W, heightPts: A4_H });
	});

	// A pdfinfo run without -f/-l (or a build that omits the per-page lines):
	// the document-level line describes page 1 and nothing else, so it may only
	// ever be attributed to page 1.
	test("attributes a bare document-level Page size line to page 1 only", () => {
		const sizes = parsePageSizesPts("Pages:           4\nPage size:      595.276 x 841.89 pts (A4)\n");
		expect(sizes.size).toBe(1);
		expect(sizes.get(1)).toEqual({ widthPts: A4_W, heightPts: A4_H });
		expect(sizes.get(2)).toBeUndefined();
	});

	test("returns an empty map when no size line is present at all", () => {
		expect(parsePageSizesPts("Pages:           3\n").size).toBe(0);
	});
});

describe("decidePageDpis — a page with no size of its own is unproven", () => {
	// Reproduces the reported D5 violation end to end: page 2 is a full-page
	// scan by every other test, but its own size was never reported, so it must
	// NOT be downscaled on page 1's dimensions.
	test("a page missing from pageSizesPts renders at the ceiling", () => {
		const scan = (page: number, ppi: number) => ({
			page,
			widthPx: Math.round((A4_W / 72) * ppi),
			heightPx: Math.round((A4_H / 72) * ppi),
			xPpi: ppi,
			yPpi: ppi,
		});
		const dpis = decidePageDpis({
			pageCount: 2,
			images: [scan(1, 176), scan(2, 176)],
			textCharsByPage: new Map([
				[1, 0],
				[2, 0],
			]),
			pageSizesPts: A4_SIZES(1), // only page 1's size is known
		});
		expect(dpis).toEqual([200, MAX_RENDER_DPI]);
	});
});

describe("decidePageDpis — the classification rule", () => {
	test("single full-page image, no text -> native PPI rounded up to next 50", () => {
		const dpis = decidePageDpis({
			pageCount: 1,
			images: [{ page: 1, widthPx: 1447, heightPx: 2047, xPpi: 176, yPpi: 176 }],
			textCharsByPage: new Map([[1, 0]]),
			pageSizesPts: A4_SIZES(1),
		});
		expect(dpis).toEqual([200]); // 176 rounded up to next multiple of 50
	});

	test("multi-image page falls to 300", () => {
		const dpis = decidePageDpis({
			pageCount: 1,
			images: [
				{ page: 1, widthPx: 1447, heightPx: 2047, xPpi: 176, yPpi: 176 },
				{ page: 1, widthPx: 100, heightPx: 100, xPpi: 300, yPpi: 300 },
			],
			textCharsByPage: new Map([[1, 0]]),
			pageSizesPts: A4_SIZES(1),
		});
		expect(dpis).toEqual([MAX_RENDER_DPI]);
	});

	test("a page with a real text layer falls to 300 even with one full-page image", () => {
		const dpis = decidePageDpis({
			pageCount: 1,
			images: [{ page: 1, widthPx: 1447, heightPx: 2047, xPpi: 176, yPpi: 176 }],
			textCharsByPage: new Map([[1, 42]]),
			pageSizesPts: A4_SIZES(1),
		});
		expect(dpis).toEqual([MAX_RENDER_DPI]);
	});

	test("a partial-page image (e.g. a logo/stamp, not full bleed) falls to 300", () => {
		const dpis = decidePageDpis({
			pageCount: 1,
			images: [{ page: 1, widthPx: 200, heightPx: 200, xPpi: 300, yPpi: 300 }],
			textCharsByPage: new Map([[1, 0]]),
			pageSizesPts: A4_SIZES(1),
		});
		expect(dpis).toEqual([MAX_RENDER_DPI]);
	});

	test("unparseable upstream input (null images) falls to 300 for every page", () => {
		const dpis = decidePageDpis({
			pageCount: 3,
			images: null,
			textCharsByPage: new Map([
				[1, 0],
				[2, 0],
				[3, 0],
			]),
			pageSizesPts: A4_SIZES(3),
		});
		expect(dpis).toEqual([MAX_RENDER_DPI, MAX_RENDER_DPI, MAX_RENDER_DPI]);
	});

	test("a page with no image at all falls to 300", () => {
		const dpis = decidePageDpis({
			pageCount: 1,
			images: [],
			textCharsByPage: new Map([[1, 0]]),
			pageSizesPts: A4_SIZES(1),
		});
		expect(dpis).toEqual([MAX_RENDER_DPI]);
	});

	test("native PPI above 300 is capped at MAX_RENDER_DPI, never rendered higher", () => {
		const widthPx = Math.round((595.276 / 72) * 600);
		const heightPx = Math.round((841.89 / 72) * 600);
		const dpis = decidePageDpis({
			pageCount: 1,
			images: [{ page: 1, widthPx, heightPx, xPpi: 600, yPpi: 600 }],
			textCharsByPage: new Map([[1, 0]]),
			pageSizesPts: A4_SIZES(1),
		});
		expect(dpis).toEqual([MAX_RENDER_DPI]);
	});

	test("absurdly low native PPI is clamped to the MIN_RENDER_DPI floor, not rendered as a 40 DPI thumbnail", () => {
		const widthPx = Math.round((595.276 / 72) * 40);
		const heightPx = Math.round((841.89 / 72) * 40);
		const dpis = decidePageDpis({
			pageCount: 1,
			images: [{ page: 1, widthPx, heightPx, xPpi: 40, yPpi: 40 }],
			textCharsByPage: new Map([[1, 0]]),
			pageSizesPts: A4_SIZES(1),
		});
		expect(dpis).toEqual([MIN_RENDER_DPI]);
	});
});

// prepare.ts's `--dpi` flag (documented default 200, production passes 300) is
// the CEILING, not just the fallback. These pin that: with a hardcoded 300
// ceiling every one of them fails, because a caller asking for 200 would get
// 300 back — more pixels than it asked for, in the script whose render time
// already overran its supervisor once.
describe("decidePageDpis — the caller's requested DPI is the ceiling", () => {
	const scanAt = (ppi: number) => ({
		page: 1,
		widthPx: Math.round((595.276 / 72) * ppi),
		heightPx: Math.round((841.89 / 72) * ppi),
		xPpi: ppi,
		yPpi: ppi,
	});

	test("an ambiguous page falls back to the requested DPI, not to 300", () => {
		const dpis = decidePageDpis({
			pageCount: 1,
			images: [scanAt(176)],
			textCharsByPage: new Map([[1, 42]]), // text layer -> ambiguous -> fall back
			pageSizesPts: A4_SIZES(1),
			maxDpi: 200,
		});
		expect(dpis).toEqual([200]);
	});

	test("a scan whose native PPI exceeds the requested DPI is capped at the request", () => {
		const dpis = decidePageDpis({
			pageCount: 1,
			images: [scanAt(250)],
			textCharsByPage: new Map([[1, 0]]),
			pageSizesPts: A4_SIZES(1),
			maxDpi: 200,
		});
		expect(dpis).toEqual([200]);
	});

	test("an unparseable PDF falls back to the requested DPI for every page", () => {
		const dpis = decidePageDpis({
			pageCount: 2,
			images: null,
			textCharsByPage: null,
			pageSizesPts: null,
			maxDpi: 200,
		});
		expect(dpis).toEqual([200, 200]);
	});

	test("a requested DPI below MIN_RENDER_DPI wins over the floor — never render above what was asked", () => {
		const dpis = decidePageDpis({
			pageCount: 1,
			images: [scanAt(176)],
			textCharsByPage: new Map([[1, 0]]),
			pageSizesPts: A4_SIZES(1),
			maxDpi: 100,
		});
		expect(dpis).toEqual([100]);
	});

	test("omitting maxDpi keeps the D5-safe MAX_RENDER_DPI default", () => {
		const dpis = decidePageDpis({
			pageCount: 1,
			images: [],
			textCharsByPage: new Map([[1, 0]]),
			pageSizesPts: A4_SIZES(1),
		});
		expect(dpis).toEqual([MAX_RENDER_DPI]);
	});

	test("classifyPageDpis threads maxDpi through to the decision", () => {
		const out = [pdfImagesHeader(), "-".repeat(90), fullPageImageRow(1, 176)].join("\n");
		const dpis = classifyPageDpis({
			pageCount: 2,
			pdfImagesListOutput: out,
			pdfTextOutput: pdfTextWithPages(["", "Bank Statement"]),
			pdfInfoOutput: PAGE_INFO,
			maxDpi: 200,
		});
		// page 1 is a plain 176ppi scan -> 200; page 2 has text -> ceiling, which
		// is the caller's 200, NOT 300.
		expect(dpis).toEqual([200, 200]);
	});
});

describe("classifyPageDpis — end to end over raw command output", () => {
	test("a mixed document: scan pages cheap, a text page stays at 300", () => {
		const out = [
			pdfImagesHeader(),
			"-".repeat(90),
			fullPageImageRow(1, 176),
			fullPageImageRow(2, 176),
			fullPageImageRow(3, 176),
		].join("\n");
		const text = pdfTextWithPages(["", "", "Bank Statement\nBalance: 1,234.56"]);
		const dpis = classifyPageDpis({
			pageCount: 3,
			pdfImagesListOutput: out,
			pdfTextOutput: text,
			pdfInfoOutput: PAGE_INFO,
		});
		expect(dpis).toEqual([200, 200, MAX_RENDER_DPI]);
	});

	test("total classification failure (garbage pdfimages output) still returns a full, valid, all-300 array", () => {
		const dpis = classifyPageDpis({
			pageCount: 2,
			pdfImagesListOutput: "not pdfimages output at all",
			pdfTextOutput: pdfTextWithPages(["", ""]),
			pdfInfoOutput: PAGE_INFO,
		});
		expect(dpis).toEqual([MAX_RENDER_DPI, MAX_RENDER_DPI]);
	});
});

describe("bucketIntoRuns", () => {
	test("groups contiguous same-DPI pages into one run", () => {
		expect(bucketIntoRuns([200, 200, 200, 300, 300, 200])).toEqual([
			{ dpi: 200, startPage: 1, endPage: 3 },
			{ dpi: 300, startPage: 4, endPage: 5 },
			{ dpi: 200, startPage: 6, endPage: 6 },
		]);
	});

	test("a single page produces a single run", () => {
		expect(bucketIntoRuns([300])).toEqual([{ dpi: 300, startPage: 1, endPage: 1 }]);
	});
});
