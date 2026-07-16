// Reference-report totals cross-check (Decision Policy rule 9 / SKILL.md
// Completion-check item 4), made deterministic instead of relying on the
// orchestrator to remember to dispatch a bounded child for it.
//
// A `reference_report` exclusion (a sales/purchase-VAT report, a settlement
// summary, ...) is never a booking source — its rows are not interpreted or
// linked. But if a report's rows have no corresponding booked document
// *anywhere* in the client's output, that money never got keyed at all, and
// the exclusion silently ate real transactions instead of just avoiding a
// double-count. This script sums each excluded report's own rows, checks
// which of them (by tax_id or document-number token) appear anywhere in the
// client's booked segment/doc-group facts, and surfaces the gap.
//
// This check never edits facts and never blocks a gate — a mismatch is
// evidence for a human, per SKILL.md ("Match or mismatch is reported to the
// human as evidence; a mismatch is a review point, never an automatic change
// to facts"). It is additive to `ledger --gate final`, not a replacement.
//
// Usage: bun run reference-report-check.ts -- <client-dir>

import { basename, dirname, extname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { readFile as readXlsxFile, utils as xlsxUtils } from "xlsx";
import { pagesDir, segmentsDir, docGroupsDir } from "./paths";

const SCHEMA = "ksk_reference_report_check.v1";
const LIST_CAP = 50;

const TAXID_RE = /\b\d{13}\b/g;
const AMOUNT_HEADER_RE = /(ยอดสุทธิ|สุทธิ|จำนวนเงิน|ยอดรวม|net|total|amount)/i;

type Args = { clientDir: string };

function parseArgs(argv: string[]): Args {
	const rest = argv.slice(2);
	const dashDash = rest.indexOf("--");
	const positional = dashDash >= 0 ? rest.slice(dashDash + 1) : rest;
	if (positional.length < 1) {
		console.error("Usage: bun run reference-report-check.ts -- <client-dir>");
		process.exit(2);
	}
	return { clientDir: resolve(positional[0]) };
}

type DispositionEntry = {
	file: string;
	page: number | null;
	sheet: string | null;
	disposition: "used" | "excluded";
	reason?: string;
};

function loadDispositions(clientDir: string): DispositionEntry[] {
	const p = join(pagesDir(clientDir), "dispositions.yaml");
	if (!existsSync(p)) return [];
	const doc = yamlParse(readFileSync(p, "utf8")) as { entries?: DispositionEntry[] } | null;
	return doc?.entries ?? [];
}

// Fragments (per-segment) may also carry `excluded` / `reference_report`
// entries the parent hasn't merged into dispositions.yaml yet.
function loadFragmentExclusions(clientDir: string): DispositionEntry[] {
	const dir = join(pagesDir(clientDir), "fragments");
	if (!existsSync(dir)) return [];
	const out: DispositionEntry[] = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".yaml")) continue;
		try {
			const doc = yamlParse(readFileSync(join(dir, f), "utf8")) as
				| { entries?: DispositionEntry[] }
				| DispositionEntry[]
				| null;
			const entries = Array.isArray(doc) ? doc : (doc?.entries ?? []);
			out.push(...entries);
		} catch {
			// malformed fragment — ledger's own gates already surface this; skip here
		}
	}
	return out;
}

type BookedFact = {
	document_no: string | null;
	seller_tax_id: string | null;
	buyer_tax_id: string | null;
	gross_total: number | null;
	source: string; // where this fact came from, for debugging
};

function normDocNo(s: string | null | undefined): string | null {
	if (!s) return null;
	return String(s).replace(/[\s\-/]/g, "").toUpperCase();
}

function walkJsonFiles(dir: string, name: string): string[] {
	const out: string[] = [];
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkJsonFiles(p, name));
		else if (entry.isFile() && entry.name === name) out.push(p);
	}
	return out;
}

