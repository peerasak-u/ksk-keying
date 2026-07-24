// Category/group review data — types + read/merge layer (wayfinder ticket
// #41, part of the #40 spec's sibling: category/group review pages +
// build-review-data.ts fix). Ported from
// .claude/skills/ksk-keying/scripts/review-groups.ts's bucketPages/
// bucketStatements/compareReviewPagesBySource and review-template.ts's type
// contract (review-data-schema.md is the authoritative doc) — reimplemented
// here rather than imported, same call review-claims.ts already made: those
// scripts are standalone CLIs, not designed as libraries.
//
// Unlike the old static-HTML generator, this is a real HTTP server, so
// source_src (already month-root-relative per the schema) is served directly
// via server.ts's existing /files/:clientId/:monthId/* route — no
// bucket-relative path rewriting needed.
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type ReviewLine = {
	line_index: number;
	description: string | null;
	qty: number | null;
	unit: string | null;
	unit_price: number | null;
	amount: number | null;
	amount_includes_vat: boolean | null;
	// Per-line VAT treatment; only meaningful in the expense/mixed bucket.
	// Falls back to the document-level facts.vat_treatment when absent.
	vat_treatment?: "vat_7" | "non_vat" | null;
	account_code: string;
	sub_code: string;
	account_name_th: string;
	confidence: "low" | "medium" | "high";
	reason: string;
	needs_review: boolean;
};

export type ReviewPageFacts = Record<string, string | number | null>;

export type ReviewPage = {
	ref: string;
	short_ref: string;
	source_src: string | null;
	source_page: number | null;
	source_pages?: number[] | null;
	source_sheet: string | null;
	image_src: string | null;
	extract_path: string;
	categorize_path: string;
	facts: ReviewPageFacts;
	lines: ReviewLine[];
	initial_status: "reviewed" | "needs_attention";
	// Stamped by loadBucketPages() when merging multiple groups into one bucket.
	group_id?: string;
	group_label?: string;
	group_review_flags?: string[];
	// This page's index within its OWN group's pages[] array (not the merged
	// bucket array) — the stable, unambiguous key review-edit.ts's edit
	// endpoints address a page by, since `ref` is a display label with no
	// guaranteed-unique format across groups.
	page_index_in_group?: number;
};

export type DocumentGroupData = {
	schema: "ksk_review_group_data.v1";
	group_id: string;
	label?: string;
	review_flags?: string[];
	pages: ReviewPage[];
};

export type StatementInfo = {
	bank: string | null;
	account_no: string | null;
	account_holder: string | null;
	period: string | null;
	opening_balance: number | null;
	closing_balance: number | null;
	bank_account_code: string | null;
	bank_sub_code: string | null;
};

export type StatementSource = {
	source_src: string | null;
	source_page: number | null;
	source_pages?: number[] | null;
	source_sheet: string | null;
	image_src: string | null;
};

export type StatementRow = {
	row_index: number;
	date_iso: string;
	time: string | null;
	description: string | null;
	counterparty: string | null;
	direction: "in" | "out";
	amount: number;
	balance: number | null;
	account_code: string;
	sub_code: string;
	account_name_th: string;
	confidence: "low" | "medium" | "high";
	reason: string;
	needs_review: boolean;
};

export type StatementGroupData = {
	schema: "ksk_review_statement_data.v1";
	group_id: string;
	label?: string;
	statement: StatementInfo;
	source: StatementSource;
	rows: StatementRow[];
};

export const DOCUMENT_BUCKETS = [
	"expense/vat",
	"expense/non_vat",
	"expense/mixed",
	"income/vat",
	"income/non_vat",
] as const;
export type DocumentBucket = (typeof DOCUMENT_BUCKETS)[number];
export const STATEMENT_BUCKET = "bank_statement" as const;
export type BucketKey = DocumentBucket | typeof STATEMENT_BUCKET;

export function isMixedBucket(bucket: BucketKey): boolean {
	return bucket === "expense/mixed";
}

export function isDocumentBucket(bucket: string): bucket is DocumentBucket {
	return (DOCUMENT_BUCKETS as readonly string[]).includes(bucket);
}

export class ReviewDataError extends Error {}

/** Pure: validate + narrow a parsed JSON value into DocumentGroupData. Throws
 * ReviewDataError naming the offending path — a statement-schema file sitting
 * in a document bucket (or a malformed file) is a hard error, not a silent
 * skip, mirroring review-groups.ts's own schema hard-errors. */
export function parseDocumentGroupData(text: string, path: string): DocumentGroupData {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new ReviewDataError(`invalid JSON: ${path}`);
	}
	const doc = data as Partial<DocumentGroupData> | null;
	if (!doc || doc.schema !== "ksk_review_group_data.v1")
		throw new ReviewDataError(`${path}: expected schema "ksk_review_group_data.v1", got ${JSON.stringify((doc as { schema?: unknown } | null)?.schema)}`);
	if (!Array.isArray(doc.pages)) throw new ReviewDataError(`${path}: missing pages[]`);
	return doc as DocumentGroupData;
}

