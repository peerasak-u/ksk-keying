// Pure-function tests for the bank_statement review page (wayfinder ticket
// #41). Same describe/test + fixture-builder style as review-edit.test.ts /
// xlsx-preview.test.ts. computeIntegrityCheck/computeAccountSubtotals are the
// real substance of this ticket's ask, so they get thorough coverage; the
// render function gets a couple of smoke assertions only (full DOM/browser
// testing is the manual smoke test, not this file's job).
import { describe, expect, test } from "bun:test";
import { coaKey, coaLabel, type CoaRow } from "./coa";
import type { StatementEntry, StatementInfo, StatementRow } from "./review-data";
import { bucketExportUrl, computeAccountSubtotals, computeIntegrityCheck, renderBankStatementReviewPage } from "./bank-statement-review";

/** Extract a top-level `function <name>(...) { ... }` block's exact literal
 * source out of the rendered page HTML by brace-counting from the `function`
 * keyword to its matching close brace. Used to run the emitted client-side
 * script for real (contract-item-B mirror test) rather than diffing source
 * text against itself. */
function extractFunctionSource(html: string, name: string): string {
	const marker = `function ${name}(`;
	const start = html.indexOf(marker);
	if (start === -1) throw new Error(`function ${name} not found in emitted page`);
	const braceStart = html.indexOf("{", start);
	let depth = 0;
	let i = braceStart;
	for (; i < html.length; i++) {
		if (html[i] === "{") depth++;
		else if (html[i] === "}") {
			depth--;
			if (depth === 0) break;
		}
	}
	return html.slice(start, i + 1);
}

// --- fixture builders --------------------------------------------------

function coaRows(): CoaRow[] {
	return [
		{ account_code: "530301", sub_code: "", name_th: "ค่าไฟฟ้า", name_en: "Electricity" },
		{ account_code: "530301", sub_code: "01", name_th: "ค่าไฟฟ้า สาขา 1", name_en: "Electricity Branch 1" },
		{ account_code: "111301", sub_code: "", name_th: "เงินฝากออมทรัพย์", name_en: "Savings" },
		{ account_code: "999999", sub_code: "", name_th: "บัญชีพัก", name_en: "Suspense" },
	];
}

function statementInfo(overrides: Partial<StatementInfo> = {}): StatementInfo {
	return {
		bank: "Kasikornbank",
		account_no: "221-1-90947-4",
		account_holder: "บริษัท ทดสอบ จำกัด",
		period: "พฤษภาคม 2569",
		opening_balance: 1000,
		closing_balance: 1000,
		bank_account_code: null,
		bank_sub_code: null,
		...overrides,
	};
}

function statementRow(overrides: Partial<StatementRow> = {}): StatementRow {
	return {
		row_index: 0,
		date_iso: "2026-05-01",
		time: null,
		description: "โอนเงิน",
		counterparty: "X",
		direction: "out",
		amount: 100,
		balance: 900,
		account_code: "530301",
		sub_code: "",
		account_name_th: "ค่าไฟฟ้า",
		confidence: "high",
		reason: "matched",
		needs_review: false,
		skipped: false,
		...overrides,
	};
}

function statementEntry(overrides: Partial<StatementEntry> = {}): StatementEntry {
	return {
		schema: "ksk_review_statement_data.v1",
		group_id: "seg-001",
		label: "Kasikornbank — 221-1-90947-4",
		group_dir: "seg-001",
		statement: statementInfo(),
		source: { source_src: "statement.pdf", source_page: 1, source_sheet: null, image_src: null },
		rows: [statementRow()],
		...overrides,
	};
}

// --- computeIntegrityCheck -----------------------------------------------