// Collect every booked fact from segment interpretations (documents[].facts /
// accounting_facts) and doc-group interpretations (facts) — both directions,
// both schemas seen across stages.
function loadBookedFacts(clientDir: string): BookedFact[] {
	const out: BookedFact[] = [];

	for (const f of walkJsonFiles(segmentsDir(clientDir), "interpretation.json")) {
		let data: any;
		try {
			data = JSON.parse(readFileSync(f, "utf8"));
		} catch {
			continue;
		}
		const docs = Array.isArray(data.documents) ? data.documents : [];
		for (const doc of docs) {
			const facts = doc.accounting_facts ?? doc.facts;
			if (!facts) continue;
			out.push({
				document_no: normDocNo(facts.document_no),
				seller_tax_id: facts.seller_tax_id ?? null,
				buyer_tax_id: facts.buyer_tax_id ?? null,
				gross_total: typeof facts.gross_total === "number" ? facts.gross_total : null,
				source: f,
			});
		}
		// top-level facts (single-document segments) alongside per-document ones
		if (data.accounting_facts) {
			const facts = data.accounting_facts;
			out.push({
				document_no: normDocNo(facts.document_no),
				seller_tax_id: facts.seller_tax_id ?? null,
				buyer_tax_id: facts.buyer_tax_id ?? null,
				gross_total: typeof facts.gross_total === "number" ? facts.gross_total : null,
				source: f,
			});
		}
	}

	for (const f of walkJsonFiles(docGroupsDir(clientDir), "interpretation.json")) {
		let data: any;
		try {
			data = JSON.parse(readFileSync(f, "utf8"));
		} catch {
			continue;
		}
		const facts = data.facts;
		if (!facts) continue;
		out.push({
			document_no: normDocNo(facts.document_no),
			seller_tax_id: facts.seller_tax_id ?? null,
			buyer_tax_id: facts.buyer_tax_id ?? null,
			gross_total: typeof facts.gross_total === "number" ? facts.gross_total : null,
			source: f,
		});
	}

	return out;
}

type ReportRow = {
	rowIndex: number;
	taxIds: string[];
	docNoTokens: string[];
	amount: number | null;
};

type ReportExtraction = {
	file: string;
	sheet: string;
	rows: ReportRow[];
	amountColumnHeader: string | null;
	amountConfidence: "high" | "low";
};

// Heuristic single-sheet extraction: find the header row (first row with >=2
// non-empty string cells), pick the rightmost column whose header matches an
// amount-like keyword as the row amount, and collect every 13-digit run and
// every alphanumeric-with-digit token (candidate document numbers) from the
// row's string cells as join keys.
function extractReportSheet(filePath: string, sheetName: string, sheet: any): ReportExtraction {
	const rows: any[][] = xlsxUtils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
	let headerRowIdx = -1;
	let headers: string[] = [];
	for (let i = 0; i < Math.min(rows.length, 10); i++) {
		const row = rows[i] ?? [];
		const strCells = row.filter((c) => typeof c === "string" && c.trim().length > 0);
		if (strCells.length >= 2) {
			headerRowIdx = i;
			headers = row.map((c) => (typeof c === "string" ? c : ""));
			break;
		}
	}

	let amountColIdx = -1;
	let amountColumnHeader: string | null = null;
	if (headerRowIdx >= 0) {
		for (let c = headers.length - 1; c >= 0; c--) {
			if (AMOUNT_HEADER_RE.test(headers[c] ?? "")) {
				amountColIdx = c;
				amountColumnHeader = headers[c];
				break;
			}
		}
	}

	const dataRows = headerRowIdx >= 0 ? rows.slice(headerRowIdx + 1) : rows;
	const extracted: ReportRow[] = [];
	let amountConfidence: "high" | "low" = amountColIdx >= 0 ? "high" : "low";

	for (let i = 0; i < dataRows.length; i++) {
		const row = dataRows[i] ?? [];
		if (row.every((c) => c === null || c === undefined || c === "")) continue;

		const taxIds = new Set<string>();
		const docNoTokens = new Set<string>();
		for (const cell of row) {
			if (typeof cell === "string") {
				for (const m of cell.matchAll(TAXID_RE)) taxIds.add(m[0]);
				const trimmed = cell.trim();
				// candidate document-number token: has both a letter/digit mix or
				// length >= 5 with a digit, and isn't itself a bare 13-digit tax id
				if (trimmed.length >= 5 && /\d/.test(trimmed) && !/^\d{13}$/.test(trimmed)) {
					docNoTokens.add(normDocNo(trimmed) ?? trimmed);
				}
			} else if (typeof cell === "number" && String(cell).length === 13) {
				taxIds.add(String(cell));
			}
		}

		let amount: number | null = null;
		if (amountColIdx >= 0 && typeof row[amountColIdx] === "number") {
			amount = row[amountColIdx] as number;
		} else {
			// fallback: largest numeric cell in the row is our best guess at "the
			// amount" — flagged low-confidence so a human knows to verify the file
			const nums = row.filter((c) => typeof c === "number") as number[];
			if (nums.length > 0) amount = Math.max(...nums);
		}

		if (taxIds.size === 0 && docNoTokens.size === 0 && amount === null) continue;
		extracted.push({
			rowIndex: headerRowIdx + 2 + i, // 1-based, +1 for header row itself
			taxIds: [...taxIds],
			docNoTokens: [...docNoTokens],
			amount,
		});
	}

	return { file: filePath, sheet: sheetName, rows: extracted, amountColumnHeader, amountConfidence };
}

