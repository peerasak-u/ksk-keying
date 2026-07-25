// Reconstructs the AI-original (never-human-edited) facts/lines/rows for one
// doc group, straight from its interpretation.json + categorize.json —
// ticket #42's "diffing that group's original agent-produced categorize.json
// output against its current (possibly human-edited) review-data.json state"
// (ticket #36's resolution). Exact port of groups-lib.ts's
// buildDocumentReviewData/buildStatementReviewData merge logic (pageFacts
// mapping, mergedLine, lineVat, the statement row merge), narrowed to just
// the fields review-edit.ts lets a reviewer change — not the full page/pages[]
// source-claim building groups-lib.ts also does, which changelog.ts has no
// need for. Reimplemented rather than imported: same
// "the scripts dir isn't a library" call as coa.ts/review-data.ts/peak-format.ts.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DefaultBuyer } from "./workspace";
import type { ReviewLine, ReviewPageFacts, StatementRow } from "./review-data";

export type SourceAccountingFacts = {
	document_date?: string | null;
	document_no?: string | null;
	reference?: string | null;
	seller_name?: string | null;
	seller_tax_id?: string | null;
	buyer_name?: string | null;
	buyer_tax_id?: string | null;
	gross_total?: number | null;
	vat?: number | null;
	wht?: number | null;
	net_paid?: number | null;
	currency?: string | null;
	original_currency?: string | null;
	original_amount?: number | null;
	exchange_rate?: number | null;
	description?: string | null;
	[key: string]: unknown;
};

export type SourceLineItem = {
	description?: string | null;
	qty?: number | null;
	unit?: string | null;
	unit_price?: number | null;
	amount?: number | null;
	amount_includes_vat?: boolean | null;
	vat_rate?: number | null;
	vat_treatment?: string | null;
	[key: string]: unknown;
};

export type SourceTransaction = {
	date_iso?: string | null;
	time?: string | null;
	description?: string | null;
	counterparty?: string | null;
	direction?: string | null;
	amount?: number | null;
	balance?: number | null;
	[key: string]: unknown;
};

export type SourceCategorizeLine = {
	line_index?: number;
	account_code?: string;
	sub_code?: string;
	account_name_th?: string;
	confidence?: string;
	reason?: string;
	needs_review?: boolean;
};

export type SourceCategorizeFile = {
	group_id?: string;
	lines?: SourceCategorizeLine[];
	bank_account_code?: string | null;
	bank_sub_code?: string | null;
};

export type SourceGroupInterpretation = {
	category?: "expense" | "income" | "bank_statement";
	vat_treatment?: "vat" | "non_vat" | "mixed" | null;
	facts?: SourceAccountingFacts;
	line_items?: SourceLineItem[];
	transactions?: SourceTransaction[];
};

const CONFIDENCES = new Set(["low", "medium", "high"]);

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

/** groups-lib.ts's lineVat: per-line VAT signal from either an explicit
 * vat_treatment or a numeric vat_rate; "unknown" when neither is present. */
export function lineVat(item: SourceLineItem): "vat" | "non_vat" | "unknown" {
	if (item.vat_treatment === "vat_7") return "vat";
	if (item.vat_treatment === "non_vat") return "non_vat";
	if (item.vat_rate === 7) return "vat";
	if (item.vat_rate === 0) return "non_vat";
	return "unknown";
}

function factsVatTreatment(vat: "vat" | "non_vat" | "mixed" | null | undefined): string {
	if (vat === "vat") return "vat_7";
	if (vat === "non_vat") return "non_vat";
	return ""; // mixed (or unset): per-line vat_treatment drives the export
}

/** Exact port of groups-lib.ts's pageFacts mapping (buildDocumentReviewData) —
 * every page in a freshly-built group shares this SAME fact set (facts are a
 * group-level concept), so it's computed once per group, not per page. */
export function buildOriginalPageFacts(
	facts: SourceAccountingFacts,
	vatTreatment: "vat" | "non_vat" | "mixed" | null | undefined,
	defaultBuyer: DefaultBuyer | null,
): ReviewPageFacts {
	const grossTotal = facts.gross_total ?? null;
	const vatAmount = facts.vat ?? null;
	return {
		date: facts.document_date ?? null,
		document_no: facts.document_no ?? null,
		reference: facts.reference ?? null,
		seller: facts.seller_name ?? null,
		seller_tax_id: facts.seller_tax_id ?? null,
		buyer: facts.buyer_name ?? defaultBuyer?.name ?? null,
		buyer_tax_id: facts.buyer_tax_id ?? defaultBuyer?.tax_id ?? null,
		subtotal: grossTotal != null && vatAmount != null ? round2(grossTotal - vatAmount) : grossTotal,
		vat: vatAmount,
		total: grossTotal,
		paid: facts.net_paid ?? null,
		wht: facts.wht ?? null,
		summary: facts.description ?? null,
		vat_treatment: factsVatTreatment(vatTreatment),
		currency: facts.currency ?? null,
		original_currency: facts.original_currency ?? null,
		original_amount: facts.original_amount ?? null,
		exchange_rate: facts.exchange_rate ?? null,
	};
}

function categorizeByIndex(lines: SourceCategorizeLine[]): Map<number, SourceCategorizeLine> {
	const map = new Map<number, SourceCategorizeLine>();
	for (const line of lines) if (Number.isInteger(line.line_index)) map.set(line.line_index as number, line);
	return map;
}

