// Numbers for the per-month review hub.
//
// The hub used to be 7 identical link cards with no numbers on it at all, so
// there was no way to tell how big a month was, how far along it was, or which
// surface needed attention without opening each one. Everything the hub shows
// is derived here, once, so the renderer stays a pure layout function.
//
// Same pure-core / thin-I/O split as review-claims.ts: buildHubStats() is
// total and unit-tested, loadHubStats() only reads the artifacts off disk.
import {
	buildClaims,
	hasAnyExcludedEntries,
	hasReferenceReportCheckFile,
	readDispositions,
	readReviewedUnitsByGroup,
	type Claim,
} from "./review-claims";
import {
	DOCUMENT_BUCKETS,
	loadBucketPages,
	loadBucketStatements,
	type DocumentBucket,
	type ReviewPage,
	type StatementGroupData,
} from "./review-data";

export type BucketStat = {
	key: DocumentBucket;
	label: string;
	href: string;
	/** documents (group folders), not pages — one document can span pages */
	groups: number;
	pages: number;
	/** distinct source files the pages were cut out of */
	files: number;
	lines: number;
	total: number;
	needsAttention: number;
	skipped: number;
	/** pages the pipeline already settled (initial_status === "reviewed") */
	reviewed: number;
};

export type ExcludedStat = {
	href: string;
	/** claims still waiting on a human decision */
	pending: number;
	files: number;
	byReason: { label: string; count: number }[];
	/** the month had exclusions at some point (vs. never had any) */
	hadAny: boolean;
	/** nothing left to decide — either reviewed to completion or never had any */
	clear: boolean;
	conflicts: number;
	missingChecks: number;
};

export type StatementStat = {
	href: string;
	accounts: number;
	rows: number;
	inflow: number;
	outflow: number;
	needsAttention: number;
	skipped: number;
};

export type HubStats = {
	excluded: ExcludedStat;
	buckets: BucketStat[];
	statement: StatementStat;
	totals: {
		documents: number;
		pages: number;
		files: number;
		expense: number;
		income: number;
		needsAttention: number;
		reviewed: number;
		reviewable: number;
	};
	/** the excluded queue still has undecided claims, so every other review
	 * surface is shown but not enterable — keying a month whose exclusions
	 * are unconfirmed produces wrong books. */
	locked: boolean;
};

export const BUCKET_LABELS: Record<DocumentBucket, string> = {
	"expense/vat": "รายจ่าย — มี VAT",
	"expense/non_vat": "รายจ่าย — ไม่มี VAT",
	"expense/mixed": "รายจ่าย — ผสม VAT/ไม่มี VAT",
	"income/vat": "รายรับ — มี VAT",
	"income/non_vat": "รายรับ — ไม่มี VAT",
};

export const STATEMENT_LABEL = "รายการเดินบัญชีธนาคาร";

function monthBase(clientId: string, monthId: string): string {
	return `/clients/${encodeURIComponent(clientId)}/${encodeURIComponent(monthId)}`;
}

/** facts.total is the document's own stated total — the number a bookkeeper
 * ties out against — so prefer it over re-summing line amounts, which can be
 * VAT-inclusive or ignore a discount the document total already nets off. */
function pageTotal(p: ReviewPage): number {
	const t = p.facts?.total;
	return typeof t === "number" && Number.isFinite(t) ? t : 0;
}

