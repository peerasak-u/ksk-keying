// Per-page DPI classification for prepare.ts's PDF renderer.
//
// WHY THIS EXISTS: prepare.ts used to render every PDF page at one flat DPI
// (300 in production, see console/sequencer/spawn-stage.ts). Measured on a
// real client PDF on this Pi (10 pages, see the task/handoff notes that
// produced this file — not re-derivable from code, so recorded here):
//   300 DPI: 72.5s / 26.5MB   176 DPI (a page's native scan res): 31.2s / 13.3MB
// ~93% of render time scales with output pixel count. Client 345 showed 242
// of 253 pages are a single full-page JPEG scan at 121-215 native PPI with
// ZERO characters of text layer — rendering those at 300 upscales pixel
// count ~2.9x and invents detail that was never captured by the scanner.
// The other 11 pages (bank statements) had a real text layer and stay at
// 300 because that's a vector/text page, not a plain scan.
//
// WHAT THIS ACTUALLY DELIVERS (measured 2026-07-27 by running the classifier
// below over every PDF of two real sample clients — classification only, no
// rendering — so these are the numbers to plan against, NOT the paragraph
// above, which describes the documents rather than the classifier's verdict
// on them):
//   client 345, month 04-69 (251 PDF pages): 118 downscaled, 128 held at 300
//     by the full-page check, 5 by multi-image. Pixel cost vs all-300: 0.739,
//     i.e. ~24% less render time, not the ~57% "242 of 253" suggests.
//   client 336 (2,799 PDF pages, 1,056 PDFs): 101 downscaled. Pixel cost
//     0.980 — this optimization is very nearly INERT for this client, whose
//     pages are mostly multi-image composites (several receipt photos per
//     page: 513 pages) or vector/text (267). Do not budget any speedup for
//     336 on the strength of it; its render is ~2,800 pages at ~4 s/page
//     either way (see SCRIPT_RUN_PER_PAGE_MS in spawn-stage.ts).
// The classifier's own cost is ~0.12 s/PDF (3 extra poppler spawns), which
// for 336 is ~2 min of overhead against ~4 min saved — roughly break-even
// there, a clear win on 345.
//
// THE SINGLE BIGGEST TUNING KNOB IS FULL_PAGE_TOLERANCE, and it is
// deliberately NOT being loosened here. Of 345's 128 held-back pages, every
// sampled one is a single zero-text JPEG scan matching the page to within
// 0.3% in ONE dimension and covering 75-97% of the other — a scan fitted to
// the page with a letterbox strip, not a stamp or logo. Widening 3% to ~25%
// would roughly double this optimization's yield on 345. It is a D5 decision,
// not a bug fix: nothing proves that strip is empty, so widening trades a
// provable guarantee for speed and needs a human to say yes.
//
// D5 (design decision, already agreed): only lower DPI where it is PROVEN
// no detail exists above it; any doubt resolves to the caller's requested
// DPI (`maxDpi`, 300 in production). This module is structured so every
// ambiguous or unparseable case takes that branch — worst case it just fails
// to save render time.
//
// KNOWN, DELIBERATELY ACCEPTED D5 GAP — vector/annotation overlays. Neither
// probe can see them: `pdfimages` lists raster images only, `pdftotext` sees
// text only. A page that is one full-page scan PLUS a vector-drawn stamp,
// signature stroke or table rule therefore classifies as "plain scan" and is
// rendered at the scan's native PPI. Vector art has no native resolution, so
// D5's "proven" bar is genuinely not met here. It is accepted rather than
// fixed because (a) unlike D6's pdfimages -j, nothing is DROPPED — the
// overlay is still rendered by pdftoppm, just at e.g. 200 DPI instead of 300,
// and MIN_RENDER_DPI keeps that at or above the legibility floor; and (b) no
// cheap, reliable vector probe exists in poppler-utils (pdftocairo -svg would
// answer it but re-encodes the whole embedded scan per page, costing more
// than the render it is trying to save). WHAT WOULD SETTLE IT: a spot check
// of downscaled pages from a real client against the same pages at 300 —
// if any stamp/signature is materially harder to read, this optimization
// must be gated behind a vector probe or dropped for pages with annotations.
//
// Everything below is a PURE function over already-captured command output
// strings (pdfimages -list / pdftotext / pdfinfo) so it can be unit tested
// without spawning poppler or touching a real client folder. See
// page-dpi.test.ts.