describe("computeIntegrityCheck", () => {
	test("passes when opening + in - out equals closing exactly", () => {
		const statement = statementInfo({ opening_balance: 1000, closing_balance: 1300 });
		const rows = [statementRow({ direction: "in", amount: 500 }), statementRow({ direction: "out", amount: 200 })];
		const result = computeIntegrityCheck(statement, rows);
		expect(result.computed).toBe(1300);
		expect(result.diff).toBe(0);
		expect(result.ok).toBe(true);
	});

	test("fails when the computed total doesn't match the closing balance", () => {
		const statement = statementInfo({ opening_balance: 1000, closing_balance: 1250 });
		const rows = [statementRow({ direction: "in", amount: 500 }), statementRow({ direction: "out", amount: 200 })];
		const result = computeIntegrityCheck(statement, rows);
		expect(result.computed).toBe(1300);
		expect(result.diff).toBe(50);
		expect(result.ok).toBe(false);
	});

	test("tolerance boundary: a raw discrepancy of exactly 0.005 is NOT ok (rounds up to a full-cent 0.01 diff, and 0.01 >= 0.005)", () => {
		const statement = statementInfo({ opening_balance: 0, closing_balance: -0.005 });
		const rows: StatementRow[] = [];
		const result = computeIntegrityCheck(statement, rows);
		expect(result.diff).toBe(0.01);
		expect(result.ok).toBe(false);
	});

	test("tolerance boundary: a raw discrepancy just under 0.005 (0.004) rounds away to a 0 diff and is ok", () => {
		const statement = statementInfo({ opening_balance: 0, closing_balance: -0.004 });
		const rows: StatementRow[] = [];
		const result = computeIntegrityCheck(statement, rows);
		expect(result.diff).toBe(0);
		expect(result.ok).toBe(true);
	});

	test("runs over ALL rows passed in, regardless of any UI filter (no filtering happens inside this function)", () => {
		const statement = statementInfo({ opening_balance: 0, closing_balance: 800 });
		const rows = [
			statementRow({ direction: "in", amount: 1000, needs_review: true }),
			statementRow({ direction: "out", amount: 200, needs_review: false }),
		];
		const result = computeIntegrityCheck(statement, rows);
		expect(result.computed).toBe(800);
		expect(result.ok).toBe(true);
	});

	test("handles comma-formatted / string amounts via normalizeAmount semantics", () => {
		const statement = statementInfo({ opening_balance: "1,000" as unknown as number, closing_balance: 1500 });
		const rows = [statementRow({ direction: "in", amount: "500" as unknown as number })];
		const result = computeIntegrityCheck(statement, rows);
		expect(result.computed).toBe(1500);
		expect(result.ok).toBe(true);
	});

	test("empty rows: computed equals opening balance, ok when closing matches", () => {
		const statement = statementInfo({ opening_balance: 250, closing_balance: 250 });
		const result = computeIntegrityCheck(statement, []);
		expect(result.computed).toBe(250);
		expect(result.diff).toBe(0);
		expect(result.ok).toBe(true);
	});
});

// --- computeAccountSubtotals -----------------------------------------------

