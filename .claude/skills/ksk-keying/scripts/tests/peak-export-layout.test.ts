import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { renderReviewHtml, type ReviewData } from "../review-template";

// The export sheets are the pipeline's only outward-facing artifact: a column in
// the wrong position is silently accepted by PEAK and lands as wrong accounting
// data. The header constants in review-template.ts are therefore only correct
// insofar as they still match PEAK's own workbooks, so this suite reads the real
// templates instead of restating their layout (a restatement would have agreed
// with a wrong constant just as happily).
//
// samples/ is gitignored, so a checkout without it skips rather than fails.
// tests → scripts → ksk-keying → skills → .claude → repo root
const EXPORT_DIR = join(import.meta.dir, "..", "..", "..", "..", "..", "samples", "export-file");
const haveTemplates = existsSync(EXPORT_DIR);
const describeIf = haveTemplates ? describe : describe.skip;

/** Header row of a sheet in one of PEAK's own template workbooks. */
function templateHeaders(file: string, sheet: string): string[] {
	const wb = XLSX.readFile(join(EXPORT_DIR, file));
	const ws = wb.Sheets[sheet];
	if (!ws) throw new Error(`no sheet "${sheet}" in ${file}; has ${JSON.stringify(wb.SheetNames)}`);
	const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
	return (rows[0] ?? []).map((c) => String(c).trim());
}

// PEAK's headers carry "(ถ้ามี)" optionality hints that we deliberately drop —
// the import reads by position, not by label. Everything else must match.
const normalize = (s: string) => s.replace(/\s*\(ถ้ามี\)\s*/g, "").replace(/\s+/g, " ").trim();

function page(facts: Record<string, string | number | null>, accountCode: string) {
	return {
		ref: "probe:1",
		short_ref: "PROBE",
		image_src: null,
		extract_path: "x.json",
		categorize_path: "y.json",
		facts,
		lines: [
			{
				line_index: 0,
				description: "รายการทดสอบ",
				qty: 1,
				unit: null,
				unit_price: 1000,
				amount: 1000,
				amount_includes_vat: false,
				vat_treatment: "vat_7" as const,
				account_code: accountCode,
				sub_code: "",
				account_name_th: "ทดสอบ",
				confidence: "high" as const,
				reason: "probe",
				needs_review: false,
			},
		],
		initial_status: "reviewed" as const,
	};
}

const FACTS = {
	date: "2026-02-04",
	seller: "บริษัท ผู้ขาย จำกัด",
	seller_tax_id: "1111111111111",
	buyer: "บริษัท ผู้ซื้อ จำกัด",
	buyer_tax_id: "2222222222222",
	document_no: "DOC-001",
	vat_treatment: "vat_7",
	subtotal: 1000,
	vat: 70,
	total: 1070,
	wht: 30,
};

function reviewData(group: string, accountCode: string): ReviewData {
	return {
		schema: "ksk_review_group_html_data.v1",
		kind: "documents",
		client_dir: "/probe",
		client_key: "probe",
		group,
		group_dir: "/probe/g",
		review_label: "probe",
		generated_at: "2026-01-01T00:00:00.000Z",
		content_fingerprint: "probe",
		coa_csv: "coa.csv",
		coa_rows: [{ account_code: accountCode, sub_code: "", name_th: "ทดสอบ", name_en: "Probe" }],
		pages: [page(FACTS, accountCode)],
	};
}

/**
 * Runs the page's real inline app: stubs Vue.createApp to capture the options
 * object, then rebuilds `this` from the app's own data()/methods/computed. This
 * exercises the exact code the browser runs — the builder lives inside the HTML
 * template literal and cannot be imported.
 */