export type ImageRow = {
	page: number;
	widthPx: number;
	heightPx: number;
	xPpi: number;
	yPpi: number;
};

export type PageSizePts = { widthPts: number; heightPts: number };

export type PageDpiInput = {
	pageCount: number;
	// null means "pdfimages -list output could not be parsed at all" —
	// distinct from an empty array, which means "parsed fine, zero images".
	images: ImageRow[] | null;
	// null means "pdftotext output could not be split into pageCount pages".
	textCharsByPage: Map<number, number> | null;
	// PER PAGE, keyed by 1-based page number. This used to be a single
	// width/height pair read from pdfinfo's document-level "Page size:" line —
	// which is PAGE 1's MediaBox, not the document's. Applying it to every page
	// is a straight D5 violation and was reproduced, not theorised: a PDF whose
	// page 1 is a 200x400pt receipt and whose page 2 is A4 carrying that same
	// image in a corner (partial, plus hairline vector rules) classified page 2
	// as a full-page scan and downscaled it, having proven nothing about it.
	// A page with no entry here is UNPROVEN and renders at the ceiling; null
	// means no size information at all, so every page does.
	pageSizesPts: Map<number, PageSizePts> | null;
	// The caller's requested render DPI — prepare.ts's `--dpi` flag, whose
	// documented default is 200 and which production passes as 300 (see
	// console/sequencer/spawn-stage.ts). It is BOTH the ceiling and the
	// "couldn't prove anything, play it safe" default, so this module can
	// only ever pick a DPI at or BELOW what the caller asked for — never
	// above it. Without this the flag becomes a no-op on the success path:
	// a caller taking the documented 200 default would silently get 300 for
	// every text/vector page, i.e. ~2.25x the pixels it asked for, in the
	// exact script whose render time already overran its supervisor.
	// Optional only so a caller with genuinely no opinion still gets a
	// D5-safe ceiling; prepare.ts always passes args.dpi.
	maxDpi?: number;
};

// Never render below this floor. CHOSEN, NOT MEASURED: this dataset's own
// evidence only goes down to a native 121 PPI (client 345, see file header).
// 150 DPI is a common floor cited for "still legible for OCR/keying" scanned
// text (half of the 300 DPI reference-quality figure); picking anything
// lower risks a low-quality source thumbnail collapsing to something the
// downstream interpretation agent genuinely cannot read. If real client
// data ever surfaces a legitimate native scan below this, raise evidence
// and revisit — do not just lower the constant.
export const MIN_RENDER_DPI = 150;

// Ceiling used only when a caller names no `maxDpi` of its own. Matches
// decision D5's default-safe DPI and the production --dpi flag
// (console/sequencer/spawn-stage.ts calls prepare-pages with --dpi 300).
// NOTE: this is a fallback, not the rule — the real ceiling is whatever the
// caller passed as PageDpiInput.maxDpi. Hardcoding 300 here as the ceiling
// for everyone would silently override --dpi.
export const MAX_RENDER_DPI = 300;

// Round native PPI UP to the next multiple of this before use, so a scan at
// e.g. 176 PPI becomes 200, never truncated down below its own native
// resolution (which would re-introduce the exact loss we're trying to
// avoid).
export const DPI_ROUND_STEP = 50;