function loadReportExtractions(clientDir: string, relFile: string): ReportExtraction[] | { skipped: string } {
	const abs = join(clientDir, relFile);
	if (!existsSync(abs)) return { skipped: `file not found on disk: ${relFile}` };
	const ext = extname(abs).toLowerCase();
	if (ext !== ".xlsx" && ext !== ".xls") {
		return { skipped: `unsupported for auto-totals (not a spreadsheet): ${relFile} — needs manual human cross-check` };
	}
	let wb: any;
	try {
		wb = readXlsxFile(abs);
	} catch (err) {
		return { skipped: `failed to read workbook: ${relFile} (${(err as Error).message})` };
	}
	const out: ReportExtraction[] = [];
	for (const sheetName of wb.SheetNames) {
		// skip obvious instruction/description sheets, same convention the answer
		// key template itself uses ("Description")
		if (/description|คำอธิบาย/i.test(sheetName)) continue;
		out.push(extractReportSheet(abs, sheetName, wb.Sheets[sheetName]));
	}
	return out;
}

type FileResult = {
	file: string;
	status: "checked" | "skipped";
	skip_reason?: string;
	report_total?: number;
	matched_total?: number;
	unmatched_total?: number;
	unmatched_row_count?: number;
	total_row_count?: number;
	amount_confidence?: "high" | "low";
	sample_unmatched?: { row: number; tax_ids: string[]; doc_no_tokens: string[]; amount: number | null }[];
};