function loadApp(data: ReviewData) {
	const html = renderReviewHtml(data);
	const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
	const appScript = inline.at(-1);
	if (!appScript?.includes("Vue.createApp")) throw new Error("could not find the app script");

	const blob = html.match(/<script[^>]*id=["']reviewData["'][^>]*>([\s\S]*?)<\/script>/i);
	if (!blob) throw new Error("could not find the reviewData blob");
	const reviewDataText = blob[1].replaceAll("<\\/", "</");

	let captured: any = null;
	// The mount statement may carry an assignment prefix (window.__KSK_REVIEW__ = …),
	// so strip the whole statement, not just the call.
	const body = appScript
		.replace(/^.*\bapp\.mount\('#app'\);.*$/m, "")
		.replace(/const app = Vue\.createApp\(/, "__capture(");
	if (body.includes("app.mount")) throw new Error("failed to strip the app.mount statement");
	const fn = new Function(
		"Vue",
		"window",
		"document",
		"localStorage",
		"__capture",
		`${body}\n; return { peakTemplateForGroup, PEAK_EXPENSE_HEADERS, PEAK_REVENUE_HEADERS, STATEMENT_JOURNAL_HEADERS };`,
	);
	const internals = fn(
		{ createApp: () => ({ mount() {}, use() {} }) },
		{},
		{
			addEventListener() {},
			querySelector: () => null,
			getElementById: (id: string) => (id === "reviewData" ? { textContent: reviewDataText } : null),
		},
		{ getItem: () => null, setItem() {}, removeItem() {} },
		(opts: any) => {
			captured = opts;
			return { mount() {}, use() {} };
		},
	);
	if (!captured) throw new Error("did not capture the app options");

	const vm: any = { ...captured.data() };
	for (const [k, v] of Object.entries(captured.methods)) vm[k] = (v as any).bind(vm);
	for (const [k, v] of Object.entries(captured.computed ?? {})) {
		Object.defineProperty(vm, k, { get: (v as any).bind(vm), configurable: true });
	}
	vm.states.forEach((s: any) => {
		s.committed = true;
		s.skipped = false;
	});
	return { vm, ...internals };
}

/** The export preview is exactly what downloadExportXlsx writes to the workbook. */
function preview(group: string, accountCode: string) {
	const app = loadApp(reviewData(group, accountCode));
	const template = app.peakTemplateForGroup(group);
	if (!template) throw new Error(`no PEAK template for bucket "${group}"`);
	return { template, preview: app.vm.buildExportPreview(template), app };
}

describeIf("PEAK export layout matches PEAK's own templates", () => {
	const CASES = [
		{ label: "expense", constName: "PEAK_EXPENSE_HEADERS", file: "PEAK_ImportExpense.xlsx", sheet: "Import_Expenses" },
		{ label: "revenue", constName: "PEAK_REVENUE_HEADERS", file: "PEAK_ImportReceipt.xlsx", sheet: "Import_Receipt" },
		{
			label: "statement journal",
			constName: "STATEMENT_JOURNAL_HEADERS",
			file: "PEAK_ImportJournal.xlsx",
			sheet: "Import Multiple Journal",
		},
	] as const;

	for (const c of CASES) {
		test(`${c.label} headers match ${c.file} column for column`, () => {
			const app = loadApp(reviewData("expense/vat", "520101"));
			const ours: string[] = (app as any)[c.constName];
			expect(ours.map(normalize)).toEqual(templateHeaders(c.file, c.sheet).map(normalize));
		});
	}

	test("expense sheet name and row width match the template", () => {
		const { template, preview: p } = preview("expense/vat", "520101");
		expect(template.sheet_name).toBe("Import_Expenses");
		expect(p.headers).toHaveLength(21);
		expect(p.rows.length).toBeGreaterThan(0);
		for (const row of p.rows) expect(row.cells).toHaveLength(p.headers.length);
	});

	test("revenue sheet name and row width match the template", () => {
		const { template, preview: p } = preview("income/vat", "410101");
		expect(template.sheet_name).toBe("Import_Receipt");
		expect(p.headers).toHaveLength(20);
		expect(p.rows.length).toBeGreaterThan(0);
		for (const row of p.rows) expect(row.cells).toHaveLength(p.headers.length);
	});

	// The 13-digit column holds the COUNTERPARTY, which flips with direction: the
	// client is the buyer on an expense and the seller on a revenue document, so
	// keying seller_tax_id on both sheets would file the client as its own
	// counterparty on every income row.
	test("the 13-digit column keys the counterparty, not the client", () => {
		const expense = preview("expense/vat", "520101").preview;
		const expenseTaxIdCol = expense.headers.indexOf("เลขทะเบียน 13 หลัก");
		expect(expense.rows[0].cells[expenseTaxIdCol]).toBe(FACTS.seller_tax_id);

		const revenue = preview("income/vat", "410101").preview;
		const revenueTaxIdCol = revenue.headers.indexOf("เลขทะเบียน 13 หลัก");
		expect(revenue.rows[0].cells[revenueTaxIdCol]).toBe(FACTS.buyer_tax_id);
	});

	// The two sheets do not share a column order, so preview indices copied from
	// one to the other point at unrelated columns.
	test("preview column indices stay inside their sheet", () => {
		for (const [group, account] of [
			["expense/vat", "520101"],
			["income/vat", "410101"],
		] as const) {
			const p = preview(group, account).preview;
			for (const col of p.preview_columns) {
				expect(col.index).toBeLessThan(p.headers.length);
			}
		}
	});
});

if (!haveTemplates) {
	test.skip(`PEAK templates not present at ${EXPORT_DIR} — layout checks skipped`, () => {});
}