// How far a candidate full-page image's rendered size (computed from its
// pixel dimensions and reported x-ppi/y-ppi) may differ from the PDF's
// reported page size before we call it "not full page" and fall back to
// 300. GUESS, not measured: scanners and pdftoppm round page dimensions to
// whole points/pixels, so a genuine full-bleed scan should match within a
// percent or so; 3% leaves headroom for that rounding while still being far
// tighter than any partial-page image (a logo, a stamp) would ever land.
//
// NOW KNOWN TO BE THE BINDING CONSTRAINT, not a formality: on client 345 it
// alone holds back 128 of 251 pages, all of them single zero-text scans that
// match one dimension to within 0.3% and cover 75-97% of the other. See the
// file header for why widening it is a human decision under D5 rather than a
// tuning pass — and if it is ever widened, widen it ASYMMETRICALLY (a scan
// letterboxed on one axis is a different thing from an image that is small on
// both) and re-run the measurement in the header.
export const FULL_PAGE_TOLERANCE = 0.03;

/**
 * Parse `pdfimages -list <pdf>` output into per-image rows. Returns null if
 * the header line (and therefore the column layout) can't be found or a
 * data row doesn't parse — callers must treat null as "give up, use 300
 * everywhere for this PDF", per D5.
 */
export function parsePdfImagesList(output: string): ImageRow[] | null {
	const lines = output.split(/\r?\n/);
	const headerIdx = lines.findIndex((line) => /^\s*page\s+num\s+type\b/.test(line));
	if (headerIdx === -1) return null;

	const headers = lines[headerIdx].trim().split(/\s+/);
	const pageIdx = headers.indexOf("page");
	const widthIdx = headers.indexOf("width");
	const heightIdx = headers.indexOf("height");
	const xPpiIdx = headers.indexOf("x-ppi");
	const yPpiIdx = headers.indexOf("y-ppi");
	if ([pageIdx, widthIdx, heightIdx, xPpiIdx, yPpiIdx].some((i) => i === -1)) return null;
	const maxIdx = Math.max(pageIdx, widthIdx, heightIdx, xPpiIdx, yPpiIdx);

	const rows: ImageRow[] = [];
	for (const raw of lines.slice(headerIdx + 1)) {
		const line = raw.trim();
		if (!line) continue;
		if (/^-+$/.test(line)) continue; // "----" separator row under the header
		const cols = line.split(/\s+/);
		// A data row that doesn't fit the header shape — unparseable, bail
		// whole-PDF. Belt and braces: the Number.isFinite check below already
		// catches every case this can catch (a missing column reads as
		// undefined -> NaN), which is why no test can isolate this line. Kept
		// because it states the intent at the point the shape is known, and
		// costs nothing.
		if (cols.length <= maxIdx) return null;

		const page = Number(cols[pageIdx]);
		const widthPx = Number(cols[widthIdx]);
		const heightPx = Number(cols[heightIdx]);
		const xPpi = Number(cols[xPpiIdx]);
		const yPpi = Number(cols[yPpiIdx]);
		if (![page, widthPx, heightPx, xPpi, yPpi].every(Number.isFinite)) return null;

		// A non-positive x/y-ppi means poppler could not report a meaningful
		// on-page resolution for this image (a degenerate placement matrix, a
		// vector-painted mask). This row is KEPT rather than skipped: dropping
		// it resolves the ambiguity toward the cheap side, because a page whose
		// only other content is a full-page scan would then look like "exactly
		// one image" and get downscaled on the strength of evidence we just
		// threw away. Kept, it forces the page to the ceiling either way — as a
		// second row (rows.length !== 1) or, if it is the only row, because
		// widthPx/xPpi is then Infinity or negative and fails the full-page
		// match. That is the D5-safe direction.
		rows.push({ page, widthPx, heightPx, xPpi, yPpi });
	}
	return rows;
}