describe("computeAccountSubtotals", () => {
	test("groups rows by account_code+sub_code composite and sums directionally (in/out/net), not as a single direction-blind total", () => {
		const rows = [
			statementRow({ account_code: "530301", sub_code: "", amount: 100, direction: "out" }),
			statementRow({ account_code: "530301", sub_code: "", amount: 50, direction: "in" }),
		];
		const result = computeAccountSubtotals(rows, coaRows());
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ key: "530301||", inTotal: 50, outTotal: 100, net: -50 });
	});

	test("in-only rows: outTotal is 0, net equals inTotal", () => {
		const rows = [statementRow({ account_code: "111301", sub_code: "", amount: 30, direction: "in" }), statementRow({ account_code: "111301", sub_code: "", amount: 20, direction: "in" })];
		const result = computeAccountSubtotals(rows, coaRows());
		expect(result[0]).toMatchObject({ inTotal: 50, outTotal: 0, net: 50 });
	});

	test("out-only rows: inTotal is 0, net is negative", () => {
		const rows = [statementRow({ account_code: "111301", sub_code: "", amount: 30, direction: "out" }), statementRow({ account_code: "111301", sub_code: "", amount: 20, direction: "out" })];
		const result = computeAccountSubtotals(rows, coaRows());
		expect(result[0]).toMatchObject({ inTotal: 0, outTotal: 50, net: -50 });
	});

	test("rounds each of inTotal/outTotal/net to 2 decimals independently, avoiding float drift", () => {
		const rows = [
			statementRow({ account_code: "111301", sub_code: "", amount: 0.1, direction: "in" }),
			statementRow({ account_code: "111301", sub_code: "", amount: 0.2, direction: "in" }),
			statementRow({ account_code: "111301", sub_code: "", amount: 0.1, direction: "out" }),
		];
		const result = computeAccountSubtotals(rows, coaRows());
		expect(result[0]).toMatchObject({ inTotal: 0.3, outTotal: 0.1, net: 0.2 });
	});

	test("two rows with the same account_code but different sub_code do NOT merge", () => {
		const rows = [
			statementRow({ account_code: "530301", sub_code: "", amount: 100, direction: "out" }),
			statementRow({ account_code: "530301", sub_code: "01", amount: 200, direction: "out" }),
		];
		const result = computeAccountSubtotals(rows, coaRows());
		expect(result).toHaveLength(2);
		const byKey = Object.fromEntries(result.map((r) => [r.key, r]));
		expect(byKey["530301||"].outTotal).toBe(100);
		expect(byKey["530301||01"].outTotal).toBe(200);
		expect(byKey["530301||"].label).toBe("530301 ค่าไฟฟ้า");
		expect(byKey["530301||01"].label).toBe("530301-01 ค่าไฟฟ้า สาขา 1");
	});

	test("skips a row with no account_code (empty string)", () => {
		const rows = [statementRow({ account_code: "", sub_code: "" }), statementRow({ account_code: "111301", sub_code: "", amount: 40, direction: "in" })];
		const result = computeAccountSubtotals(rows, coaRows());
		expect(result).toHaveLength(1);
		expect(result[0].key).toBe("111301||");
	});

	test("falls back to the raw key as the label when the account isn't found in coaRows", () => {
		const rows = [statementRow({ account_code: "000000", sub_code: "", amount: 75, direction: "in" })];
		const result = computeAccountSubtotals(rows, coaRows());
		expect(result).toEqual([{ key: "000000||", label: "000000||", inTotal: 75, outTotal: 0, net: 75 }]);
	});

	test("empty rows produce an empty result", () => {
		expect(computeAccountSubtotals([], coaRows())).toEqual([]);
	});

	test("preserves first-encountered order of distinct account keys", () => {
		const rows = [
			statementRow({ account_code: "111301", sub_code: "", amount: 10, direction: "in" }),
			statementRow({ account_code: "530301", sub_code: "", amount: 20, direction: "in" }),
			statementRow({ account_code: "111301", sub_code: "", amount: 5, direction: "in" }),
		];
		const result = computeAccountSubtotals(rows, coaRows());
		expect(result.map((r) => r.key)).toEqual(["111301||", "530301||"]);
		expect(result[0].net).toBe(15);
	});
});

// --- bucketExportUrl -----------------------------------------------------

describe("bucketExportUrl", () => {
	test("builds the bank_statement export route", () => {
		expect(bucketExportUrl("client-a", "2026-04")).toBe("/api/export/client-a/2026-04/bank_statement");
	});

	test("encodes clientId/monthId", () => {
		expect(bucketExportUrl("ลูกค้า A/B", "2026-04")).toBe(`/api/export/${encodeURIComponent("ลูกค้า A/B")}/2026-04/bank_statement`);
	});
});

// --- renderBankStatementReviewPage (smoke tests) ---------------------------

