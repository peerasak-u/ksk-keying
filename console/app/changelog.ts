// Per-group human-edit changelog (wayfinder ticket #42, format decided by
// ticket #36): a snapshot diff computed once at export time between a
// group's current (possibly human-edited) review-data.json and its
// AI-original state reconstructed by group-source.ts from
// interpretation.json + categorize.json. One changes.json file per
// group/bucket, alongside categorize.json/review-data.json — content-level
// only (disposition/exclusion state stays exclusively in dispositions.yaml,
// per #36's resolution).
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { coaKey } from "./coa";
import {
	buildOriginalBankAccountKey,
	buildOriginalDocumentSnapshot,
	buildOriginalStatementRows,
	loadGroupCategorize,
	loadGroupInterpretation,
} from "./group-source";
import {
	groupDir,
	parseDocumentGroupData,
	parseStatementGroupData,
	type BucketKey,
	type DocumentGroupData,
	type ReviewLine,
	type ReviewPageFacts,
	type StatementGroupData,
	type StatementRow,
} from "./review-data";
import type { DefaultBuyer } from "./workspace";

export type ChangeEntry = {
	line_id: string;
	field: string;
	before: unknown;
	after: unknown;
	reason?: string;
};

export type ChangesFile = {
	schema: "ksk_review_changes.v1";
	group_id: string;
	computed_at: string;
	entries: ChangeEntry[];
};

function changed(before: unknown, after: unknown): boolean {
	const a = before === undefined ? null : before;
	const b = after === undefined ? null : after;
	return a !== b;
}

function accountKeyOf(row: { account_code: string; sub_code: string }): string {
	return coaKey(row);
}

const FACT_KEYS: string[] = [
	"date",
	"document_no",
	"reference",
	"seller",
	"seller_tax_id",
	"buyer",
	"buyer_tax_id",
	"subtotal",
	"vat",
	"total",
	"paid",
	"wht",
	"summary",
	"vat_treatment",
	"currency",
	"original_currency",
	"original_amount",
	"exchange_rate",
];

const LINE_FIELDS: (keyof ReviewLine)[] = ["description", "qty", "unit", "unit_price", "amount", "amount_includes_vat", "vat_treatment"];

/** Pure: diff one document group's CURRENT state against its AI-original
 * reconstruction. Every page in the group shares the same original facts
 * (facts are a group-level concept — see group-source.ts); lines are
 * compared by line_index within whichever page currently carries them
 * (line add/remove is out of scope — #41/#42 — so index alignment holds). */
export function diffDocumentGroup(current: DocumentGroupData, original: { facts: ReviewPageFacts; lines: ReviewLine[] }): ChangeEntry[] {
	const entries: ChangeEntry[] = [];
	const originalLineByIndex = new Map(original.lines.map((l) => [l.line_index, l]));

	for (const page of current.pages) {
		for (const key of FACT_KEYS) {
			const before = original.facts[key] ?? null;
			const after = page.facts[key] ?? null;
			if (changed(before, after)) entries.push({ line_id: page.ref, field: `facts.${key}`, before, after });
		}
		// skipped is a later-stage export-inclusion gate (ticket #42), distinct
		// from dispositions.yaml's exclusion state (ticket #33/#36's boundary) —
		// still worth logging here since it IS a human edit, just not the kind
		// #37's learning pass counts as signal.
		if (changed(false, page.skipped)) entries.push({ line_id: page.ref, field: "skipped", before: false, after: page.skipped });

		for (const line of page.lines) {
			const originalLine = originalLineByIndex.get(line.line_index);
			const lineId = `${page.ref}#L${line.line_index}`;
			for (const field of LINE_FIELDS) {
				const before = (originalLine?.[field] ?? null) as unknown;
				const after = (line[field] ?? null) as unknown;
				if (changed(before, after)) entries.push({ line_id: lineId, field, before, after });
			}
			// Named "account_code" (not "account_key") to match ticket #36's own
			// resolution verbatim — ticket #37's learning pass filters changelog
			// entries by exactly `field === "account_code"`; the value itself
			// still carries the full account_code+sub_code composite (coaKey()'s
			// "<code>||<sub>" shape), just under the field name #37 expects.
			const beforeAccount = originalLine ? accountKeyOf(originalLine) : "";
			const afterAccount = accountKeyOf(line);
			if (changed(beforeAccount, afterAccount)) entries.push({ line_id: lineId, field: "account_code", before: beforeAccount, after: afterAccount });
		}
	}
	return entries;
}