/**
 * Split `pdftotext <pdf> -` output into a per-page non-whitespace character
 * count. pdftotext (without -nopgbrk, which we never pass) separates pages
 * with a form-feed (\f) and emits a trailing one after the last page.
 * Returns null if the resulting page count doesn't match pageCount — a
 * mismatch means we can't trust which chunk belongs to which page, so the
 * whole PDF must fall back to 300 rather than mis-attribute text.
 */
export function parsePdfTextPages(
	output: string,
	pageCount: number,
): Map<number, number> | null {
	let chunks = output.split("\f");
	if (chunks.length > 0 && chunks[chunks.length - 1] === "") chunks = chunks.slice(0, -1);
	if (chunks.length !== pageCount) return null;

	const map = new Map<number, number>();
	chunks.forEach((chunk, index) => {
		map.set(index + 1, chunk.replace(/\s+/g, "").length);
	});
	return map;
}

/**
 * Parse per-page media box sizes out of `pdfinfo` output, keyed by 1-based
 * page number.
 *
 * Prefers the per-page form that `pdfinfo -f 1 -l <N>` emits (measured on
 * poppler 25.03, the version in console/Dockerfile's poppler-utils):
 *
 *     Page    1 size:  595 x 842 pts (A4)
 *     Page    1 rot:   0
 *
 * NOTE that the document-level `Page size:` line is NOT emitted when -f/-l are
 * given, and conversely the per-page lines are absent without them — so the
 * caller's pdfinfo invocation decides which branch runs here. The
 * document-level line is still accepted, and attributed to PAGE 1 ONLY, which
 * is all it ever actually described: it is page 1's MediaBox, not a
 * document-wide fact. Under that fallback pages 2..N simply have no proven
 * size and render at the ceiling, which is the D5-correct degradation.
 *
 * Returns an empty map when neither form is present; callers treat "no entry
 * for this page" as unproven.
 */
export function parsePageSizesPts(output: string): Map<number, PageSizePts> {
	const sizes = new Map<number, PageSizePts>();
	const lines = output.split(/\r?\n/);
	for (const raw of lines) {
		const match = raw.match(/^Page\s+(\d+)\s+size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/);
		if (!match) continue;
		const page = Number(match[1]);
		const widthPts = Number(match[2]);
		const heightPts = Number(match[3]);
		if (![page, widthPts, heightPts].every(Number.isFinite) || page < 1) continue;
		sizes.set(page, { widthPts, heightPts });
	}
	if (sizes.size > 0) return sizes;

	for (const raw of lines) {
		const match = raw.match(/^Page size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/);
		if (!match) continue;
		const widthPts = Number(match[1]);
		const heightPts = Number(match[2]);
		if (!Number.isFinite(widthPts) || !Number.isFinite(heightPts)) break;
		sizes.set(1, { widthPts, heightPts });
		break;
	}
	return sizes;
}

/**
 * The classification rule itself (pure, no I/O): for each page 1..pageCount,
 * decide a render DPI.
 *
 * A page renders below 300 ONLY when ALL of these hold:
 *   - pdfimages reports EXACTLY ONE image on that page (not zero, not many)
 *   - pdftotext reports ZERO non-whitespace characters on that page
 *   - THAT page's own size is known (see PageDpiInput.pageSizesPts — never
 *     another page's size), and that one image's rendered size (from its px
 *     dimensions and reported x-ppi/y-ppi) matches it within
 *     FULL_PAGE_TOLERANCE in both dimensions (i.e. it is a full-page image,
 *     not a stamp/logo)
 * Every other case — multiple images, a partial-page image, a vector/text
 * page, no image at all, a page whose own size was not reported, or any
 * upstream parse failure — renders at the caller's requested `maxDpi`. This is
 * deliberate per D5: ambiguity always resolves to the safe (expensive) choice,
 * which is exactly the DPI the caller would have used had this module not
 * existed.
 */