describe("renderBankStatementReviewPage", () => {
	test("renders the company name, statement label, and a known metadata value", async () => {
		const html = await renderBankStatementReviewPage("/tmp/does-not-matter", {
			clientId: "216",
			monthId: "เดือนพฤษภาคม",
			companyName: "บริษัท ทดสอบ จำกัด",
			coaRows: coaRows(),
			guard: { disabled: false, message: null },
			statements: [statementEntry()],
		});
		expect(html).toContain("บริษัท ทดสอบ จำกัด");
		expect(html).toContain("Kasikornbank — 221-1-90947-4");
		expect(html).toContain("221-1-90947-4");
	});

	test("shows the empty-state message when there are no statements", async () => {
		const html = await renderBankStatementReviewPage("/tmp/does-not-matter", {
			clientId: "216",
			monthId: "เดือนพฤษภาคม",
			companyName: null,
			coaRows: coaRows(),
			guard: { disabled: false, message: null },
			statements: [],
		});
		expect(html).toContain("ไม่มีข้อมูลบัญชีธนาคารสำหรับเดือนนี้");
	});

	test("shows the guard banner message when the run is disabled", async () => {
		const html = await renderBankStatementReviewPage("/tmp/does-not-matter", {
			clientId: "216",
			monthId: "เดือนพฤษภาคม",
			companyName: null,
			coaRows: coaRows(),
			guard: { disabled: true, message: "กำลังประมวลผลอยู่" },
			statements: [statementEntry()],
		});
		expect(html).toContain("guard-banner");
		expect(html).toContain("กำลังประมวลผลอยู่");
		expect(html).toContain("disabled");
	});

	test("renders the integrity banner as ok/not-ok based on computeIntegrityCheck", async () => {
		const okHtml = await renderBankStatementReviewPage("/tmp/does-not-matter", {
			clientId: "216",
			monthId: "m",
			companyName: null,
			coaRows: coaRows(),
			guard: { disabled: false, message: null },
			statements: [statementEntry({ statement: statementInfo({ opening_balance: 1000, closing_balance: 900 }), rows: [statementRow({ direction: "out", amount: 100 })] })],
		});
		expect(okHtml).toContain("integrity-ok");

		const badHtml = await renderBankStatementReviewPage("/tmp/does-not-matter", {
			clientId: "216",
			monthId: "m",
			companyName: null,
			coaRows: coaRows(),
			guard: { disabled: false, message: null },
			statements: [statementEntry({ statement: statementInfo({ opening_balance: 1000, closing_balance: 999999 }), rows: [statementRow({ direction: "out", amount: 100 })] })],
		});
		expect(badHtml).toContain("integrity-bad");
	});

	test("escapes untrusted Thai text (counterparty) rather than injecting it raw", async () => {
		const html = await renderBankStatementReviewPage("/tmp/does-not-matter", {
			clientId: "216",
			monthId: "m",
			companyName: null,
			coaRows: coaRows(),
			guard: { disabled: false, message: null },
			statements: [statementEntry({ rows: [statementRow({ counterparty: '<script>alert(1)</script>' })] })],
		});
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
	});

	test("renders the per-account subtotal as a three-column เงินเข้า/เงินออก/สุทธิ table with the directional totals, in that column order", async () => {
		const html = await renderBankStatementReviewPage("/tmp/does-not-matter", {
			clientId: "216",
			monthId: "m",
			companyName: null,
			coaRows: coaRows(),
			guard: { disabled: false, message: null },
			statements: [
				statementEntry({
					rows: [statementRow({ account_code: "530301", sub_code: "", amount: 100, direction: "out" }), statementRow({ account_code: "530301", sub_code: "", amount: 40, direction: "in" })],
				}),
			],
		});
		expect(html).toContain("<th>เงินเข้า</th><th>เงินออก</th><th>สุทธิ</th>");
		// Pin the whole row as one string so an in/out column swap (both values
		// present, wrong column) is caught, not just "both numbers appear somewhere".
		expect(html).toContain(
			'<tr><td>530301 ค่าไฟฟ้า</td><td class="subtotal-amount">40.00 บาท</td><td class="subtotal-amount">100.00 บาท</td><td class="subtotal-amount">-60.00 บาท</td></tr>',
		);
	});

	test("recomputeSubtotals in the emitted script, run against a stub DOM, agrees with computeAccountSubtotals to the row markup", async () => {
		const rows = [
			statementRow({ account_code: "530301", sub_code: "", account_name_th: "ค่าไฟฟ้า", amount: 100, direction: "out" }),
			statementRow({ account_code: "530301", sub_code: "", account_name_th: "ค่าไฟฟ้า", amount: 40, direction: "in" }),
			statementRow({ account_code: "111301", sub_code: "", account_name_th: "เงินฝากออมทรัพย์", amount: 9950, direction: "in" }),
		];
		const html = await renderBankStatementReviewPage("/tmp/does-not-matter", {
			clientId: "216",
			monthId: "m",
			companyName: null,
			coaRows: coaRows(),
			guard: { disabled: false, message: null },
			statements: [statementEntry({ rows })],
		});

		// Extract the literal recomputeSubtotals/escapeHtmlJs/formatBahtJs source
		// as emitted in the page (not a hand-copy) and run it for real against a
		// minimal stub DOM built from the same row fixtures used above, so this
		// test actually exercises client/server agreement rather than diffing
		// source text against itself.
		const recomputeSrc = extractFunctionSource(html, "recomputeSubtotals");
		const escapeSrc = extractFunctionSource(html, "escapeHtmlJs");
		const formatSrc = extractFunctionSource(html, "formatBahtJs");

		const tbody = { innerHTML: "" };
		const trStubs = rows.map((r) => ({
			getAttribute: (name: string) => (name === "data-direction" ? r.direction : null),
			querySelector: (sel: string) => {
				if (sel === ".row-account-select") {
					const coaRow = coaRows().find((c) => coaKey(c) === coaKey({ account_code: r.account_code, sub_code: r.sub_code }));
					const key = coaKey({ account_code: r.account_code, sub_code: r.sub_code });
					return { value: key, options: [{ text: coaRow ? coaLabel(coaRow) : key }], selectedIndex: 0 };
				}
				if (sel === ".row-amount-input") return { value: String(r.amount) };
				return null;
			},
		}));
		const stubDocument = {
			querySelectorAll: (_sel: string) => trStubs,
			getElementById: (id: string) => (id === "subtotal-0" ? tbody : null),
		};

		const runner = new Function(
			"document",
			`${escapeSrc}\n${formatSrc}\n${recomputeSrc}\nrecomputeSubtotals(0);`,
		);
		runner(stubDocument);

		const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " บาท";
		const expected = computeAccountSubtotals(rows, coaRows());
		const expectedHtml = expected
			.map((s) => `<tr><td>${s.label}</td><td class="subtotal-amount">${fmt(s.inTotal)}</td><td class="subtotal-amount">${fmt(s.outTotal)}</td><td class="subtotal-amount">${fmt(s.net)}</td></tr>`)
			.join("");
		expect(tbody.innerHTML).toBe(expectedHtml);
	});

	test("renders nothing (no flags-strip) when review_flags and questions_for_user are both absent/empty", async () => {
		const html = await renderBankStatementReviewPage("/tmp/does-not-matter", { clientId: "216", monthId: "m", companyName: null, coaRows: coaRows(), guard: { disabled: false, message: null }, statements: [statementEntry()] });
		expect(html).not.toContain('class="flags-strip"');
	});

	test("renders review_flags as warnings and questions_for_user as questions, visually distinguished, when present", async () => {
		const html = await renderBankStatementReviewPage("/tmp/does-not-matter", {
			clientId: "216",
			monthId: "m",
			companyName: null,
			coaRows: coaRows(),
			guard: { disabled: false, message: null },
			statements: [
				statementEntry({
					review_flags: ["สเตทเมนต์คาบ 2 เดือนปฏิทิน เสี่ยงลงบัญชีซ้ำ"],
					questions_for_user: ["รายการโอนเข้า +9,950.00 คือรายการอะไร"],
				}),
			],
		});
		// Bind class to content, the same way the negative test above proves
		// absence — .flags-strip/.flags-box/.flags-warning/.flags-question also
		// appear unconditionally in the page's <style> block, so a bare
		// toContain("flags-warning") passes even on an empty page; only pinning
		// the class attribute to the rendered <ul> proves the two kinds are
		// actually rendered, in separate boxes, with the right class each.
		expect(html).toContain('class="flags-strip"');
		expect(html).toContain(
			'<div class="flags-box flags-warning"><div class="meta-label">⚠ ข้อควรระวัง</div><ul><li>สเตทเมนต์คาบ 2 เดือนปฏิทิน เสี่ยงลงบัญชีซ้ำ</li></ul></div>',
		);
		expect(html).toContain(
			'<div class="flags-box flags-question"><div class="meta-label">❓ คำถามที่ต้องตอบ</div><ul><li>รายการโอนเข้า +9,950.00 คือรายการอะไร</li></ul></div>',
		);
	});

	test("escapes review_flags/questions_for_user text (untrusted Thai from the interpretation)", async () => {
		const html = await renderBankStatementReviewPage("/tmp/does-not-matter", {
			clientId: "216",
			monthId: "m",
			companyName: null,
			coaRows: coaRows(),
			guard: { disabled: false, message: null },
			statements: [statementEntry({ review_flags: ["<script>alert(1)</script>"] })],
		});
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
	});

	test("shows a placeholder when the statement source has no source_src", async () => {
		const html = await renderBankStatementReviewPage("/tmp/does-not-matter", {
			clientId: "216",
			monthId: "m",
			companyName: null,
			coaRows: coaRows(),
			guard: { disabled: false, message: null },
			statements: [statementEntry({ source: { source_src: null, source_page: null, source_sheet: null, image_src: null } })],
		});
		expect(html).toContain("ไม่มีเอกสารต้นทางสำหรับบัญชีนี้");
	});
});