/** Pure: diff one bank_statement group's CURRENT state against its
 * AI-original reconstruction. */
export function diffStatementGroup(current: StatementGroupData, original: { bankAccountKey: string | null; rows: Omit<StatementRow, "skipped">[] }): ChangeEntry[] {
	const entries: ChangeEntry[] = [];

	const currentBankKey = current.statement.bank_account_code ? accountKeyOf({ account_code: current.statement.bank_account_code, sub_code: current.statement.bank_sub_code ?? "" }) : null;
	if (changed(original.bankAccountKey, currentBankKey)) {
		entries.push({ line_id: current.group_id, field: "statement.bank_account_key", before: original.bankAccountKey, after: currentBankKey });
	}

	const originalByIndex = new Map(original.rows.map((r) => [r.row_index, r]));
	for (const row of current.rows) {
		const originalRow = originalByIndex.get(row.row_index);
		const lineId = `${current.group_id}#R${row.row_index}`;
		const beforeDescription = originalRow?.description ?? null;
		if (changed(beforeDescription, row.description ?? null)) entries.push({ line_id: lineId, field: "description", before: beforeDescription, after: row.description ?? null });
		const beforeAmount = originalRow?.amount ?? null;
		if (changed(beforeAmount, row.amount)) entries.push({ line_id: lineId, field: "amount", before: beforeAmount, after: row.amount });
		// Same "account_code" naming as diffDocumentGroup, for the same reason
		// (ticket #37 filters on this exact field name).
		const beforeAccount = originalRow ? accountKeyOf(originalRow) : "";
		const afterAccount = accountKeyOf(row);
		if (changed(beforeAccount, afterAccount)) entries.push({ line_id: lineId, field: "account_code", before: beforeAccount, after: afterAccount });
		// skipped is a later-stage export-inclusion gate (ticket #42), distinct
		// from dispositions.yaml's exclusion state (ticket #33/#36's boundary) —
		// still worth logging here since it IS a human edit, just not the kind
		// #37's learning pass counts as signal.
		if (changed(false, row.skipped)) entries.push({ line_id: lineId, field: "skipped", before: false, after: row.skipped });
	}
	return entries;
}

export function buildChangesFile(groupId: string, entries: ChangeEntry[], computedAt: string): ChangesFile {
	return { schema: "ksk_review_changes.v1", group_id: groupId, computed_at: computedAt, entries };
}

// ---------------------------------------------------------------------------
// Thin I/O — real file reads/writes.

function writeChangesFileAtomic(path: string, data: ChangesFile): void {
	const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	renameSync(tmpPath, path);
}

/** Computes AND writes <groupDir>/changes.json for one group — the "atomic
 * with export" step #35/#36 call for. Returns null (writing nothing) when
 * the group's own review-data.json, interpretation.json, or categorize.json
 * can't be read/parsed — a soft skip so one broken group doesn't fail an
 * entire bucket export, matching build-review-data.ts's own missing-inputs
 * posture. */
export async function computeAndWriteChangesForGroup(clientMonthDir: string, bucket: BucketKey, groupId: string, defaultBuyer: DefaultBuyer | null): Promise<ChangesFile | null> {
	const dir = groupDir(clientMonthDir, bucket, groupId);
	const reviewDataPath = join(dir, "review-data.json");
	if (!existsSync(reviewDataPath)) return null;

	const [interp, categorize] = await Promise.all([loadGroupInterpretation(dir), loadGroupCategorize(dir)]);
	if (!interp || !categorize) return null;

	const computedAt = new Date().toISOString();

	if (bucket === "bank_statement") {
		let current: StatementGroupData;
		try {
			current = parseStatementGroupData(await readFile(reviewDataPath, "utf8"), reviewDataPath);
		} catch {
			return null;
		}
		const original = { bankAccountKey: buildOriginalBankAccountKey(categorize), rows: buildOriginalStatementRows(interp.transactions ?? [], categorize.lines ?? []) };
		const changes = buildChangesFile(groupId, diffStatementGroup(current, original), computedAt);
		writeChangesFileAtomic(join(dir, "changes.json"), changes);
		return changes;
	}

	let current: DocumentGroupData;
	try {
		current = parseDocumentGroupData(await readFile(reviewDataPath, "utf8"), reviewDataPath);
	} catch {
		return null;
	}
	const original = buildOriginalDocumentSnapshot(interp, categorize, defaultBuyer);
	const changes = buildChangesFile(groupId, diffDocumentGroup(current, original), computedAt);
	writeChangesFileAtomic(join(dir, "changes.json"), changes);
	return changes;
}