/** Exact port of groups-lib.ts's mergedLine — the AI-original per-line
 * ReviewLine, before any human edit. */
export function buildOriginalLines(lineItems: SourceLineItem[], categorizeLines: SourceCategorizeLine[], perLineVat: boolean): ReviewLine[] {
	const catByIndex = categorizeByIndex(categorizeLines);
	return lineItems.map((item, index) => {
		const cat = catByIndex.get(index);
		const vat = lineVat(item);
		return {
			line_index: index,
			description: item.description ?? null,
			qty: item.qty ?? null,
			unit: item.unit ?? null,
			unit_price: item.unit_price ?? null,
			amount: item.amount ?? null,
			amount_includes_vat: item.amount_includes_vat ?? null,
			vat_treatment: perLineVat ? (vat === "vat" ? "vat_7" : "non_vat") : null,
			account_code: cat?.account_code ?? "",
			sub_code: cat?.sub_code ?? "",
			account_name_th: cat?.account_name_th ?? "",
			confidence: cat && CONFIDENCES.has(cat.confidence ?? "") ? (cat.confidence as ReviewLine["confidence"]) : "low",
			reason: cat?.reason ?? (cat ? "" : "no categorize entry for this line"),
			needs_review: cat?.needs_review ?? true,
		};
	});
}

/** facts+lines for one document group (expense/income buckets), matching
 * what build-review-data.ts would produce fresh right now from
 * interpretation.json + categorize.json — the "before" side of the changelog
 * diff. */
export function buildOriginalDocumentSnapshot(
	interp: SourceGroupInterpretation,
	categorize: SourceCategorizeFile,
	defaultBuyer: DefaultBuyer | null,
): { facts: ReviewPageFacts; lines: ReviewLine[] } {
	const perLineVat = interp.category === "expense" && interp.vat_treatment === "mixed";
	return {
		facts: buildOriginalPageFacts(interp.facts ?? {}, interp.vat_treatment, defaultBuyer),
		lines: buildOriginalLines(interp.line_items ?? [], categorize.lines ?? [], perLineVat),
	};
}

/** Ported from groups-lib.ts's buildStatementReviewData row merge — the
 * AI-original StatementRow (minus `skipped`, which is always false before any
 * human ever touches a fresh row). Array index === row_index, matching the
 * real build. Deliberately softer than the original on malformed input: the
 * real build throws on a transaction missing date_iso/direction/amount (a
 * hard stop mid-pipeline is right there), but this reconstruction only ever
 * feeds a best-effort export-time changelog diff — a malformed upstream
 * transaction here defaults rather than aborts the whole changes.json. */
export function buildOriginalStatementRows(transactions: SourceTransaction[], categorizeLines: SourceCategorizeLine[]): Omit<StatementRow, "skipped">[] {
	const catByIndex = categorizeByIndex(categorizeLines);
	return transactions.map((txn, index) => {
		const cat = catByIndex.get(index);
		return {
			row_index: index,
			date_iso: txn.date_iso ?? "",
			time: txn.time ?? null,
			description: txn.description ?? null,
			counterparty: txn.counterparty ?? null,
			direction: (txn.direction as "in" | "out") ?? "out",
			amount: Math.abs(txn.amount ?? 0),
			balance: txn.balance ?? null,
			account_code: cat?.account_code ?? "",
			sub_code: cat?.sub_code ?? "",
			account_name_th: cat?.account_name_th ?? "",
			confidence: cat && CONFIDENCES.has(cat.confidence ?? "") ? (cat.confidence as StatementRow["confidence"]) : "low",
			reason: cat?.reason ?? (cat ? "" : "no categorize entry for this row"),
			needs_review: cat?.needs_review ?? true,
		};
	});
}

/** The bank account's GL contra-account key as originally categorized —
 * coaKey()'s own "<code>||<sub>" composite, or null when categorize.json
 * never assigned one (matches applyStatementMetaEdit's on-disk shape: null
 * bank_account_code until a reviewer picks one). */
export function buildOriginalBankAccountKey(categorize: SourceCategorizeFile): string | null {
	if (!categorize.bank_account_code) return null;
	return `${categorize.bank_account_code}||${categorize.bank_sub_code ?? ""}`;
}

// ---------------------------------------------------------------------------
// Thin I/O — real file reads, group-source.test.ts covers the pure functions
// above directly; these two loaders are exercised end-to-end by
// changelog.test.ts's real-file-I/O cases (same convention as review-data.ts's
// loadBucketPages/loadBucketStatements).

/** Reads <groupDir>/interpretation.json. Returns null if missing or
 * unparseable — a group whose upstream files vanished mid-run is a soft skip
 * for the changelog, not a hard error (mirrors build-review-data.ts's own
 * "missing inputs" posture). */
export async function loadGroupInterpretation(groupDir: string): Promise<SourceGroupInterpretation | null> {
	const path = join(groupDir, "interpretation.json");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(await readFile(path, "utf8")) as SourceGroupInterpretation;
	} catch {
		return null;
	}
}

export async function loadGroupCategorize(groupDir: string): Promise<SourceCategorizeFile | null> {
	const path = join(groupDir, "categorize.json");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(await readFile(path, "utf8")) as SourceCategorizeFile;
	} catch {
		return null;
	}
}