export function parseStatementGroupData(text: string, path: string): StatementGroupData {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new ReviewDataError(`invalid JSON: ${path}`);
	}
	const doc = data as Partial<StatementGroupData> | null;
	if (!doc || doc.schema !== "ksk_review_statement_data.v1")
		throw new ReviewDataError(`${path}: expected schema "ksk_review_statement_data.v1", got ${JSON.stringify((doc as { schema?: unknown } | null)?.schema)}`);
	if (!doc.statement || typeof doc.statement !== "object") throw new ReviewDataError(`${path}: missing statement{}`);
	if (!doc.source || typeof doc.source !== "object") throw new ReviewDataError(`${path}: missing source{}`);
	if (!Array.isArray(doc.rows)) throw new ReviewDataError(`${path}: missing rows[]`);
	return doc as StatementGroupData;
}

/** Pure: order review pages the way a human reads the source folder — by
 * source document first (falling back to the rasterized image path for
 * legacy pages), then by page number within the document, then by ref for a
 * stable tie-break. Exact port of review-template.ts's
 * compareReviewPagesBySource — this is what gives "source-file/sheet page
 * grouping" (pages from the same file end up adjacent) without needing an
 * explicit section header. */
export function compareReviewPagesBySource(a: ReviewPage, b: ReviewPage): number {
	const aSrc = a.source_src ?? a.image_src ?? null;
	const bSrc = b.source_src ?? b.image_src ?? null;
	if (aSrc !== bSrc) {
		if (aSrc === null) return 1;
		if (bSrc === null) return -1;
		const bySrc = aSrc.localeCompare(bSrc);
		if (bySrc) return bySrc;
	}
	const aPage = a.source_page ?? Number.MAX_SAFE_INTEGER;
	const bPage = b.source_page ?? Number.MAX_SAFE_INTEGER;
	if (aPage !== bPage) return aPage - bPage;
	return a.ref.localeCompare(b.ref);
}

// ---------------------------------------------------------------------------
// Thin I/O wrappers — real file reads, covered by the manual smoke test
// (same convention as review-claims.ts/#38/#39) rather than unit tests.

function docGroupsRoot(clientMonthDir: string): string {
	return join(clientMonthDir, "ข้อมูลระบบ", "_doc_groups");
}

/** Absolute path to <bucket>/<groupId>/ under _doc_groups — the one place
 * both the view (loadBucketPages/loadBucketStatements) and the edit
 * endpoints (review-edit.ts) need to agree on group folder layout. */
export function groupDir(clientMonthDir: string, bucket: BucketKey, groupId: string): string {
	return join(docGroupsRoot(clientMonthDir), ...bucket.split("/"), groupId);
}

async function listGroupFolders(dir: string): Promise<string[]> {
	if (!existsSync(dir)) return [];
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	return entries
		.filter((e) => e.isDirectory() && e.name !== "assets" && !e.name.startsWith("."))
		.map((e) => e.name)
		.sort();
}

export type BucketPagesResult = { pages: ReviewPage[]; errors: string[] };

/** Merge every group folder's review-data.json under one document bucket
 * into a single reading-order page list. A group folder that exists but has
 * no review-data.json yet (categorize/build-review-data hasn't reached it)
 * is silently skipped, not an error — a live review page tolerates a
 * still-in-progress run; a malformed review-data.json IS an error, surfaced
 * per-group so one bad file doesn't blank the whole bucket. */
export async function loadBucketPages(clientMonthDir: string, bucket: DocumentBucket): Promise<BucketPagesResult> {
	const dir = join(docGroupsRoot(clientMonthDir), ...bucket.split("/"));
	const pages: ReviewPage[] = [];
	const errors: string[] = [];
	for (const groupId of await listGroupFolders(dir)) {
		const dataPath = join(dir, groupId, "review-data.json");
		if (!existsSync(dataPath)) continue;
		let data: DocumentGroupData;
		try {
			data = parseDocumentGroupData(await readFile(dataPath, "utf8"), dataPath);
		} catch (err) {
			errors.push(err instanceof Error ? err.message : String(err));
			continue;
		}
		data.pages.forEach((page, index) => {
			pages.push({
				...page,
				group_id: data.group_id || groupId,
				group_label: data.label ?? data.group_id ?? groupId,
				group_review_flags: data.review_flags ?? [],
				page_index_in_group: index,
			});
		});
	}
	pages.sort(compareReviewPagesBySource);
	return { pages, errors };
}

export type StatementEntry = StatementGroupData & { group_dir: string };
export type BucketStatementsResult = { statements: StatementEntry[]; errors: string[] };

/** One entry per group folder (bank account) under bank_statement — no
 * cross-group row flattening (each statement group is its own bank account,
 * shown one at a time), folder-name order (same as review-groups.ts). */
export async function loadBucketStatements(clientMonthDir: string): Promise<BucketStatementsResult> {
	const dir = join(docGroupsRoot(clientMonthDir), STATEMENT_BUCKET);
	const statements: StatementEntry[] = [];
	const errors: string[] = [];
	for (const groupId of await listGroupFolders(dir)) {
		const dataPath = join(dir, groupId, "review-data.json");
		if (!existsSync(dataPath)) continue;
		try {
			const data = parseStatementGroupData(await readFile(dataPath, "utf8"), dataPath);
			statements.push({ ...data, group_dir: groupId });
		} catch (err) {
			errors.push(err instanceof Error ? err.message : String(err));
		}
	}
	return { statements, errors };
}