function reasonBreakdown(claims: Claim[]): { label: string; count: number }[] {
	const by = new Map<string, number>();
	for (const c of claims) by.set(c.reasonLabel, (by.get(c.reasonLabel) ?? 0) + 1);
	return [...by.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

export type HubStatsInput = {
	clientId: string;
	monthId: string;
	claims: Claim[];
	hadAnyExcluded: boolean;
	/** one entry per document bucket, in DOCUMENT_BUCKETS order */
	bucketPages: Map<DocumentBucket, ReviewPage[]>;
	statements: StatementGroupData[];
};

export function buildHubStats(input: HubStatsInput): HubStats {
	const base = monthBase(input.clientId, input.monthId);

	const excluded: ExcludedStat = {
		href: `${base}/excluded-review`,
		pending: input.claims.length,
		files: new Set(input.claims.map((c) => c.file)).size,
		byReason: reasonBreakdown(input.claims),
		hadAny: input.hadAnyExcluded,
		clear: input.claims.length === 0,
		conflicts: input.claims.filter((c) => c.conflictGroup).length,
		missingChecks: input.claims.filter((c) => c.referenceReportCheckMissing).length,
	};

	const allFiles = new Set<string>();
	const buckets: BucketStat[] = DOCUMENT_BUCKETS.map((key) => {
		const pages = input.bucketPages.get(key) ?? [];
		for (const p of pages) if (p.source_src) allFiles.add(p.source_src);
		const live = pages.filter((p) => !p.skipped);
		return {
			key,
			label: BUCKET_LABELS[key],
			href: `${base}/review/${key}`,
			groups: new Set(pages.map((p) => p.group_id ?? p.ref)).size,
			pages: pages.length,
			files: new Set(pages.map((p) => p.source_src).filter(Boolean)).size,
			lines: pages.reduce((sum, p) => sum + p.lines.length, 0),
			total: live.reduce((sum, p) => sum + pageTotal(p), 0),
			needsAttention: live.filter((p) => p.initial_status === "needs_attention").length,
			skipped: pages.length - live.length,
			reviewed: live.filter((p) => p.initial_status === "reviewed").length,
		};
	});

	const rows = input.statements.flatMap((s) => s.rows);
	const liveRows = rows.filter((r) => !r.skipped);
	const statement: StatementStat = {
		href: `${base}/review/bank_statement`,
		accounts: input.statements.length,
		rows: rows.length,
		inflow: liveRows.filter((r) => r.direction === "in").reduce((sum, r) => sum + r.amount, 0),
		outflow: liveRows.filter((r) => r.direction === "out").reduce((sum, r) => sum + r.amount, 0),
		needsAttention: liveRows.filter((r) => r.needs_review).length,
		skipped: rows.length - liveRows.length,
	};

	const sum = (pick: (s: BucketStat) => number) => buckets.reduce((acc, s) => acc + pick(s), 0);

	return {
		excluded,
		buckets,
		statement,
		totals: {
			documents: sum((s) => s.groups),
			pages: sum((s) => s.pages),
			files: allFiles.size,
			expense: buckets.filter((s) => s.key.startsWith("expense/")).reduce((acc, s) => acc + s.total, 0),
			income: buckets.filter((s) => s.key.startsWith("income/")).reduce((acc, s) => acc + s.total, 0),
			needsAttention: sum((s) => s.needsAttention) + statement.needsAttention,
			reviewed: sum((s) => s.reviewed),
			reviewable: sum((s) => s.pages - s.skipped),
		},
		locked: !excluded.clear,
	};
}

// ---------------------------------------------------------------------------
// Thin I/O wrapper — reads the same artifacts each detail page reads, so the
// hub can never disagree with the page it links to.

export async function loadHubStats(clientDir: string, clientId: string, monthId: string): Promise<HubStats> {
	const [dispositions, reviewedByGroup] = await Promise.all([readDispositions(clientDir), readReviewedUnitsByGroup(clientDir)]);
	const bucketPages = new Map<DocumentBucket, ReviewPage[]>();
	for (const key of DOCUMENT_BUCKETS) {
		const { pages, errors } = await loadBucketPages(clientDir, key);
		if (errors.length) console.error(`review hub bucket ${key} (${clientId}/${monthId}):`, errors);
		bucketPages.set(key, pages);
	}
	const { statements, errors } = await loadBucketStatements(clientDir);
	if (errors.length) console.error(`review hub bank_statement (${clientId}/${monthId}):`, errors);

	return buildHubStats({
		clientId,
		monthId,
		claims: buildClaims(dispositions, reviewedByGroup, hasReferenceReportCheckFile(clientDir)),
		hadAnyExcluded: hasAnyExcludedEntries(dispositions),
		bucketPages,
		statements,
	});
}