export function decidePageDpis(input: PageDpiInput): number[] {
	const { pageCount, images, textCharsByPage, pageSizesPts } = input;
	const ceiling = input.maxDpi ?? MAX_RENDER_DPI;
	const allDefault = new Array(pageCount).fill(ceiling);
	if (!images || !textCharsByPage || !pageSizesPts) return allDefault;

	const imagesByPage = new Map<number, ImageRow[]>();
	for (const row of images) {
		const bucket = imagesByPage.get(row.page);
		if (bucket) bucket.push(row);
		else imagesByPage.set(row.page, [row]);
	}

	const result: number[] = [];
	for (let page = 1; page <= pageCount; page++) {
		const rows = imagesByPage.get(page) ?? [];
		const chars = textCharsByPage.get(page);
		// This page's OWN size, never a neighbour's. Missing = unproven = ceiling.
		const size = pageSizesPts.get(page);

		if (rows.length !== 1 || chars === undefined || chars > 0 || !size) {
			result.push(ceiling);
			continue;
		}

		const image = rows[0];
		const renderedWidthPts = (image.widthPx / image.xPpi) * 72;
		const renderedHeightPts = (image.heightPx / image.yPpi) * 72;
		const widthMatches =
			Math.abs(renderedWidthPts - size.widthPts) <= size.widthPts * FULL_PAGE_TOLERANCE;
		const heightMatches =
			Math.abs(renderedHeightPts - size.heightPts) <= size.heightPts * FULL_PAGE_TOLERANCE;
		if (!widthMatches || !heightMatches) {
			result.push(ceiling);
			continue;
		}

		const nativePpi = Math.max(image.xPpi, image.yPpi);
		const rounded = Math.ceil(nativePpi / DPI_ROUND_STEP) * DPI_ROUND_STEP;
		// `ceiling` is applied LAST, after the MIN_RENDER_DPI floor, so a
		// caller asking for a DPI below the floor (--dpi 100) still gets what
		// it asked for rather than being silently raised to 150.
		result.push(Math.min(ceiling, Math.max(MIN_RENDER_DPI, rounded)));
	}
	return result;
}

/**
 * Convenience wrapper: parse the three raw command outputs and classify in one
 * call. `pdfInfoOutput` should come from `pdfinfo -f 1 -l <pageCount>` so each
 * page carries its own reported size — see parsePageSizesPts for what happens
 * when it doesn't.
 */
export function classifyPageDpis(opts: {
	pageCount: number;
	pdfImagesListOutput: string;
	pdfTextOutput: string;
	pdfInfoOutput: string;
	// See PageDpiInput.maxDpi — the caller's --dpi, used as ceiling + default.
	maxDpi?: number;
}): number[] {
	const images = parsePdfImagesList(opts.pdfImagesListOutput);
	const textCharsByPage = parsePdfTextPages(opts.pdfTextOutput, opts.pageCount);
	return decidePageDpis({
		pageCount: opts.pageCount,
		images,
		textCharsByPage,
		pageSizesPts: parsePageSizesPts(opts.pdfInfoOutput),
		maxDpi: opts.maxDpi,
	});
}

export type DpiRun = { dpi: number; startPage: number; endPage: number };

/**
 * Group a per-page DPI array into maximal CONTIGUOUS runs of the same DPI.
 * pdftoppm only accepts a contiguous -f/-l page range per invocation, so a
 * "tier" in practice is a contiguous run, not an arbitrary same-DPI subset
 * of the document — two separated runs at the same DPI become two
 * pdftoppm calls, which is still far fewer than one call per page.
 */
export function bucketIntoRuns(dpis: number[]): DpiRun[] {
	const runs: DpiRun[] = [];
	dpis.forEach((dpi, index) => {
		const page = index + 1;
		const last = runs[runs.length - 1];
		if (last && last.dpi === dpi && last.endPage === page - 1) last.endPage = page;
		else runs.push({ dpi, startPage: page, endPage: page });
	});
	return runs;
}