// --- split layout + PDF.js viewer ------------------------------------------
// The layout decision (preview pinned left, work column scrolling right) and
// the move off the native <embed>; both came out of the prototype in this
// file's module header.

describe("renderBankStatementReviewPage — split layout", () => {
	const render = (over: Partial<Parameters<typeof renderBankStatementReviewPage>[1]> = {}) =>
		renderBankStatementReviewPage("/tmp/does-not-matter", {
			clientId: "216",
			monthId: "เดือนพฤษภาคม",
			companyName: null,
			coaRows: coaRows(),
			guard: { disabled: false, message: null },
			statements: [statementEntry()],
			...over,
		});

	test("a PDF-sourced statement gets the PDF.js stage, never a server-rendered <embed>", async () => {
		const html = await render();
		expect(html).toContain('<script src="/public/vendor/pdf.min.js">');
		expect(html).toContain('<div class="pdf-scroll" id="pdfScroll">');
		// The only embed left is the one JS builds at runtime when PDF.js fails
		// to load at all — nothing embeds a PDF at render time.
		expect(html).not.toContain("<embed ");
		expect(html).not.toContain("pdf-embed");
	});

	test("the preview column sits outside the per-statement panels, so one viewer serves them all", async () => {
		const html = await render({ statements: [statementEntry(), statementEntry({ group_id: "seg-002", group_dir: "seg-002", label: "SCB" })] });
		expect(html.match(/id="pdfScroll"/g)?.length).toBe(1);
		expect(html.match(/class="stmt-panel"|class="stmt-panel" /g)?.length ?? html.match(/stmt-panel/g)!.length).toBeGreaterThanOrEqual(2);
		expect(html.indexOf('class="preview-col"')).toBeLessThan(html.indexOf('class="work-col"'));
	});

	test("PREVIEWS carries one entry per statement, kind-tagged, and pdf pages are 1-based", async () => {
		const html = await render({
			statements: [
				statementEntry(),
				statementEntry({ group_dir: "seg-002", source: { source_src: "book.xlsx", source_page: null, source_sheet: "Sheet1", image_src: null } }),
			],
		});
		const match = html.match(/var PREVIEWS = (\[.*?\]);/s);
		expect(match).not.toBeNull();
		const previews = JSON.parse(match![1]);
		expect(previews).toEqual([
			{ kind: "pdf", src: "/files/216/%E0%B9%80%E0%B8%94%E0%B8%B7%E0%B8%AD%E0%B8%99%E0%B8%9E%E0%B8%A4%E0%B8%A9%E0%B8%A0%E0%B8%B2%E0%B8%84%E0%B8%A1/statement.pdf", page: 1 },
			{ kind: "static", src: null, page: 1 },
		]);
	});

	test("a source filename cannot close the inline <script> that carries PREVIEWS", async () => {
		const html = await render({ statements: [statementEntry({ source: { source_src: "</script><script>alert(1)</script>x.pdf", source_page: 1, source_sheet: null, image_src: null } })] });
		// Two independent guards: fileUrl percent-encodes the name, and the
		// serialized PREVIEWS blob escapes any "<" that survives anyway.
		expect(html).not.toContain("</script><script>alert(1)");
		expect(html).toContain("%3C%2Fscript%3E");
		expect(html.match(/var PREVIEWS = (\[.*?\]);/s)![1]).not.toContain("<");
	});

	test("lazy rendering keys off build, not the navigation token, and releases its claim on every bail-out", async () => {
		const html = await render();
		expect(html).toContain("renderPdfPage(Number(entry.target.dataset.page), build)");
		expect(html).toContain("async function renderPdfPage(num, build)");
		expect(html).toContain("var build = ++pdfView.build;");
		expect(html.match(/pdfView\.rendered\[num\] = false;/g)?.length).toBe(2);
	});

	test("the row counter reports how much a filter is hiding", async () => {
		const html = await render();
		expect(html).toContain('id="row-counter-0"');
		expect(html).toContain('counter.textContent = "แสดง " + shown + " / " + rows.length + " รายการ";');
	});
});