function main() {
	const args = parseArgs(process.argv);
	const clientDir = args.clientDir;
	if (!existsSync(clientDir)) {
		console.error(`client dir not found: ${clientDir}`);
		process.exit(2);
	}

	const dispositions = [...loadDispositions(clientDir), ...loadFragmentExclusions(clientDir)];
	const reportFiles = [
		...new Set(
			dispositions
				.filter((d) => d.disposition === "excluded" && (d.reason ?? "").startsWith("reference_report"))
				.map((d) => d.file),
		),
	];

	if (reportFiles.length === 0) {
		const out = { schema: SCHEMA, files_checked: 0, results: [] as FileResult[] };
		const outPath = join(pagesDir(clientDir), "reference-report-check.yaml");
		mkdirSync(pagesDir(clientDir), { recursive: true });
		writeFileSync(outPath, yamlStringify(out));
		console.log("No reference_report exclusions found — nothing to cross-check.");
		process.exit(0);
	}

	const booked = loadBookedFacts(clientDir);
	const bookedByDocNo = new Map<string, BookedFact[]>();
	const bookedByTaxId = new Map<string, BookedFact[]>();
	for (const b of booked) {
		if (b.document_no) {
			const list = bookedByDocNo.get(b.document_no) ?? [];
			list.push(b);
			bookedByDocNo.set(b.document_no, list);
		}
		for (const tid of [b.seller_tax_id, b.buyer_tax_id]) {
			if (!tid) continue;
			const list = bookedByTaxId.get(tid) ?? [];
			list.push(b);
			bookedByTaxId.set(tid, list);
		}
	}

	const results: FileResult[] = [];

	for (const relFile of reportFiles) {
		const extraction = loadReportExtractions(clientDir, relFile);
		if ("skipped" in extraction) {
			results.push({ file: relFile, status: "skipped", skip_reason: extraction.skipped });
			continue;
		}

		let reportTotal = 0;
		let matchedTotal = 0;
		let unmatchedTotal = 0;
		let totalRows = 0;
		let unmatchedRows: FileResult["sample_unmatched"] = [];
		let confidence: "high" | "low" = "high";

		for (const sheet of extraction) {
			if (sheet.amountConfidence === "low") confidence = "low";
			for (const row of sheet.rows) {
				totalRows++;
				const amt = row.amount ?? 0;
				reportTotal += amt;

				const isBooked =
					row.taxIds.some((tid) => bookedByTaxId.has(tid)) ||
					row.docNoTokens.some((tok) => bookedByDocNo.has(tok));

				if (isBooked) {
					matchedTotal += amt;
				} else {
					unmatchedTotal += amt;
					if (unmatchedRows.length < LIST_CAP) {
						unmatchedRows.push({
							row: row.rowIndex,
							tax_ids: row.taxIds,
							doc_no_tokens: row.docNoTokens,
							amount: row.amount,
						});
					}
				}
			}
		}

		results.push({
			file: relFile,
			status: "checked",
			report_total: Math.round(reportTotal * 100) / 100,
			matched_total: Math.round(matchedTotal * 100) / 100,
			unmatched_total: Math.round(unmatchedTotal * 100) / 100,
			unmatched_row_count: unmatchedRows.length < LIST_CAP ? unmatchedRows.length : undefined,
			total_row_count: totalRows,
			amount_confidence: confidence,
			sample_unmatched: unmatchedRows,
		});
	}

	const outDir = pagesDir(clientDir);
	mkdirSync(outDir, { recursive: true });
	const outPath = join(outDir, "reference-report-check.yaml");
	writeFileSync(outPath, yamlStringify({ schema: SCHEMA, files_checked: results.length, results }));

	// Human-readable stdout, printed unconditionally — this is the whole point:
	// a mismatch must never be silently possible to miss.
	const lines: string[] = [];
	lines.push(`Reference-report cross-check — ${basename(clientDir)}`);
	lines.push(`${results.length} reference_report exclusion(s) found`);
	let anyFlag = false;
	for (const r of results) {
		if (r.status === "skipped") {
			lines.push(`  ⚠ ${r.file} — SKIPPED (${r.skip_reason})`);
			anyFlag = true;
			continue;
		}
		const hasUnmatched = (r.unmatched_total ?? 0) > 0.01;

		// Low-confidence extraction (no recognizable amount-header column found,
		// fell back to "largest numeric cell in the row") can produce nonsense
		// totals on dashboard/KPI-style sheets (order IDs, dates, percentages
		// picked up as "amounts"). Never present that as if it were a real
		// figure — say plainly that this file needs a human to open and check.
		if (r.amount_confidence === "low") {
			lines.push(
				`  ⚠ ${r.file} — could not reliably auto-total this sheet (no recognizable amount column) — needs manual human cross-check, do not trust an auto-computed number here`,
			);
			anyFlag = true;
			continue;
		}

		const gapPct =
			r.report_total && r.report_total !== 0
				? Math.round(((r.unmatched_total ?? 0) / r.report_total) * 1000) / 10
				: 0;
		const flag = hasUnmatched ? " ⚠" : " ✓";
		if (hasUnmatched) anyFlag = true;
		lines.push(
			`  ${flag} ${r.file} — report total ${r.report_total} | booked-elsewhere ${r.matched_total} | UNACCOUNTED ${r.unmatched_total} (${gapPct}% of report, confidence: ${r.amount_confidence})`,
		);
		if (hasUnmatched) {
			lines.push(
				`      ${r.sample_unmatched?.length ?? 0} unmatched row(s) shown of ${r.unmatched_row_count ?? "many"} — this report may be the SOLE evidence for these transactions; do not silently leave it excluded, escalate to a human: should it become a booking source?`,
			);
			for (const u of (r.sample_unmatched ?? []).slice(0, 10)) {
				lines.push(`        row ${u.row}: amount=${u.amount} tax_ids=${u.tax_ids.join(",")} doc_no=${u.doc_no_tokens.slice(0, 3).join(",")}`);
			}
		}
	}
	lines.push(`snapshot: ${outPath}`);
	lines.push(
		anyFlag
			? "RESULT: REVIEW POINTS FOUND — surface every ⚠ line in the completion report; this never blocks the run or edits facts automatically."
			: "RESULT: all reference_report totals fully accounted for elsewhere.",
	);
	console.log(lines.join("\n"));

	// Never blocks the run — per SKILL.md this is evidence for a human, not an
	// automatic gate failure. Exit 0 always; the parent's completion report is
	// the enforcement point (it must not omit a flagged file).
	process.exit(0);
}

main();
