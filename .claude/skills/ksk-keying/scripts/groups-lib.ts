// Shared deterministic logic for the doc-group phase ("agents judge, scripts
// copy"): group planning from links.yaml + segment interpretations
// (group-skeleton), 1:1 populate by copying upstream facts/lines
// (group-populate), and the interpretation+categorize → review-data.json merge
// (build-review-data). Pure functions here, file I/O in the CLI scripts —
// so the judgment-free transforms are testable without a client folder.
//
// Data contracts consumed:
//   ข้อมูลระบบ/_segments/<id>/interpretation*.json   — Stage 2 output (ksk-watson/ksk-marple)
//   ข้อมูลระบบ/_doc_groups/links.yaml               — ksk-sherlock clusters (optional)
//   <group>/categorize.json                        — ksk-poirot {group_id, lines[]}
// Data contracts produced:
//   ข้อมูลระบบ/_doc_groups/manifest.yaml            — ksk_doc_groups.v1 / category_vat_tree.v1
//   <group>/interpretation.json                    — ksk_group_interpretation.v1
//   <group>/review-data.json                       — ksk_review_group_data.v1 /
//                                                    ksk_review_statement_data.v1
//                                                    (references/review-data-schema.md)

import { documentUnitId, norm } from "./unit-key";

export const GROUP_MANIFEST_SCHEMA = "ksk_doc_groups.v1";
export const GROUP_LAYOUT = "category_vat_tree.v1";
export const GROUP_INTERPRETATION_SCHEMA = "ksk_group_interpretation.v1";

// ---------------------------------------------------------------------------
// Upstream shapes (tolerant: agents write these; only the fields the scripts
// rely on are typed)

export type PageDispositionEntry = {
	file?: string;
	page?: number | null;
	sheet?: string | null;
	disposition?: string;
	reason?: string;
	// Required when reason is "duplicate": the original unit this page
	// duplicates, as a Page-Ledger unit id ("<file>#p<N>" / "<file>#s<Sheet>").
	// Lets the exclusion review page point the reviewer at the kept page
	// instead of just naming the reason.
	duplicate_of?: string;
};

export type InterpDocument = {
	artifact?: string | null;
	source_file?: string | null;
	source_page?: number | null;
	source_sheet?: string | null;
	doc_kind?: string | null;
	document_role?: string | null;
	evidence_role?: string | null;
	usable_for_booking?: boolean;
	[key: string]: unknown;
};

export type AccountingFacts = {
	direction?: string | null;
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
	description?: string | null;
	[key: string]: unknown;
};

export type InterpLineItem = {
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

export type StatementTransaction = {
	date_iso?: string | null;
	time?: string | null;
	description?: string | null;
	counterparty?: string | null;
	direction?: string | null;
	amount?: number | null;
	balance?: number | null;
	[key: string]: unknown;
};

// One Stage-2 interpretation file, document- or statement-shaped.
export type Interpretation = {
	segment_id?: string;
	documents?: InterpDocument[];
	accounting_facts?: AccountingFacts;
	line_items?: InterpLineItem[];
	review_flags?: unknown[];
	questions_for_user?: unknown[];
	page_disposition?: PageDispositionEntry[];
	// statement shape
	bank?: string | null;
	account_no?: string | null;
	account_holder?: string | null;
	statement_period?: string | null;
	opening_balance?: number | null;
	closing_balance?: number | null;
	transactions?: StatementTransaction[];
	[key: string]: unknown;
};

export type InterpFile = {
	// client-root-relative path, e.g. "ข้อมูลระบบ/_segments/seg-001/interpretation.json"
	path: string;
	segmentId: string;
	json: Interpretation;
};

// Unit-identity fields on a links.yaml member, additive alongside document_no
// (client-345 defect: three page-77 payment slips all carried document_no:
// null and were otherwise indistinguishable — see unit-key.ts's
// documentUnitId). Optional so a links.yaml written before this change still
// parses; readers must degrade explicitly (see missingUnitIdentity below)
// rather than silently treat a pre-existing file as if every member carried
// one.
export type LinkMember = {
	segment?: string;
	document_no?: string | null;
	role?: string;
	source_file?: string | null;
	source_page?: number | null;
	source_sheet?: string | null;
	unit_ordinal?: number | null;
};

export type LinkCluster = {
	transaction_id?: string;
	segments?: string[];
	members?: LinkMember[];
	bookable_docs?: (string | null)[];
	evidence?: string;
	confidence?: string;
};

// The physical unit (source file + page/sheet + document identity string) a
// links.yaml member resolves to — group-skeleton's answer to "which physical
// pages does this group's evidence live on", carried forward for a follow-up
// stage to consume (page-claiming at group-populate/build-review-data time).
export type DocumentUnit = {
	segment: string | null;
	role: string | null;
	document_no: string | null;
	source_file: string;
	source_page: number | null;
	source_sheet: string | null;
	unit_ordinal: number | null;
	unit_key: string;
};

// Converts one cluster's members into DocumentUnits, using unit-key.ts's
// documentUnitId as the single place a unit_key string gets built (never
// reimplement that format here). Members written before this change (no
// source_file) can't be resolved to a unit — those are counted in
// `missing` rather than silently dropped, so a caller can warn instead of
// pretending the whole cluster is fully backed by unit identity.
// links.yaml is loaded with LINKS_YAML_OPTS (groups-io.ts), which deliberately
// resolves EVERY int/float scalar to its exact source STRING so a long or
// leading-zero document_no survives. That applies to source_page/unit_ordinal
// too, so a member written as `source_page: 62` arrives here as `"62"`, and a
// bare `typeof === "number"` test silently nulls every page in a real run
// (proved against samples/_incidents/345-04-69: all 218 manifest evidence_units
// came out source_page: null, unit_key ".pdf#d1"). Accept an integer-shaped
// string as well; anything else is still "no identity".
function intField(value: unknown): number | null {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
	return null;
}

export function evidenceUnitsOf(cluster: LinkCluster): { units: DocumentUnit[]; missing: number } {
	const units: DocumentUnit[] = [];
	let missing = 0;
	for (const member of cluster.members ?? []) {
		if (typeof member.source_file !== "string" || !member.source_file) {
			missing++;
			continue;
		}
		const page = intField(member.source_page);
		const unitOrdinal = intField(member.unit_ordinal);
		const ordinal = unitOrdinal ?? 1;
		units.push({
			segment: member.segment ?? null,
			role: member.role ?? null,
			document_no: member.document_no ?? null,
			source_file: member.source_file,
			source_page: page,
			source_sheet: typeof member.source_sheet === "string" ? member.source_sheet : null,
			unit_ordinal: unitOrdinal,
			unit_key: documentUnitId(
				member.source_file,
				page,
				typeof member.source_sheet === "string" ? member.source_sheet : null,
				ordinal,
			),
		});
	}
	return { units, missing };
}

export type SegmentSourceRef = {
	file: string;
	pages: [number, number] | null;
	sheets: string[] | null;
};

// ---------------------------------------------------------------------------
// Classification

export function isStatementShaped(interp: Interpretation): boolean {
	// A real statement carries statement-shaped rows (date_iso/balance), not just
	// any `transactions` array — Stage-2 children have improvised invoice-cluster
	// lists under the same key, and misfiling those as bank_statement drops the
	// money from the books (_262 seg-024).
	const rows = interp.transactions;
	if (Array.isArray(rows) && rows.length > 0)
		return rows.every(
			(r) => r != null && typeof r === "object" && ("date_iso" in r || "balance" in r),
		);
	// Mixed scans (invoices plus a few statement pages) are document segments
	// with bookable docs — only an all-statement segment books as bank_statement.
	// "generic" alone is not evidence of a statement (a report bundle like a
	// purchase-tax-report row list is all doc_kind: "generic" too — _356 seg-007);
	// require at least one document actually typed bank_statement, with only
	// incidental boilerplate ("generic") pages alongside it.
	const kinds = (interp.documents ?? []).map((d) => d.doc_kind).filter(Boolean);
	if (kinds.length === 0) return false;
	return kinds.includes("bank_statement") && kinds.every((k) => k === "bank_statement" || k === "generic");
}

export function docCategory(interp: Interpretation): "expense" | "income" | "bank_statement" {
	if (isStatementShaped(interp)) return "bank_statement";
	const direction = interp.accounting_facts?.direction;
	if (direction === "expense" || direction === "income") return direction;
	throw new Error(
		`cannot classify interpretation (accounting_facts.direction is "${direction ?? "missing"}", expected expense|income, and no statement shape)`,
	);
}

// Loan-draw heuristic for income-bound documents. docCategory classifies
// purely from direction, so a loan/OD draw — money in, but a financing inflow
// (a liability), not revenue — lands in income silently (_336: receipts
// RE2026050001/08/11, ~฿290K of director OD loans headed for sales revenue).
// Whether a receipt is revenue or a loan is bookkeeping judgment the scripts
// must not make ("agents judge, scripts copy"): detection never re-routes the
// category and never throws, it only flags the group so a human re-routes it.
export const LOAN_DRAW_WARNING =
	"income document looks like a loan draw (เงินกู้ยืม/OD — financing inflow, not sales revenue) — placement kept as-is, a human must re-categorize this to a loan/liability account";

// Thai loan words are unambiguous on their own; "OD" is not — a bare
// substring would hit PRODUCT/GOODS/CODE, so it only counts as a standalone
// word (Thai letters are non-word chars to \b, so "เงินOD" still matches).
// Case-insensitive so a lowercase "od" ("รับเงิน od จากกรรมการ") is caught too;
// \b still guards against matching inside product/goods/code.
export const LOAN_TEXT = /เงินกู้|กู้ยืม|overdraft|loan[ _-]?draw/i;
export const OD_WORD = /\bOD\b/i;

// For validate-interpretation's credit-note sign check: document_role only,
// deliberately NOT a LOAN_TEXT-style description/line-item text fallback.
// Description text mentioning "credit note"/ใบลดหนี้ fires on the ORIGINAL
// invoice a credit note reduces just as often as on the note itself ("a
// same-day credit note partially reduces this invoice") — a text fallback
// flags the wrong document. document_role alone, checked against the _345
// run, tagged exactly the three real credit notes with zero false positives;
// readers already tag this role reliably, the observed failure is forgetting
// to negate the amount once it's tagged, not mislabeling.
export const CREDIT_NOTE_ROLE = /credit[_ ]?note/i;

export function looksLikeLoanDraw(
	facts: AccountingFacts | null | undefined,
	lineItems: InterpLineItem[],
	documents?: InterpDocument[] | null,
): boolean {
	// Signal A — an interpretation that already names the role. The schema shows
	// document_role by example (supplier_invoice, …), not as a closed enum, so
	// any role naming a loan counts (loan_receipt, loan_draw, loan_agreement, …).
	for (const doc of documents ?? [])
		if (typeof doc.document_role === "string" && doc.document_role.toLowerCase().includes("loan"))
			return true;
	// Signal B — description wording (the _336 case: document_role absent, but
	// facts/line descriptions all say เงินกู้ยืม OD).
	const texts = [facts?.description, ...lineItems.map((line) => line.description)];
	return texts.some(
		(text) => typeof text === "string" && (LOAN_TEXT.test(text) || OD_WORD.test(text)),
	);
}

// Single source of truth for the income-bound loan-draw flag. Bakes in the
// `category === "income"` guard so it can't drift across the three call sites
// (planGroups documentDraft, buildDocumentGroupInterpretation,
// buildDocumentReviewData). Returns the warning string to push, or null.
export function loanDrawWarningFor(
	category: GroupPlan["category"],
	facts: AccountingFacts | null | undefined,
	lineItems: InterpLineItem[],
	documents?: InterpDocument[] | null,
): string | null {
	if (category !== "income") return null;
	return looksLikeLoanDraw(facts, lineItems, documents) ? LOAN_DRAW_WARNING : null;
}

// Per-line VAT evidence: vat_treatment ("vat_7"/"non_vat") wins, then vat_rate
// (7/0). "unknown" when the line carries neither.
export function lineVat(line: InterpLineItem): "vat" | "non_vat" | "unknown" {
	if (line.vat_treatment === "vat_7") return "vat";
	if (line.vat_treatment === "non_vat") return "non_vat";
	if (line.vat_rate === 7) return "vat";
	if (line.vat_rate === 0) return "non_vat";
	return "unknown";
}

// Document VAT bucket: all lines vat -> vat, none -> non_vat, both -> mixed.
// Lines without per-line evidence fall back to the document-level facts.vat
// amount (> 0 means the document carries VAT).
export function classifyVat(
	lines: InterpLineItem[],
	facts: AccountingFacts | undefined,
): "vat" | "non_vat" | "mixed" {
	const factsVat = (facts?.vat ?? 0) ? "vat" : "non_vat";
	const kinds = new Set(
		lines.map((line) => {
			const kind = lineVat(line);
			return kind === "unknown" ? factsVat : kind;
		}),
	);
	if (kinds.size === 0) return factsVat as "vat" | "non_vat";
	if (kinds.size > 1) return "mixed";
	return [...kinds][0] as "vat" | "non_vat";
}

// Path-safe group-id fragment from a document number / segment id. Keeps
// alphanumerics (incl. Thai), collapses everything path-hostile to "-".
export function slugify(text: string): string {
	return (
		text
			.replace(/[\\/:*?"<>|#\s]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "doc"
	);
}

// ---------------------------------------------------------------------------
// Group planning (group-skeleton)

export type GroupPlan = {
	id: string;
	path: string; // bucket-relative group path, e.g. "expense/vat/001-INV123"
	label: string;
	category: "expense" | "income" | "bank_statement";
	vat_treatment: "vat" | "non_vat" | "mixed" | null;
	segments: string[];
	bookable_doc: string | null;
	transaction_id: string | null;
	confidence: string;
	populate: "script" | "agent";
	// client-root-relative interpretation paths
	primary_interpretation: string | null;
	evidence_interpretations: string[];
	source_ref: string | null;
	warnings: string[];
	// Physical units (file+page+ordinal) of every member of this group's
	// links.yaml transaction cluster — "which pages does this group's evidence
	// live on", the question a follow-up stage needs answered to make every
	// group claim the pages of its own evidence (not just its primary
	// document's). Empty when there's no cluster (links.yaml skipped) or the
	// cluster predates this field (old links.yaml, no unit identity on its
	// members) — see the `missing` count folded into `warnings` at plan time.
	evidence_units: DocumentUnit[];
};

export type PlanResult = {
	groups: GroupPlan[];
	warnings: string[];
	// True when links.yaml predates unit identity ENTIRELY (every cluster
	// member with any members at all carries no source_file — see
	// linksPredatesUnitIdentity below) AND that gap actually suppressed the
	// completeness invariant's ability to confirm at least one unnumbered
	// document is claimed. group-skeleton.ts uses this to pick a distinct
	// non-zero exit code for "written, but degraded — re-run linking" instead
	// of folding it into the same 0 as a clean pass (see that file's own
	// exit-code contract for why silent success would hide this).
	degraded: boolean;
};

// A multi-document interpretation file (one ksk-watson dispatch window that
// legitimately bundles several independent documents — see the sub-range
// dispatch contract in SKILL.md) puts each document's own accounting_facts /
// line_items somewhere other than the file's top level — nested inside
// documents[i], flat on documents[i] itself, or in a parallel top-level
// transactions[] array keyed by transaction_id. A "document record" normalizes
// every shape to the same {facts, lineItems} pair so matching and
// classification work identically regardless of which one a given
// ksk-watson child happened to write. `bundled` is true whenever the record
// came from one entry among several sharing a file (any of the three
// multi-document shapes) rather than being the file's sole document —
// group-populate's 1:1 file copy can never isolate one bundled document's
// facts/lines from its siblings, so bundled matches always still need
// ksk-marple even when the match itself is clean. `sourceEntry` carries the
// raw entry only so duplicate-page collapsing can check
// usable_for_booking/evidence_role; it is null for the whole-file fallback
// and for transactions[]-block records (which don't repeat per physical page).
export type DocRecord = {
	file: InterpFile;
	bundled: boolean;
	sourceEntry: Record<string, unknown> | null;
	facts: AccountingFacts;
	lineItems: InterpLineItem[];
};

// Not every ksk-watson child nests a document's facts under accounting_facts
// — some write document_no/gross_total/vat/etc. directly on the documents[i]
// entry instead, with direction/seller/buyer left to the file-level
// accounting_facts (shared across the whole batch, e.g. "27 receipts from the
// same supplier"). Both shapes are legitimate free-form agent output; accept
// either.
export function isExcludedFromMatch(entry: Record<string, unknown> | null): boolean {
	if (!entry) return false;
	if (entry.usable_for_booking === false) return true;
	const role = typeof entry.evidence_role === "string" ? entry.evidence_role : "";
	return role.includes("duplicate");
}

function factsRichness(facts: AccountingFacts): number {
	return Object.values(facts).filter((v) => v != null && v !== "").length;
}

// Two entries sharing a literal document_no are the SAME physical document
// (an original + its sparse totals page, or one document split across two
// adjacent dispatch sub-files) only when their facts don't actively
// disagree — a shared number alone is not evidence of sameness (handwritten
// receipt books commonly reuse small numbers like "46" across unrelated
// documents; real regression: ยนต์ทวี "46" gross ฿1,400 vs หงส์ทิพย์ "46"
// gross ฿45, client _345). Compatible = every fact both entries carry
// non-null agrees; either side missing a fact is not a conflict (that's the
// gap-filling case this function still needs to allow).
function factsCompatible(a: AccountingFacts, b: AccountingFacts): boolean {
	if (a.gross_total != null && b.gross_total != null && a.gross_total !== b.gross_total)
		return false;
	const sellerA = typeof a.seller_name === "string" ? a.seller_name.trim() : null;
	const sellerB = typeof b.seller_name === "string" ? b.seller_name.trim() : null;
	if (sellerA && sellerB && sellerA !== sellerB) return false;
	return true;
}

// ksk-watson tags EVERY page of one multi-page document with that document's
// number (an "original" page carrying full facts, a "totals page" repeating
// just the number, an excluded "duplicate copy" scan) — and the same document
// can also land in two adjacent ≤15-page dispatch sub-files when a fixed
// window happens to straddle it. Treating each page-level entry as its own
// candidate would either double-count the same document as several groups or
// make a clean match look "ambiguous" (ksk_dispositions overlap). Collapse
// entries sharing one document_no into a single record: prefer the richest
// entry not flagged as a duplicate/non-bookable page, filling any gaps in its
// facts from its siblings.
function collapseByDocumentNo(records: DocRecord[]): DocRecord[] {
	const groups = new Map<string, DocRecord[]>();
	const standalone: DocRecord[] = [];
	for (const record of records) {
		const no = record.facts.document_no;
		if (typeof no === "string" && no) {
			const list = groups.get(no) ?? [];
			list.push(record);
			groups.set(no, list);
		} else standalone.push(record);
	}
	const collapsed: DocRecord[] = [...standalone];
	for (const list of groups.values()) {
		if (list.length === 1) {
			collapsed.push(list[0]);
			continue;
		}
		// Partition into conflict-free buckets FIRST — a shared document_no only
		// justifies merging when nothing about the records actually conflicts.
		// Two genuinely different documents that coincidentally share a number
		// (the ยนต์ทวี/หงส์ทิพย์ "46" collision) must come out as two separate
		// records, not one merged-away record picked by "richness".
		const buckets: DocRecord[][] = [];
		for (const record of list) {
			const bucket = buckets.find((b) => b.every((r) => factsCompatible(r.facts, record.facts)));
			if (bucket) bucket.push(record);
			else buckets.push([record]);
		}
		for (const bucket of buckets) {
			if (bucket.length === 1) {
				collapsed.push(bucket[0]);
				continue;
			}
			const candidates = bucket.filter((r) => !isExcludedFromMatch(r.sourceEntry));
			const pool = candidates.length ? candidates : bucket;
			const [best, ...rest] = [...pool].sort(
				(a, b) => factsRichness(b.facts) - factsRichness(a.facts),
			);
			const mergedFacts: AccountingFacts = { ...best.facts };
			for (const other of rest)
				for (const [key, value] of Object.entries(other.facts))
					if ((mergedFacts as Record<string, unknown>)[key] == null && value != null)
						(mergedFacts as Record<string, unknown>)[key] = value;
			const lineItems = pool.find((r) => r.lineItems.length)?.lineItems ?? [];
			collapsed.push({
				file: best.file,
				bundled: best.bundled,
				sourceEntry: best.sourceEntry,
				facts: mergedFacts,
				lineItems,
			});
		}
	}
	return collapsed;
}

// Top-level array keys that are never a per-document collection, even though
// they hold objects: the file's own aggregate line items/flags/questions, and
// the Page Disposition fragment (file/page/disposition, never document_no).
// Scanning any OTHER top-level array is deliberately name-agnostic — Stage-2
// children have used documents[], transactions[], and document_groups[] (and
// will likely invent more) for the exact same "several documents bundled in
// one dispatch window" shape; chasing each name individually is a losing
// game. A per-entry check (nested accounting_facts, or a flat document_no)
// is what actually identifies a document candidate, not the array's name.
const NON_DOCUMENT_ARRAY_KEYS = new Set(["line_items", "review_flags", "questions_for_user", "page_disposition"]);

function candidateEntries(file: InterpFile): { key: string; entry: Record<string, unknown> }[] {
	const entries: { key: string; entry: Record<string, unknown> }[] = [];
	for (const [key, value] of Object.entries(file.json)) {
		if (NON_DOCUMENT_ARRAY_KEYS.has(key) || !Array.isArray(value)) continue;
		for (const item of value)
			if (item && typeof item === "object") entries.push({ key, entry: item as Record<string, unknown> });
	}
	return entries;
}

// Detect the tolerated-but-non-canonical shapes documentRecordsOf normalizes
// away (canonical = ksk_segment_interpretation.v1, enforced at write-time by
// validate-interpretation.ts). The reader stays tolerant as a safety net, but
// silence would hide the fact that a Stage-2 child ignored its output
// contract — planGroups/prelink surface one warning per issue so the parent
// knows to re-dispatch the writer instead of trusting the normalization.
export function shapeIssuesOf(file: InterpFile): string[] {
	const issues: string[] = [];
	const arrayKeys = new Set<string>();
	const flatKeys = new Set<string>();
	const docNoCounts = new Map<string, number>();
	for (const { key, entry } of candidateEntries(file)) {
		const nested = entry.accounting_facts;
		const hasNested = nested != null && typeof nested === "object";
		const docNo = hasNested
			? (nested as AccountingFacts).document_no
			: entry.document_no;
		if (!hasNested && !(typeof entry.document_no === "string" && entry.document_no)) continue;
		if (key !== "documents") arrayKeys.add(key);
		if (!hasNested) flatKeys.add(key);
		if (typeof docNo === "string" && docNo) docNoCounts.set(docNo, (docNoCounts.get(docNo) ?? 0) + 1);
	}
	for (const key of [...arrayKeys].sort())
		issues.push(`documents bundled under top-level "${key}" (canonical: documents[])`);
	for (const key of [...flatKeys].sort())
		issues.push(`"${key}" entries carry flat document fields without nested accounting_facts`);
	const repeated = [...docNoCounts.entries()].filter(([, n]) => n > 1).map(([no]) => no);
	if (repeated.length)
		issues.push(
			`several entries repeat document_no ${repeated.map((no) => `"${no}"`).join(", ")} (per-page entries?) — collapsed to one document each`,
		);
	return issues;
}

export function documentRecordsOf(file: InterpFile): DocRecord[] {
	const fileFacts = file.json.accounting_facts;
	const raw: DocRecord[] = [];
	for (const { entry } of candidateEntries(file)) {
		const nestedFacts = entry.accounting_facts;
		if (nestedFacts && typeof nestedFacts === "object") {
			raw.push({
				file,
				bundled: true,
				sourceEntry: entry,
				facts: nestedFacts as AccountingFacts,
				lineItems: (entry.line_items as InterpLineItem[] | undefined) ?? [],
			});
			continue;
		}
		if (typeof entry.document_no === "string" && entry.document_no) {
			raw.push({
				file,
				bundled: true,
				sourceEntry: entry,
				facts: {
					direction: fileFacts?.direction ?? null,
					seller_name: fileFacts?.seller_name ?? null,
					seller_tax_id: fileFacts?.seller_tax_id ?? null,
					buyer_name: fileFacts?.buyer_name ?? null,
					buyer_tax_id: fileFacts?.buyer_tax_id ?? null,
					currency: fileFacts?.currency ?? null,
					...entry,
				} as AccountingFacts,
				lineItems: (entry.line_items as InterpLineItem[] | undefined) ?? [],
			});
		}
	}
	if (raw.length > 0) return collapseByDocumentNo(raw);
	return [
		{
			file,
			bundled: false,
			sourceEntry: null,
			facts: fileFacts ?? {},
			lineItems: file.json.line_items ?? [],
		},
	];
}

function firstPageOf(entry: Record<string, unknown>): number | null {
	const pages = Array.isArray(entry.source_pages)
		? entry.source_pages.filter((p): p is number => typeof p === "number")
		: [];
	if (pages.length) return pages[0];
	return typeof entry.source_page === "number" ? entry.source_page : null;
}

// The physical unit a DocRecord's own identity is anchored to — its cover
// page/sheet, not every page it spans (unlike pagesOfDocRecord below, which
// this deliberately does NOT reuse: a unit key names WHICH slot among
// possibly-several documents sharing one page, and a document's identity is
// the first page it's introduced on, not the full span). null when the
// record carries no source_file at all (a Stage-2 shape gap, not this
// document's fault) — callers must treat that as "no unit identity
// available", never invent a page.
export function primaryUnitOfDocRecord(record: DocRecord): { file: string; page: number | null; sheet: string | null } | null {
	if (record.sourceEntry) {
		const file = typeof record.sourceEntry.source_file === "string" ? record.sourceEntry.source_file : null;
		if (!file) return null;
		const sheet = typeof record.sourceEntry.source_sheet === "string" ? record.sourceEntry.source_sheet : null;
		return { file, page: firstPageOf(record.sourceEntry), sheet };
	}
	// whole-file fallback (Shape A, sourceEntry null): the file's own
	// documents[] entries still carry source_file/source_page each even
	// though they hold no accounting_facts/document_no of their own — take
	// the first one, same shape pagesOfDocRecord reads for this fallback.
	for (const doc of record.file.json.documents ?? []) {
		const file = typeof doc.source_file === "string" ? doc.source_file : null;
		if (!file) continue;
		const sheet = typeof doc.source_sheet === "string" ? doc.source_sheet : null;
		return { file, page: firstPageOf(doc as Record<string, unknown>), sheet };
	}
	return null;
}

type PrimaryMatch = {
	file: InterpFile | null;
	bundled: boolean;
	facts: AccountingFacts | null;
	lineItems: InterpLineItem[];
	reason: string | null;
};

function findPrimary(files: InterpFile[], documentNo: string | null): PrimaryMatch {
	if (files.length === 0)
		return { file: null, bundled: false, facts: null, lineItems: [], reason: "no interpretation file for segment" };
	// Per-file collapsing already merged same-document page repeats within one
	// file; a second pass catches the same document number split across two
	// adjacent dispatch sub-files (a fixed ≤15-page window straddling it).
	const records = collapseByDocumentNo(files.flatMap(documentRecordsOf));
	if (documentNo != null) {
		const matches = records.filter((r) => r.facts.document_no === documentNo);
		if (matches.length === 1) {
			const m = matches[0];
			return { file: m.file, bundled: m.bundled, facts: m.facts, lineItems: m.lineItems, reason: null };
		}
		if (matches.length > 1)
			return {
				file: null,
				bundled: false,
				facts: null,
				lineItems: [],
				reason: `document_no "${documentNo}" matches ${matches.length} interpretation files with conflicting facts (different gross_total/seller — likely different physical documents sharing one number, not one document split across files): ${matches.map((m) => m.file?.path ?? "?").join(", ")} — ksk-marple must open each candidate and pick by content, never by file order`,
			};
		return {
			file: null,
			bundled: false,
			facts: null,
			lineItems: [],
			reason: `document_no "${documentNo}" not found in segment interpretations`,
		};
	}
	if (records.length === 1) {
		const m = records[0];
		return { file: m.file, bundled: m.bundled, facts: m.facts, lineItems: m.lineItems, reason: null };
	}
	return {
		file: null,
		bundled: false,
		facts: null,
		lineItems: [],
		reason: "no document_no and segment has several interpretation files",
	};
}

// Approved-bookable signal for one already-per-file-collapsed DocRecord —
// mirrors prelink.ts's fingerprintsOf bookability rule exactly (never drift
// from it): an entry explicitly flagged usable_for_booking:false, or whose
// evidence_role names it a duplicate, is evidence-only (isExcludedFromMatch).
// A Shape-A file (one document, no per-entry nesting — sourceEntry is null,
// see documentRecordsOf's whole-file fallback) has no per-document flag to
// check; it is evidence-only only when EVERY one of its documents[] entries
// is itself excluded (usable_for_booking:false, or a duplicate evidence_role
// — a lone duplicate page amid an otherwise-usable file must not blank out
// the whole document).
//
// BUG-5 FIX (constructed probe, not yet seen on a real client): the previous
// condition — `flagged.length > 0 && flagged.every(false)` — only looked at
// entries that CARRY a usable_for_booking flag at all, so a file with one
// unflagged (real) page and one entry flagged usable_for_booking:false
// (duplicate) had `flagged = [the duplicate]`, and "every flagged entry is
// false" was vacuously true over that one-element set — the WHOLE file came
// back unbookable, even though the unflagged page is a genuine document.
// `documents.some(entry not excluded)` is the correct predicate: the file is
// bookable whenever AT LEAST ONE entry isn't excluded, flagged or not: an
// unflagged entry is never itself a reason to exclude (isExcludedFromMatch
// returns false for it), so it alone is enough to keep the file bookable.
function isFileLevelBookable(file: InterpFile): boolean {
	const documents = file.json.documents ?? [];
	return documents.some((d) => !isExcludedFromMatch(d as Record<string, unknown>));
}

// The schema requires document_no: null (plus a documented warning) when a
// document's number can't be read — but a Stage-2 child occasionally
// substitutes a placeholder (an internal reference/voucher number) instead of
// writing null, flagging the deviation with a "document_no_not_found:
// ..." warning on the entry itself (see references/schemas/segment-
// interpretation.md). That placeholder is not a confirmed document number —
// counting it as its own approved bookable unit would demand a booking under
// a number nobody actually printed. Real case: seg-007/PSL2026-064 (run
// full-345/20260713-1819b) — a payment-voucher number substituted for a
// missing supplier invoice number, correctly merged into a DIFFERENT
// document's booking (TF690410110024) by the linker.
function hasPlaceholderDocumentNo(sourceEntry: Record<string, unknown> | null): boolean {
	if (!sourceEntry) return false;
	const warnings = sourceEntry.warnings;
	if (!Array.isArray(warnings)) return false;
	return warnings.some((w) => typeof w === "string" && w.includes("document_no_not_found"));
}

// BUG-1 FIX (client _345): this used to also require `document_no` to be a
// non-empty string, which made a document with document_no: null structurally
// INVISIBLE to findDroppedBookableUnits below — exactly the class of document
// the linker silently dropped (seg-012's 7 unnumbered documents, only 3 of
// which got a bookable_docs entry). A document with no number is still a real
// document that must land in some group; only isExcludedFromMatch (an
// explicit usable_for_booking:false / duplicate-role flag) or the file-level
// bookable check are legitimate reasons to exempt it. hasPlaceholderDocumentNo
// keeps its existing, separately-tested exemption (a placeholder/substituted
// number, e.g. an internal payment-voucher id standing in for a missing
// invoice number, is deliberately merged as evidence elsewhere by the linker —
// see the "no false positive: a placeholder document_no" regression test);
// broadening that case too would need the linker to name the relationship
// explicitly, which is beyond this fix.
//
// BUG-1 FIX, PART 2 (client _345, same incident): the placeholder exemption
// above was still gated on hasPlaceholderDocumentNo alone, with no check on
// document_no itself — so it fired for BOTH of the two, categorically
// different situations that warning covers:
//   (a) a SUBSTITUTED number: document_no is a non-empty string (a real
//       placeholder/internal id standing in for a missing invoice number —
//       the exemption's actual, original purpose, see above), and
//   (b) a genuinely MISSING number: document_no is null, because
//       ksk-watson.md:69 mandates the identical "document_no_not_found"
//       warning whenever a number is absent or illegible, not only when one
//       was substituted.
// Case (b) is exactly the class this whole fix exists to stop dropping — an
// unnumbered document with the mandated warning is still a real document that
// must land in some group, it is not "explained away" by carrying a warning
// every unnumbered document is required to carry. Without the document_no
// string check, every one of client _345's 7 real unnumbered documents was
// still rejected here (they all carry the mandated warning), the count check
// below computed a shortfall of 0, and planGroups kept returning cleanly —
// the fix above was inert. Require a non-empty document_no before the
// exemption can apply at all, so it only ever covers case (a).
function isApprovedBookable(record: DocRecord): boolean {
	if (
		typeof record.facts.document_no === "string" &&
		record.facts.document_no &&
		hasPlaceholderDocumentNo(record.sourceEntry)
	)
		return false;
	return record.sourceEntry ? !isExcludedFromMatch(record.sourceEntry) : isFileLevelBookable(record.file);
}

// Every physical page an approved-bookable Stage-2 DocRecord actually covers,
// as (source_file, page) pairs — the page-level counterpart to
// findDroppedBookableUnits's segment-level count above. Two shapes to read
// from, matching documentRecordsOf's own two record shapes:
//   - a per-entry record (sourceEntry set): the entry's OWN source_file/
//     source_page/source_pages name exactly the pages that one document
//     covers (segment-interpretation.md: "every documents[] entry carries
//     source_file, source_page"; a multi-page document adds source_pages).
//   - a whole-file fallback record (sourceEntry null, Shape A — one
//     transaction, facts live at the file's top level): the file's own
//     documents[] entries still carry source_file/source_page each (Shape A
//     entries list the single document's pages even though they hold no
//     accounting_facts/document_no of their own) — every one of them belongs
//     to this ONE record, so all of them are this record's pages.
function pagesOfDocRecord(record: DocRecord): { file: string; page: number }[] {
	const out: { file: string; page: number }[] = [];
	const pagesOf = (entry: Record<string, unknown>): number[] => {
		const pages = Array.isArray(entry.source_pages)
			? entry.source_pages.filter((p): p is number => typeof p === "number")
			: [];
		if (pages.length) return pages;
		return typeof entry.source_page === "number" ? [entry.source_page] : [];
	};
	if (record.sourceEntry) {
		const file = typeof record.sourceEntry.source_file === "string" ? record.sourceEntry.source_file : null;
		if (file) for (const page of pagesOf(record.sourceEntry)) out.push({ file, page });
		return out;
	}
	for (const doc of record.file.json.documents ?? []) {
		// BUG-5 FIX: a Shape-A file's own documents[] entries are still
		// individually flagged (usable_for_booking:false / duplicate
		// evidence_role) even though the record itself is one whole-file
		// bookable unit — an excluded entry (e.g. a duplicate scan of a page
		// already counted) must not contribute its page to this record's page
		// set, or an excluded duplicate page would inflate the Stage-2 page
		// census against a page it doesn't actually add a distinct document to.
		if (isExcludedFromMatch(doc as Record<string, unknown>)) continue;
		const file = typeof doc.source_file === "string" ? doc.source_file : null;
		if (!file) continue;
		for (const page of pagesOf(doc as Record<string, unknown>)) out.push({ file, page });
	}
	return out;
}

// Stage-2 CENSUS for build-review-data.ts's page-collision preflight
// (client-345 page 77: three distinct handwritten documents genuinely share
// one physical page) — counts how many DISTINCT approved-bookable Stage-2
// documents (documentRecordsOf, per-file-collapsed, isApprovedBookable —
// mirrors findDroppedBookableUnits's own filter exactly, so an
// evidence-only/duplicate page never inflates the count a real run is held
// to) actually cover each physical page. Keyed the same way build-review-
// data.ts's own claim keys are: `${normalized source_file}#p${page}`.
// Statement-shaped files are skipped — bank_statement groups never enter the
// lines_owner collision check this feeds (see build-review-data.ts).
//
// Deliberately named/documented as a CENSUS, not ground truth: this is a
// cross-check of Stage-4/5 group ownership against Stage-2's OWN documents[]
// count, not an independent observation of the physical page. If ksk-watson
// itself under-counts a page (e.g. reads three handwritten receipts sharing
// one page as a single document), this function inherits that undercount —
// it has no way to see the physical page directly. That residual risk is
// exactly why the final Ledger Gate's unaccounted-unit check (a genuinely
// independent page-vs-Reviewed-state comparison) must stay in place and
// must never be weakened on the strength of this preflight passing.
export function stage2DocumentCountByPage(interpsBySegment: Map<string, InterpFile[]>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const files of interpsBySegment.values()) {
		for (const file of files) {
			if (isStatementShaped(file.json)) continue;
			for (const record of documentRecordsOf(file)) {
				if (!isApprovedBookable(record)) continue;
				for (const { file: srcFile, page } of pagesOfDocRecord(record)) {
					const key = `${srcFile.normalize("NFC")}#p${page}`;
					counts.set(key, (counts.get(key) ?? 0) + 1);
				}
			}
		}
	}
	return counts;
}

// Stage-2 truth (interpsBySegment) vs. what actually landed in the finished
// group plan — catches the "sherlock link-drop" class of bug where an
// approved bookable document silently never becomes a group (dropped by
// links.yaml / the linker, not excluded by any Stage-2 evidence). Keyed
// ALWAYS by (segment_id, document_no), never bare document_no — the same
// number legitimately recurs across different segments (BUG-2: group ids are
// segment-prefixed precisely so two segments each booking a doc "46" stay two
// groups; this invariant must not treat one as covering the other).
//
// Deliberately counts RAW per-file-collapsed records rather of reusing
// findPrimary's cross-file collapseByDocumentNo pass. That pass exists to
// resolve one KNOWN target document_no against a segment's dispatch files,
// correctly merging a single document legitimately split across two adjacent
// ≤15-page windows — but applied here it would erase the exact signal this
// invariant exists to catch: two DIFFERENT documents that coincidentally
// share a document_no within one segment (the real regression: ยนต์ทวี "46"
// merged into หงส์ทิพย์ "46" by that same collapse, silently dropping the
// steel bill — see groups-lib.test.ts). documentRecordsOf's own per-FILE
// collapse still runs (legitimately merging one document's repeated pages —
// an original + its totals page — within a single dispatch file); only the
// second, cross-file pass is skipped here.
//
// A file that never won primary for any group of its own, but that some
// group cites as evidence, was deliberately demoted by the linker to a
// supporting role (a shared payment receipt for someone else's invoice —
// the cluster member `role` isn't visible here, but `evidence_interpretations`
// records the same decision). Its OWN document_no is then legitimately never
// its own bookable unit, not a drop — UNLESS that document_no is the SAME
// number as the bookable_doc it's supposedly supporting: same-segment
// dispatch-window collisions (the real regression: ยนต์ทวี "46" merged into
// หงส์ทิพย์ "46") get marked "evidence" for that same "46" group purely as a
// side effect of sharing a segment, not because they're a genuinely
// different supporting document — that case must still be counted, or the
// exact bug this invariant exists to catch becomes invisible again. Suppress
// only per (file, document_no) — a bundled file that legitimately dropped a
// DIFFERENT document of its own still gets that document flagged even while
// another of its documents is correctly explained as evidence.
// Substring unique to findDroppedBookableUnits's "unnumbered" message shape
// below (never emitted by the "numbered" gross-mismatch message, which never
// contains the literal words "document_no,") — planGroups uses this to split
// its own findDroppedBookableUnits() result into the two classes described at
// evidenceUnitsOf/missingUnitIdentity: a numbered-document drop is always a
// real defect, but an unnumbered-document drop can ALSO be a false positive
// produced by a links.yaml that predates unit identity (evidenceClaimedPageCounts
// has nothing to match against when no member carries source_file, so the
// "claimed as evidence" exemption never fires even for a document that really
// is accounted for). Defined once here, not duplicated as a regex at the call
// site, so the two can never drift apart.
export const UNNUMBERED_SHORTFALL_MARKER = "approved-bookable document(s) with no document_no,";

export function findDroppedBookableUnits(
	interpsBySegment: Map<string, InterpFile[]>,
	groups: GroupPlan[],
): string[] {
	const booked = new Map<string, number>();
	// file path -> document_nos this file itself won primary for (a file can be
	// primary for several of its bundled documents across different groups —
	// see the multi-document-dispatch-window case below).
	const primaryDocNoForFile = new Map<string, Set<string>>();
	const evidenceFor = new Map<string, Set<string>>(); // file path -> bookable_docs it supports
	for (const group of groups) {
		if (group.primary_interpretation && typeof group.bookable_doc === "string" && group.bookable_doc) {
			const set = primaryDocNoForFile.get(group.primary_interpretation) ?? new Set<string>();
			set.add(group.bookable_doc);
			primaryDocNoForFile.set(group.primary_interpretation, set);
		}
		if (typeof group.bookable_doc === "string" && group.bookable_doc) {
			for (const path of group.evidence_interpretations) {
				const set = evidenceFor.get(path) ?? new Set<string>();
				set.add(group.bookable_doc);
				evidenceFor.set(path, set);
			}
			for (const seg of group.segments) {
				const key = `${seg} ${group.bookable_doc}`;
				booked.set(key, (booked.get(key) ?? 0) + 1);
			}
		}
	}

	// Count DISTINCT physical documents per (segment, document_no), not raw
	// records: two records sharing a number are the same document (one invoice
	// straddling two ≤15-page dispatch windows, or an original + its sparse
	// totals page) UNLESS their gross genuinely conflicts — only a real
	// dispatch-window collision (two DIFFERENT documents that coincidentally
	// share a number, e.g. ยนต์ทวี "46" vs หงส์ทิพย์ "46") yields two distinct
	// grosses and must be flagged. Statement-shaped files are skipped: planGroups
	// routes them to statementDraft with bookable_doc: null (they never enter
	// `booked`), so counting a statement's own reference number here would throw
	// on a clean run.
	// BUG-1 FIX (client _345): the check above only ever recognized a bookable
	// document by its document_no — it was structurally blind to a document
	// with no number at all (isApprovedBookable used to exclude those
	// entirely). A document_no-keyed exact match is impossible for an
	// unnumbered document (there is no key), so it gets a SEPARATE, coarser
	// signal instead: count how many approved-bookable unnumbered documents
	// Stage-2 produced for this segment, and compare against how many groups
	// group-skeleton actually created for an unnumbered document in that same
	// segment (bookable_doc: null, not a bank_statement — those always carry
	// bookable_doc: null too but are a different kind of group entirely). A
	// segment producing more unnumbered documents than it got groups means the
	// linker dropped the difference — exactly what happened to seg-012 (7
	// unnumbered documents, only 3 links.yaml bookable_docs:null entries).
	// This is deliberately a COUNT, not a page-anchored match: nothing at plan
	// time names which physical page an eventual agent-populated group will
	// end up claiming, so an exact per-document match isn't available here —
	// only the reciprocal, page-level check in build-review-data.ts (after
	// populate) can catch two groups both claiming the SAME page. A segment
	// whose unnumbered documents are legitimately evidence-only (not every
	// document is bookable) must have that recorded as an explicit
	// usable_for_booking:false / duplicate evidence_role — undocumented
	// unbookable-ness is exactly the ambiguity this check refuses to paper
	// over (see the fix's open question about client _345's own pages 81/85/87).
	// DEFECT FIX (client 345, month 04-69, 2026-07-27 incident): the remediation
	// text this check prints used to tell the reader to "flag them
	// usable_for_booking:false" — i.e. edit Stage-2's already-approved
	// interpretation files. That is the EXACT tampering
	// decision-policy.md's "Evidence immutability" section and
	// segments-integrity.ts now forbid and mechanically block (Stage-2's
	// `_segments/**` is content-hash-stamped the moment `--gate interpret`
	// passes; editing it after that fails `segments-integrity verify` loudly).
	// Two mechanisms in this repo were instructing opposite actions. The
	// correct response to this block is never to edit evidence — it is either
	// (a) a real re-link: re-run ksk-sherlock/prelink over the residue so the
	// linker actually claims the document (as its own bookable slot, or as an
	// evidence_units member of an existing cluster), or (b) if the document is
	// genuinely evidence-only and no rule can express that without editing
	// Stage 2, report the block for a human to resolve — never silently
	// demote it by hand.
	// BUG-3 FIX (client _352, seg-005/seg-009): crediting a slot to EVERY
	// segment a cluster spans double-counts a single unnumbered group across
	// each of its segments — a two-segment null-bookable_doc group (one such
	// group is on disk today: 352/เดือน พ.ค's seg-005-ID_NOT_FOUND_1, segments
	// [seg-005, seg-009]) would satisfy the shortfall check in BOTH segments
	// even though only one of the two unnumbered documents can ever be booked
	// by it. A group is one physical slot, not one slot per segment it spans —
	// attribute it to exactly ONE segment: the segment that owns its
	// primary_interpretation file (the document the group is actually built
	// around), falling back to the first evidence_interpretations file's
	// segment, then to the first of group.segments, when primary_interpretation
	// is null (fallback shapes only — plan-time drafts always set one of these).
	const pathToSegment = new Map<string, string>();
	for (const [segmentId, files] of interpsBySegment) for (const file of files) pathToSegment.set(file.path, segmentId);
	const unnumberedGroupCountBySegment = new Map<string, number>();
	for (const group of groups) {
		if (group.category === "bank_statement") continue;
		if (group.bookable_doc != null) continue;
		const attributedSegment =
			(group.primary_interpretation && pathToSegment.get(group.primary_interpretation)) ||
			(group.evidence_interpretations.map((p) => pathToSegment.get(p)).find((s): s is string => !!s)) ||
			group.segments[0];
		if (!attributedSegment) continue;
		unnumberedGroupCountBySegment.set(attributedSegment, (unnumberedGroupCountBySegment.get(attributedSegment) ?? 0) + 1);
	}

	// DEFECT FIX (client 345, month 04-69, 2026-07-27 incident): the count
	// above only credits a segment for its OWN null-bookable_doc groups — it
	// is blind to an unnumbered document the linker deliberately placed as
	// `supporting_evidence` inside a NUMBERED cluster (real case: an
	// unnumbered payment advice on page 62 lands inside a numbered draft's
	// evidence_units, so it never gets its own bookable_doc:null group). That
	// document is NOT dropped — it is claimed, just by someone else's group —
	// but the segment-wide group count above still saw it as unaccounted for,
	// producing a false-positive hard block. Build a second, unit-level pool:
	// every unnumbered (document_no: null) evidence_units entry across EVERY
	// group, regardless of that group's own bookable_doc, keyed by (segment,
	// physical unit). Below, an unnumbered Stage-2 record first checks this
	// pool before falling back to the coarser group-count comparison — so a
	// document actually claimed via evidence_units is recognized, while one
	// claimed by NOTHING (no group slot, no evidence membership) still falls
	// through to the group-count check and can still trip it. This narrows
	// false positives without loosening the gate: a genuinely dropped document
	// finds nothing in either pool and is still reported below.
	//
	// SHARED WITH build-review-data.ts's page-level preflight (the
	// evidence-page-claims fix): this pool used to be built inline here, keyed
	// by (segment, cover-page unit id), and build-review-data.ts's
	// preflightBuiltGroups had NO equivalent — it only ever recognized a
	// lines_owner:true claim, so a document exempted HERE (accounted for as
	// evidence) still hard-failed THERE for lacking a PRIMARY owner, because
	// evidence claims are deliberately written lines_owner:false. That
	// contradiction meant a correct linker decision could never pass both
	// gates. evidenceClaimedPageCounts (below, shared with build-review-
	// data.ts) is now the ONE place either guard computes "is this physical
	// page accounted for by some group's own evidence_units" — never
	// reimplement this matching separately again, or the two checks WILL
	// drift apart the same way.
	//
	// Mutated by decrement below as each produced record consumes one claim —
	// a fresh copy so repeated calls (tests) never see cross-call state.
	const claimedRemaining = evidenceClaimedPageCounts(groups, interpsBySegment);

	const missing: string[] = [];
	for (const [segmentId, files] of [...interpsBySegment.entries()].sort()) {
		const grosses = new Map<string, Set<number>>();
		let unnumberedRecordCount = 0;
		for (const file of files) {
			if (isStatementShaped(file.json)) continue;
			const ownPrimaryDocs = primaryDocNoForFile.get(file.path);
			const supportedDocs = evidenceFor.get(file.path);
			for (const record of documentRecordsOf(file)) {
				if (!isApprovedBookable(record)) continue;
				const no = record.facts.document_no;
				if (typeof no !== "string" || !no) {
					// Claimed as evidence inside some (possibly numbered) cluster? Consume
					// one unit from the shared pool instead of counting it as a shortfall —
					// see evidenceClaimedPageCounts above for why a segment-wide group count
					// alone can't see this. Keyed by physical page only (no segment
					// prefix) — a physical (file, page) pair belongs to exactly one
					// segment in practice (segmentation partitions pages), and this is
					// the SAME key format the page-level preflight check reads.
					const unit = primaryUnitOfDocRecord(record);
					if (unit) {
						const key =
							unit.sheet != null
								? `${norm(unit.file)}#s${unit.sheet}`
								: unit.page != null
									? `${norm(unit.file)}#p${unit.page}`
									: null;
						if (consumeEvidenceClaims(claimedRemaining, key, 1) > 0) continue;
					}
					unnumberedRecordCount++;
					continue;
				}
				// A document_no exempts itself from the "dropped" flag only when it
				// is NOT the one this file itself won primary for (that document is
				// always counted below) AND it's recorded as evidence for some other
				// group's bookable_doc — checked per document_no, not per file, so a
				// multi-document dispatch-window file that won primary for one of its
				// bundled documents doesn't wipe out the correctly-recorded evidence
				// exemptions for its OTHER bundled documents.
				const isOwnPrimaryDoc = ownPrimaryDocs?.has(no) ?? false;
				if (!isOwnPrimaryDoc && supportedDocs && !supportedDocs.has(no)) continue; // explained as evidence for a different doc
				const set = grosses.get(no) ?? new Set<number>();
				const g =
					typeof record.facts.gross_total === "number"
						? record.facts.gross_total
						: typeof record.facts.net_paid === "number"
							? record.facts.net_paid
							: null;
				if (g != null) set.add(g);
				grosses.set(no, set);
			}
		}
		for (const [no, set] of [...grosses.entries()].sort())
			if (Math.max(set.size, 1) > (booked.get(`${segmentId} ${no}`) ?? 0)) missing.push(`${segmentId} / ${no}`);
		if (unnumberedRecordCount > 0) {
			const have = unnumberedGroupCountBySegment.get(segmentId) ?? 0;
			if (unnumberedRecordCount > have)
				missing.push(
					`${segmentId} / unnumbered (${unnumberedRecordCount} approved-bookable document(s) with no document_no, claimed by neither a group slot nor an evidence_units membership, only ${have} ungrouped-document slot(s) created — linker dropped ${unnumberedRecordCount - have}; never hand-edit Stage-2's _segments/** to clear this (evidence is frozen and mechanically checked — see decision-policy.md's "Evidence immutability") — re-run ksk-sherlock/prelink over the residue so the linker actually claims these documents, or report the block for a human to resolve)`,
				);
		}
	}
	return missing;
}

function sourceRefOf(
	segments: string[],
	segmentSources: Map<string, SegmentSourceRef[]>,
): string | null {
	const parts: string[] = [];
	for (const id of segments) {
		for (const src of segmentSources.get(id) ?? []) {
			if (src.pages) parts.push(`${src.file} p.${src.pages[0]}-${src.pages[1]}`);
			else if (src.sheets?.length) parts.push(`${src.file} [${src.sheets.join(", ")}]`);
			else parts.push(src.file);
		}
	}
	return parts.length ? parts.join("; ") : null;
}

// Plan one group per bookable_docs entry (with links.yaml), or one per
// interpretation file (fallback when linking was skipped). Populate mode is
// decided here, conservatively: a group is script-copyable only when its
// bookable doc resolves to exactly one interpretation file whose
// accounting_facts.document_no equals it, and no other group claims the same
// file as primary — anything needing line selection or disambiguation stays
// with ksk-marple.
export function planGroups(
	clusters: LinkCluster[] | null,
	interpsBySegment: Map<string, InterpFile[]>,
	segmentSources: Map<string, SegmentSourceRef[]>,
): PlanResult {
	const warnings: string[] = [];
	// tolerated shape variants get flagged, never silently normalized — the
	// canonical shape is enforced at write-time by validate-interpretation.ts
	for (const [, files] of [...interpsBySegment.entries()].sort())
		for (const file of files)
			for (const issue of shapeIssuesOf(file))
				warnings.push(
					`non-canonical interpretation shape in ${file.path}: ${issue} — tolerated, but re-dispatch the Stage-2 child with the canonical shape (bun run validate-interpretation)`,
				);
	type Draft = Omit<GroupPlan, "id" | "path" | "label"> & { slugBase: string };
	const drafts: Draft[] = [];

	// Whole-file detection for the pre-migration degrade path (requirement:
	// distinguish "this links.yaml has no unit identity anywhere" — degrade —
	// from "this links.yaml has unit identity but one member is missing it" —
	// stays an error). Summed across every cluster with at least one member
	// (an empty members: [] cluster, e.g. one hand-authored before members
	// existed at all, carries no signal either way and must not count toward
	// either total). `clusterMemberTotal === clusterMissingUnitTotal` (and
	// both > 0) means LITERALLY EVERY member in the whole file predates unit
	// identity — a mixed file (even a single member missing it beside others
	// that carry it) fails this and is treated as the real-defect case.
	let clusterMemberTotal = 0;
	let clusterMissingUnitTotal = 0;

	const statementDraft = (file: InterpFile, cluster?: LinkCluster): Draft => ({
		slugBase: file.segmentId,
		category: "bank_statement",
		vat_treatment: null,
		segments: [file.segmentId],
		bookable_doc: null,
		transaction_id: cluster?.transaction_id ?? null,
		confidence: cluster?.confidence ?? "high",
		populate: "script",
		primary_interpretation: file.path,
		evidence_interpretations: [],
		source_ref: sourceRefOf([file.segmentId], segmentSources),
		warnings: [],
		evidence_units: cluster ? evidenceUnitsOf(cluster).units : [],
	});

	// Document groups whose bookable doc number is unknown get a loud
	// ID_NOT_FOUND_<n> sentinel instead of a slug (statement groups keep their
	// segment-id slug: bank statements legitimately have no document number).
	// <n> is a caller-supplied index scoped to the immediate cluster/segment
	// this draft came from — never a plan-wide counter. A plan-wide counter
	// would make every later placeholder's number (and, before the id-stability
	// fix below, its whole folder path) shift whenever an unrelated
	// transaction earlier in links.yaml is added or removed.
	const documentDraft = (
		match: PrimaryMatch,
		bookableDoc: string | null,
		segments: string[],
		evidence: string[],
		cluster: LinkCluster | null,
		placeholderIndex: number,
	): Draft => {
		const { file: primary, bundled, facts, lineItems, reason: primaryReason } = match;
		const groupWarnings: string[] = [];
		let populate: "script" | "agent" = "script";
		if (!primary || !facts) {
			populate = "agent";
			groupWarnings.push(primaryReason ?? "primary interpretation unresolved");
		} else if (bookableDoc != null && facts.document_no !== bookableDoc) {
			populate = "agent";
			groupWarnings.push(
				`primary interpretation document_no "${facts.document_no ?? "null"}" != bookable doc "${bookableDoc}" — needs line selection`,
			);
		} else if (bundled) {
			// Matched document lives inside a multi-document interpretation file
			// (one ksk-watson dispatch window bundling several documents) — a
			// straight 1:1 file copy would pull in every bundled document's
			// facts/lines, so this still needs ksk-marple even though the match
			// itself is clean.
			populate = "agent";
			groupWarnings.push(
				`matched document is one of several bundled in ${primary.path} — needs ksk-marple to isolate its facts/lines`,
			);
		}
		let category: GroupPlan["category"] = "expense";
		let vat: GroupPlan["vat_treatment"] = "non_vat";
		if (primary && facts) {
			category = docCategory({ accounting_facts: facts });
			vat = classifyVat(lineItems, facts);
			if (category === "income" && vat === "mixed") {
				vat = "vat";
				groupWarnings.push(
					"income document mixes VAT and non-VAT lines — placed in income/vat, review the split (no income/mixed bucket exists)",
				);
			}
			// a bundled file holds several documents' roles side by side — only the
			// matched record's own facts/lines are safe to read for this group
			const loanWarning = loanDrawWarningFor(
				category,
				facts,
				lineItems,
				bundled ? null : primary.json.documents,
			);
			if (loanWarning) groupWarnings.push(loanWarning);
		} else {
			groupWarnings.push("category/vat provisional (no primary interpretation) — ksk-marple populate must confirm");
		}
		let slugBase = bookableDoc ?? "";
		if (!slugBase) {
			slugBase = `ID_NOT_FOUND_${placeholderIndex + 1}`;
			groupWarnings.push(
				`document number not found — placeholder id ${slugBase}; verify the source document, and if a number exists re-dispatch its Stage-2 reader`,
			);
		}
		return {
			slugBase,
			category,
			vat_treatment: category === "bank_statement" ? null : vat,
			segments,
			bookable_doc: bookableDoc,
			transaction_id: cluster?.transaction_id ?? null,
			confidence: cluster?.confidence ?? "high",
			populate,
			primary_interpretation: primary?.path ?? null,
			evidence_interpretations: evidence,
			source_ref: sourceRefOf(segments, segmentSources),
			warnings: groupWarnings,
			evidence_units: cluster ? evidenceUnitsOf(cluster).units : [],
		};
	};

	if (clusters) {
		const coveredSegments = new Set<string>();
		for (const cluster of clusters) {
			const members = cluster.members ?? [];
			const segments = cluster.segments ?? members.map((m) => m.segment ?? "").filter(Boolean);
			for (const id of segments) coveredSegments.add(id);
			// Backward compat: a links.yaml written before unit identity existed
			// (or a writer that skipped it) has members with no source_file — that
			// must degrade explicitly, not silently produce an empty evidence_units
			// as if the pages were checked and found to be none.
			const { missing: missingUnits } = evidenceUnitsOf(cluster);
			if (missingUnits > 0 && members.length > 0) {
				warnings.push(
					`transaction ${cluster.transaction_id ?? "?"}: ${missingUnits} of ${members.length} member(s) carry no unit identity (source_file/source_page) — pre-migration links.yaml, or a writer that didn't carry it forward from links.draft.yaml; this group's evidence_units is incomplete`,
				);
				clusterMemberTotal += members.length;
				clusterMissingUnitTotal += missingUnits;
			} else if (members.length > 0) {
				clusterMemberTotal += members.length;
			}
			// Keep null entries (an unnamed-but-real bookable document) alongside real
			// doc-number strings — only empty strings and non-string/non-null junk
			// are dropped here. Each entry, including nulls, gets its own group
			// below; documentDraft's !slugBase branch assigns nulls a per-entry
			// ID_NOT_FOUND_<n> placeholder instead of silently vanishing.
			const bookableDocs = (cluster.bookable_docs ?? []).filter(
				(d): d is string | null => d === null || (typeof d === "string" && d.length > 0),
			);
			// statement cluster: single member whose interpretation is statement-shaped
			const allFiles = segments.flatMap((id) => interpsBySegment.get(id) ?? []);
			if (allFiles.length > 0 && allFiles.every((f) => isStatementShaped(f.json))) {
				for (const file of allFiles) drafts.push(statementDraft(file, cluster));
				continue;
			}
			if (bookableDocs.length === 0) {
				warnings.push(
					`cluster ${cluster.transaction_id ?? "?"}: no bookable_docs — one agent-populated group created for review`,
				);
				drafts.push(
					documentDraft(
						{ file: null, bundled: false, facts: null, lineItems: [], reason: "cluster has no bookable_docs" },
						null,
						segments,
						allFiles.map((f) => f.path),
						cluster,
						0, // sole draft for this cluster — no sibling placeholders to disambiguate
					),
				);
				continue;
			}
			// index scoped to THIS cluster's own bookable_docs list — stable
			// regardless of unrelated clusters being added/removed elsewhere in
			// links.yaml (BUG-2: a plan-wide counter here previously let two
			// different transactions' placeholder groups collide on the same
			// folder path across reruns).
			let clusterPlaceholderIdx = 0;
			for (const doc of bookableDocs) {
				// the member that owns this document number names the primary segment
				const owner = members.find((m) => m.document_no === doc);
				const ownerFiles = owner?.segment
					? (interpsBySegment.get(owner.segment) ?? [])
					: allFiles;
				const match = findPrimary(ownerFiles, doc);
				const evidence = allFiles
					.filter((f) => f.path !== match.file?.path)
					.map((f) => f.path);
				const placeholderIndex = doc ? -1 : clusterPlaceholderIdx++;
				drafts.push(documentDraft(match, doc, segments, evidence, cluster, placeholderIndex));
			}
		}
		// segments never mentioned by links.yaml still become groups (sherlock
		// guarantees full coverage, but a skipped/partial links file must not
		// silently drop money)
		for (const [segmentId, files] of [...interpsBySegment.entries()].sort()) {
			if (coveredSegments.has(segmentId)) continue;
			warnings.push(`segment ${segmentId} not covered by links.yaml — standalone group(s) created`);
			// scoped to this segment's own files/records only — see clusterPlaceholderIdx above
			let segPlaceholderIdx = 0;
			for (const file of files) {
				if (isStatementShaped(file.json)) {
					drafts.push(statementDraft(file));
					continue;
				}
				for (const record of documentRecordsOf(file)) {
					const doc = record.facts.document_no ?? null;
					const placeholderIndex = doc ? -1 : segPlaceholderIdx++;
					drafts.push(documentDraft({ ...record, reason: null }, doc, [segmentId], [], null, placeholderIndex));
				}
			}
		}
	} else {
		for (const [segmentId, files] of [...interpsBySegment.entries()].sort()) {
			// scoped to this segment's own files/records only — see clusterPlaceholderIdx above
			let segPlaceholderIdx = 0;
			for (const file of files) {
				if (isStatementShaped(file.json)) {
					drafts.push(statementDraft(file));
					continue;
				}
				for (const record of documentRecordsOf(file)) {
					const doc = record.facts.document_no ?? null;
					const placeholderIndex = doc ? -1 : segPlaceholderIdx++;
					drafts.push(documentDraft({ ...record, reason: null }, doc, [segmentId], [], null, placeholderIndex));
				}
			}
		}
	}

	// a file claimed as primary by more than one group needs per-group line
	// selection — demote all its groups to agent populate
	const primaryCount = new Map<string, number>();
	for (const draft of drafts)
		if (draft.primary_interpretation)
			primaryCount.set(
				draft.primary_interpretation,
				(primaryCount.get(draft.primary_interpretation) ?? 0) + 1,
			);
	for (const draft of drafts) {
		if (
			draft.populate === "script" &&
			draft.category !== "bank_statement" &&
			draft.primary_interpretation &&
			(primaryCount.get(draft.primary_interpretation) ?? 0) > 1
		) {
			draft.populate = "agent";
			draft.warnings.push(
				"interpretation file shared as primary by several groups — needs per-group line selection",
			);
		}
	}

	// Stable ids derived from content, never from position in `drafts` — the
	// same transaction/document must map to the same folder across reruns
	// regardless of insertions/removals elsewhere in links.yaml (BUG-1: a
	// creation-order numeric prefix shifted every later group's id when one
	// earlier transaction was removed, orphaning its old populated folder).
	// segments (from Stage 1) are themselves stable identifiers unaffected by
	// links.yaml edits, so the first one (sorted) makes a stable, readable
	// prefix; the doc-number/placeholder slug disambiguates within it.
	const baseGroups: GroupPlan[] = drafts.map((draft) => {
		const { slugBase, ...rest } = draft;
		// Statement drafts' slugBase is already the segment id (globally unique
		// on its own) — prefixing it again would just read as
		// "seg-009-seg-009". Document drafts need the segment prefix because a
		// bare document number (or ID_NOT_FOUND placeholder) is not unique
		// across segments (BUG-2: two segments can each book a doc "46").
		const primarySegment = rest.segments.length ? [...rest.segments].sort()[0] : "group";
		const id =
			rest.category === "bank_statement" ? slugify(slugBase) : `${primarySegment}-${slugify(slugBase)}`;
		const bucket =
			rest.category === "bank_statement"
				? "bank_statement"
				: `${rest.category}/${rest.vat_treatment}`;
		return {
			id,
			path: `${bucket}/${id}`,
			label: rest.bookable_doc
				? `${rest.bookable_doc} (${rest.segments.join(", ")})`
				: rest.segments.join(", "),
			...rest,
		};
	});

	// Two distinct documents must never collapse onto the same folder path —
	// scoped placeholder indices and segment-derived prefixes are designed to
	// prevent this in the common case, but a genuine same-segment,
	// same-document_no collision (two DIFFERENT physical documents that
	// coincidentally share a number, each claimed by its own transaction —
	// the ยนต์ทวี/หงส์ทิพย์ "46" case, client _345) legitimately produces two
	// groups with the same (segment, document_no) pair. Both are ambiguous
	// (primary_interpretation: null) precisely because group-skeleton can't
	// tell them apart by content — but their transaction_id (from links.yaml,
	// itself stable across reruns) DOES tell them apart, so use it to
	// disambiguate the path before giving up. Only a real, unresolvable
	// collision (no transaction_id, or the same transaction_id reused) still
	// throws.
	const pathGroups = new Map<string, GroupPlan[]>();
	for (const group of baseGroups) {
		const list = pathGroups.get(group.path) ?? [];
		list.push(group);
		pathGroups.set(group.path, list);
	}
	const groups: GroupPlan[] = [];
	const collisions: string[] = [];
	for (const [path, list] of pathGroups) {
		if (list.length === 1) {
			groups.push(list[0]);
			continue;
		}
		const txnIds = list.map((g) => g.transaction_id);
		const disambiguatable =
			txnIds.every((t): t is string => typeof t === "string" && t.length > 0) &&
			new Set(txnIds).size === list.length;
		if (!disambiguatable) {
			collisions.push(path);
			continue;
		}
		const bucket = path.slice(0, path.length - list[0].id.length - 1);
		for (const group of list) {
			const id = `${group.id}-${slugify(group.transaction_id as string)}`;
			groups.push({ ...group, id, path: `${bucket}/${id}` });
		}
	}
	if (collisions.length)
		throw new Error(
			`group id collision — distinct documents would share the same folder: ${collisions.join(", ")} — inspect links.yaml/segments for the cause; not auto-resolved.`,
		);

	// completeness invariant: every approved bookable Stage-2 document must
	// land in some group — a hard block, not a warning, because the only
	// recovery is re-linking/re-inspecting links.yaml, never auto-backfilling
	// (that would book into a guessed category and paper over a clustering bug).
	//
	// BACK-COMPAT DEGRADE (evidence-page-claims branch): a links.yaml written
	// before unit identity existed has NO member anywhere carrying source_file
	// — evidenceClaimedPageCounts (shared with build-review-data.ts) then has
	// nothing to match an unnumbered document against, so the "claimed as
	// evidence inside some cluster" exemption below can never fire, and every
	// unnumbered document that genuinely IS accounted for still reports as
	// dropped (real incident: samples/_incidents/345-04-69-2026-07-27-blocked
	// — a links.yaml with zero source_file fields anywhere, 4 approved-bookable
	// unnumbered seg-012 documents, only 3 ungrouped-document slots, hard exit
	// on every run). That is a limitation of THIS invariant's own inputs, not a
	// real linking defect, and must not be reported as one. Detected narrowly:
	// only when EVERY cluster member in the WHOLE file lacks unit identity
	// (clusterMemberTotal === clusterMissingUnitTotal, both > 0) — a links.yaml
	// that has unit identity on some members but is missing it on even one
	// (a genuine writer bug in a CURRENT-format file) does not qualify, and
	// still hard-fails below like any other real defect.
	//
	// Only the "unnumbered" class of finding depends on unit identity (the
	// "numbered" gross-mismatch class above never reads source_file at all) —
	// so even on a pre-migration file, a numbered drop is still a real defect
	// and still hard-fails; only the unnumbered class degrades to a warning.
	const missing = findDroppedBookableUnits(interpsBySegment, groups);
	if (missing.length) {
		const linksPredatesUnitIdentity = clusterMemberTotal > 0 && clusterMissingUnitTotal === clusterMemberTotal;
		const unnumbered = linksPredatesUnitIdentity
			? missing.filter((m) => m.includes(UNNUMBERED_SHORTFALL_MARKER))
			: [];
		const numbered = missing.filter((m) => !unnumbered.includes(m));
		if (numbered.length)
			throw new Error(
				`bookable documents dropped between Stage-2 and grouping (segment_id / document_no): ${numbered.join("; ")} — links.yaml/clustering lost these. Re-run Stage 3 linking or inspect links.yaml; not auto-recovered.`,
			);
		if (unnumbered.length) {
			warnings.push(
				`links.yaml predates unit identity (no cluster member anywhere carries source_file/source_page) — ${unnumbered.length} segment(s)' unnumbered-document counts could not be reliably confirmed, so this check is DEGRADED rather than a hard block: ${unnumbered.join("; ")}. This is not a defect found in this run: it means the link graph was built by an older version of this tool, before per-page unit identity existed. Re-run Stage 3 linking (ksk-sherlock / prelink) over this client-month to regenerate links.yaml with unit identity, then re-run group-skeleton — do not hand-edit ข้อมูลระบบ/_segments/** or links.yaml to clear this.`,
			);
			return { groups, warnings, degraded: true };
		}
	}

	return { groups, warnings, degraded: false };
}

// Bucket/id directories that exist on disk from a previous group-skeleton run
// but no longer appear in the freshly computed plan — i.e. the transaction/
// document they held is gone from links.yaml (removed, deduped, re-clustered
// elsewhere). With stable content-derived ids (see planGroups above) a group
// that's still current always keeps its existing path, so anything left over
// here is genuinely stale, never a live group whose id merely shifted.
// group-skeleton deletes these so a rerun never leaves orphaned
// interpretation.json/categorize.json behind under a dead path (BUG-1).
export function orphanedGroupDirs(existingPaths: string[], freshGroups: GroupPlan[]): string[] {
	const fresh = new Set(freshGroups.map((g) => g.path));
	return existingPaths.filter((p) => !fresh.has(p));
}

// ---------------------------------------------------------------------------
// Populate (group-populate) — 1:1 copy, no judgment

// used pages per source file, from the interpretation's own page_disposition
export function usedPagesByFile(interp: Interpretation): Map<string, number[]> {
	const byFile = new Map<string, number[]>();
	for (const entry of interp.page_disposition ?? []) {
		if (entry.disposition !== "used" || typeof entry.file !== "string") continue;
		if (entry.page == null) continue;
		const pages = byFile.get(entry.file) ?? [];
		pages.push(entry.page);
		byFile.set(entry.file, pages);
	}
	for (const pages of byFile.values()) pages.sort((a, b) => a - b);
	return byFile;
}

export function usedSheetsByFile(interp: Interpretation): Map<string, string[]> {
	const byFile = new Map<string, string[]>();
	for (const entry of interp.page_disposition ?? []) {
		if (entry.disposition !== "used" || typeof entry.file !== "string") continue;
		if (entry.sheet == null) continue;
		const sheets = byFile.get(entry.file) ?? [];
		sheets.push(entry.sheet);
		byFile.set(entry.file, sheets);
	}
	return byFile;
}

export type GroupDocument = InterpDocument & {
	source_pages: number[] | null;
	// true on documents copied from the primary interpretation (the ones the
	// group's line items belong to); false on shared payment/evidence documents
	lines_owner: boolean;
};

export type GroupInterpretation = {
	schema: typeof GROUP_INTERPRETATION_SCHEMA;
	group_id: string;
	category: GroupPlan["category"];
	vat_treatment: GroupPlan["vat_treatment"];
	bookable_doc: string | null;
	segments: string[];
	transaction: { transaction_id: string | null; evidence: string | null } | null;
	facts: AccountingFacts;
	documents: GroupDocument[];
	line_items: InterpLineItem[];
	review_flags: unknown[];
	questions_for_user: unknown[];
	// statement groups only
	statement?: {
		bank: string | null;
		account_no: string | null;
		account_holder: string | null;
		period: string | null;
		opening_balance: number | null;
		closing_balance: number | null;
	};
	source?: {
		source_src: string | null;
		source_page: number | null;
		source_pages: number[] | null;
		source_sheet: string | null;
		image_src: null;
	};
	transactions?: StatementTransaction[];
};

function toGroupDocuments(interp: Interpretation, linesOwner: boolean): GroupDocument[] {
	const usedPages = usedPagesByFile(interp);
	return (interp.documents ?? []).map((doc) => ({
		...doc,
		source_pages: doc.source_file ? (usedPages.get(doc.source_file) ?? null) : null,
		lines_owner: linesOwner,
	}));
}

export function buildDocumentGroupInterpretation(
	plan: GroupPlan,
	primary: Interpretation,
	evidence: Interpretation[],
	clusterEvidence: string | null,
): GroupInterpretation {
	const reviewFlags = [...(primary.review_flags ?? [])];
	// income-bound loan draw: placement stays as planned, but the flag is what
	// routes the group to a human — review_flags is exactly what makes
	// buildDocumentReviewData mark every page initial_status: needs_attention.
	// Only the primary's own documents are consulted (evidence docs join the
	// group later in `documents`, but the flag is a primary-facts claim) —
	// buildDocumentReviewData mirrors this by filtering to lines_owner docs.
	const loanWarning = loanDrawWarningFor(
		plan.category,
		primary.accounting_facts,
		primary.line_items ?? [],
		primary.documents,
	);
	if (loanWarning && !reviewFlags.includes(loanWarning)) reviewFlags.push(loanWarning);
	return {
		schema: GROUP_INTERPRETATION_SCHEMA,
		group_id: plan.id,
		category: plan.category,
		vat_treatment: plan.vat_treatment,
		bookable_doc: plan.bookable_doc,
		segments: plan.segments,
		transaction: plan.transaction_id
			? { transaction_id: plan.transaction_id, evidence: clusterEvidence }
			: null,
		facts: primary.accounting_facts ?? {},
		documents: [
			...toGroupDocuments(primary, true),
			...evidence.flatMap((interp) => toGroupDocuments(interp, false)),
		],
		line_items: primary.line_items ?? [],
		review_flags: reviewFlags,
		questions_for_user: primary.questions_for_user ?? [],
	};
}

export function buildStatementGroupInterpretation(
	plan: GroupPlan,
	interp: Interpretation,
	source: { file: string; pages: [number, number] | null; sheets: string[] | null } | null,
): GroupInterpretation {
	const usedSheets = source ? usedSheetsByFile(interp).get(source.file) : undefined;
	return {
		schema: GROUP_INTERPRETATION_SCHEMA,
		group_id: plan.id,
		category: "bank_statement",
		vat_treatment: null,
		bookable_doc: null,
		segments: plan.segments,
		transaction: null,
		facts: interp.accounting_facts ?? {},
		documents: toGroupDocuments(interp, true),
		line_items: [],
		review_flags: interp.review_flags ?? [],
		questions_for_user: interp.questions_for_user ?? [],
		statement: {
			bank: interp.bank ?? null,
			account_no: interp.account_no ?? null,
			account_holder: interp.account_holder ?? null,
			period: interp.statement_period ?? null,
			opening_balance: interp.opening_balance ?? null,
			closing_balance: interp.closing_balance ?? null,
		},
		source: {
			source_src: source?.file ?? null,
			source_page: source?.pages ? source.pages[0] : null,
			source_pages: source?.pages
				? Array.from(
						{ length: source.pages[1] - source.pages[0] + 1 },
						(_, i) => source.pages![0] + i,
					)
				: null,
			source_sheet: source?.sheets?.[0] ?? usedSheets?.[0] ?? null,
			image_src: null,
		},
		transactions: interp.transactions ?? [],
	};
}

// ---------------------------------------------------------------------------
// Review-data build (build-review-data)

// A links.yaml evidence unit only ever names its COVER page (unitId/
// documentUnitId are anchored to a document's first page, deliberately not
// its full span — see primaryUnitOfDocRecord above), but the real Stage-2
// document it points at can genuinely span more than one physical page
// (client-345: txn-158's page-62 payment_advice is a 2-page KBIZ transfer
// slip that continues onto page 63 — the Stage-2 record itself carries
// source_pages: [62, 63]). Claiming only the cover page would leave page 63
// exactly as unclaimed as before this fix. Resolves the unit back to its
// full page span by re-finding the Stage-2 documents[] entry it was built
// from — same (segment, source_file, source_page) triple, disambiguated by
// unit_ordinal among any other entries sharing that exact page (the same
// "position among page-mates" contract unit-key.ts documents). Falls back to
// the single cover page whenever no match is found (a links.yaml unit that
// outlived a Stage-2 re-dispatch which changed shape) — degrading to "claim
// at least the cover page" rather than claiming nothing.
// DEFECT FIX (evidence-page-claims branch, Defect 2): this used to scan the
// RAW, uncollapsed `file.json.documents` array and index into it with
// `unit_ordinal`. But prelink's assignUnitOrdinals (prelink.ts) numbers
// ordinals over documentRecordsOf's PER-FILE-COLLAPSED records, not the raw
// array — a file where one document's original page and its sparse totals
// page collapse into a SINGLE record (same document_no, collapseByDocumentNo)
// has fewer records than raw documents[] entries, so the two orderings
// diverge the moment a collapse actually happens. Example: raw documents[] =
// [A, B] where A and B are two page-level entries of a single document
// bundled with, say, an unrelated document C in between — documentRecordsOf
// collapses A+B into one record while assignUnitOrdinals numbers ordinals
// over the COLLAPSED sequence; reading the raw array here would resolve
// ordinal #2 to the wrong (and often incomplete) document, silently dropping
// whichever page only the true record #2 covers. Read the exact same
// documentRecordsOf ordering prelink used to assign the ordinal in the first
// place (via primaryUnitOfDocRecord/pagesOfDocRecord, both already used
// elsewhere in this file) — never a second, independently-derived ordering.
export function pagesOfEvidenceUnit(unit: DocumentUnit, interpsBySegment: Map<string, InterpFile[]>): number[] {
	if (unit.source_page == null) return [];
	const files = unit.segment
		? (interpsBySegment.get(unit.segment) ?? [])
		: [...interpsBySegment.values()].flat();
	const wantFile = norm(unit.source_file);
	const matches: number[][] = [];
	for (const file of files) {
		for (const record of documentRecordsOf(file)) {
			const primary = primaryUnitOfDocRecord(record);
			if (!primary || norm(primary.file) !== wantFile || primary.page !== unit.source_page) continue;
			const pages = pagesOfDocRecord(record).map((p) => p.page);
			matches.push(pages.length ? pages : [unit.source_page]);
		}
	}
	const ordinal = unit.unit_ordinal ?? 1;
	return matches[ordinal - 1] ?? [unit.source_page];
}

// SHARED with groups-lib.ts's findDroppedBookableUnits (segment-level) and
// build-review-data.ts's preflightBuiltGroups (page-level) — the single place
// either check may ask "is this physical page/sheet accounted for by some
// group's own evidence_units". Before this existed the two checks answered
// that question independently and drifted apart: findDroppedBookableUnits
// exempted an unnumbered evidence-claimed document at the segment level, but
// the page-level check had no equivalent notion at all — it only recognized
// a lines_owner:true (PRIMARY) claim, and an evidence claim is deliberately
// written lines_owner:false (see withEvidenceClaims), so a document the
// linker correctly judged to be supporting evidence could pass the segment
// check and still hard-fail the page check for lacking a primary owner, with
// every legitimate way to satisfy both simultaneously closed off. Expands
// every evidence_units member to its FULL resolved page span via
// pagesOfEvidenceUnit (a multi-page document must be exempted on every page
// it covers, not just its cover page) — the same expansion withEvidenceClaims
// itself performs when it turns these into actual lines_owner:false review-
// data claims, so the exemption always tracks what claimsFromFresh will
// actually see on disk.
// DEDUP FIX (evidence-page-claims regression, real client-345 shape: a page
// carrying 3 distinct Stage-2 documents, all 3 legitimately claimed as
// evidence — 2 by one group, 1 by another): this used to bump +1 per
// (group, evidence_unit, page) TRIPLE with no de-duplication, so two groups
// legitimately citing the very SAME evidence document inflated a page's
// count by 2 instead of 1. That silently widened the exemption window a
// dropped THIRD document on that page could hide behind — the page guard
// below only ever compares `ownerCount + evidenceCount >= docCount`, so an
// inflated evidenceCount can mask an actual drop. Two groups citing the same
// document is not two documents; it is one document with two citers. Dedupe
// per page by the citing unit's own `unit_key` (unit-key.ts's
// documentUnitId — unique per physical document+ordinal, the same identity
// prelink/linking already treats as ground truth) so a page's count answers
// "how many DISTINCT Stage-2 documents are evidence-claimed here", never
// "how many citations exist" — that is the quantity both guards actually
// need, and it's what makes `owner=0 docs=2 evidence=2` correctly split into
// "same document twice" (still an issue) vs "two different documents" (not).
//
// SELF-CLAIM FIX (found verifying this fix end-to-end against the real
// client-345 snapshot: 3 unnumbered documents on one page, each linked as its
// own standalone one-member transaction — exactly what a mechanical residue
// stand-in produces, and a legitimate shape a real linker call produces too).
// group.evidence_units is EVERY member of that group's OWN cluster, which
// necessarily includes the group's OWN bookable document alongside any
// genuinely separate supporting evidence — a one-member cluster's evidence_units
// is nothing BUT that group's own document. Counting it into the shared "spare
// evidence available to cover a shortfall" pool double-spends the same claim:
// once as this group's OWN owner count, again as slack that could paper over a
// DIFFERENT document dropped from the same page (reproduced: dropping the 3rd
// of 3 one-member-cluster groups on a page left the other two's own claims
// sitting in the pool, silently absorbing the shortfall). A multi-member
// cluster has the same shape from a sibling's point of view: cluster
// {primary A, primary B, evidence C, evidence D} attaches ALL FOUR members to
// BOTH group A and group B's evidence_units, so excluding only "MY OWN
// bookable_doc" from each group's own contribution still leaves B's primary
// counted as evidence via A's contribution (and vice versa) — the exclusion
// has to be CLUSTER-wide, not per-citing-group. Collect every group's own
// bookable_doc keyed by transaction_id first, then drop any evidence_units
// member whose document_no is SOME group's own bookable_doc within that same
// transaction — never by document_no alone across different clusters/transaction_ids
// (document numbers collide by coincidence between unrelated real documents —
// see factsCompatible's "46" example above — so scoping by transaction_id is
// required, not optional).
export function evidenceClaimedPageCounts(
	groups: GroupPlan[],
	interpsBySegment: Map<string, InterpFile[]>,
): Map<string, Set<string>> {
	const ownDocsByTransaction = new Map<string, Set<string | null>>();
	for (const group of groups) {
		if (!group.transaction_id) continue;
		const set = ownDocsByTransaction.get(group.transaction_id) ?? new Set<string | null>();
		set.add(group.bookable_doc);
		ownDocsByTransaction.set(group.transaction_id, set);
	}
	const seenPerPage = new Map<string, Set<string>>();
	const bump = (pageKey: string, unitKey: string) => {
		const seen = seenPerPage.get(pageKey) ?? new Set<string>();
		seen.add(unitKey);
		seenPerPage.set(pageKey, seen);
	};
	for (const group of groups) {
		const ownDocs = group.transaction_id ? ownDocsByTransaction.get(group.transaction_id) : null;
		// `?? []` guards fixture/test GroupPlan literals predating this field —
		// bun's test runner strips types without checking them, so a literal
		// missing evidence_units would otherwise throw here at runtime, not just
		// fail a type check.
		for (const unit of group.evidence_units ?? []) {
			if (ownDocs?.has(unit.document_no)) continue; // some group's OWN primary claim in this cluster, not spare evidence
			if (unit.source_sheet != null) {
				bump(`${norm(unit.source_file)}#s${unit.source_sheet}`, unit.unit_key);
				continue;
			}
			if (unit.source_page == null) continue; // no page/sheet identity to claim at all
			for (const page of pagesOfEvidenceUnit(unit, interpsBySegment)) {
				bump(`${norm(unit.source_file)}#p${page}`, unit.unit_key);
			}
		}
	}
	return seenPerPage;
}

// STRUCTURAL FIX (evidence-page-claims regression, part 2): the segment-level
// guard (findDroppedBookableUnits, below) and the page-level guard
// (build-review-data.ts's preflightBuiltGroups) already shared this file's
// evidenceClaimedPageCounts as their one data source — and still disagreed,
// because sharing a SOURCE only guarantees both read the same numbers, not
// that both assign the same MEANING to them. The segment guard consumed
// (decremented a mutable remaining-count so one claim can explain at most
// one shortfall); the page guard only ever read a running total and never
// consumed, so the exact same claim could silently paper over more shortfall
// than it actually accounts for. Route every exemption decision through this
// one function — both guards call it, neither reimplements the arithmetic —
// so a future change to what "an evidence claim covers a shortfall" means
// only has one place to change, and cannot quietly diverge again the way it
// just did. `remainingByPage` holds SETS of distinct unit_keys (not raw
// counts) precisely so consuming here removes one distinct DOCUMENT's worth
// of coverage, never a citation's worth.
export function consumeEvidenceClaims(
	remainingByPage: Map<string, Set<string>>,
	pageKey: string | null,
	needed: number,
): number {
	if (needed <= 0 || !pageKey) return 0;
	const remaining = remainingByPage.get(pageKey);
	if (!remaining || remaining.size === 0) return 0;
	let used = 0;
	for (const unitKey of remaining) {
		if (used >= needed) break;
		remaining.delete(unitKey);
		used++;
	}
	return used;
}

// Adds one synthetic, lines_owner:false GroupDocument per evidence_unit whose
// physical page(s)/sheet aren't already covered by an existing document in
// the group's interpretation — the fix for the client-345 regression where an
// evidence page's fate ("does this group end up claiming it") hinged entirely
// on whether the populate step (group-populate's script copy, or ksk-marple's
// manual populate) happened to list it: one group's populate copied its
// payment-voucher evidence page, a structurally identical group's did not,
// and the page silently never reached Reviewed at the Page Ledger three
// stages later. evidence_units (populated by planGroups from the group's own
// links.yaml transaction cluster, carried on the manifest — see GroupPlan)
// is ground truth for "which pages this group's evidence lives on" independent
// of whatever populate happened to copy, so this makes every one of them a
// claim regardless. Called for every group at build-review-data time (not
// group-populate time) so it also covers populate: agent groups, where no
// script ever runs at all. A no-op (returns `interp` unchanged) when
// evidenceUnits is empty — including the pre-migration links.yaml case
// (evidenceUnitsOf's `missing` count), which planGroups already surfaces as
// its own warning; there is nothing here to add for a unit that carries no
// source_file/source_page/source_sheet at all.
export function withEvidenceClaims(
	interp: GroupInterpretation,
	evidenceUnits: DocumentUnit[],
	interpsBySegment: Map<string, InterpFile[]>,
): GroupInterpretation {
	if (evidenceUnits.length === 0) return interp;
	const covered = new Set<string>();
	for (const doc of interp.documents) {
		const file = doc.source_file ?? doc.artifact ?? null;
		if (!file) continue;
		const normFile = norm(file);
		if (doc.source_sheet != null) covered.add(`${normFile}#s${doc.source_sheet}`);
		if (typeof doc.source_page === "number") covered.add(`${normFile}#p${doc.source_page}`);
		for (const p of doc.source_pages ?? []) covered.add(`${normFile}#p${p}`);
	}
	const added: GroupDocument[] = [];
	for (const unit of evidenceUnits) {
		const normFile = norm(unit.source_file);
		if (unit.source_sheet != null) {
			const key = `${normFile}#s${unit.source_sheet}`;
			if (covered.has(key)) continue;
			covered.add(key);
			added.push({
				source_file: unit.source_file,
				source_page: null,
				source_pages: null,
				source_sheet: unit.source_sheet,
				evidence_role: "supporting_evidence",
				lines_owner: false,
			});
			continue;
		}
		if (unit.source_page == null) continue; // no page/sheet identity to claim at all
		const pages = pagesOfEvidenceUnit(unit, interpsBySegment).filter(
			(p) => !covered.has(`${normFile}#p${p}`),
		);
		if (pages.length === 0) continue;
		for (const p of pages) covered.add(`${normFile}#p${p}`);
		added.push({
			source_file: unit.source_file,
			source_page: pages[0],
			source_pages: pages,
			source_sheet: null,
			evidence_role: "supporting_evidence",
			lines_owner: false,
		});
	}
	if (added.length === 0) return interp;
	return { ...interp, documents: [...interp.documents, ...added] };
}

export type CategorizeLine = {
	line_index?: number;
	account_code?: string;
	sub_code?: string;
	account_name_th?: string;
	confidence?: string;
	reason?: string;
	needs_review?: boolean;
};

export type CategorizeFile = {
	group_id?: string;
	lines?: CategorizeLine[];
	bank_account_code?: string | null;
	bank_sub_code?: string | null;
	questions_for_user?: unknown[];
};

export type DefaultBuyer = { name: string | null; tax_id: string | null };

const CONFIDENCES = new Set(["low", "medium", "high"]);

function categorizeByIndex(categorize: CategorizeFile): Map<number, CategorizeLine> {
	const map = new Map<number, CategorizeLine>();
	for (const line of categorize.lines ?? [])
		if (Number.isInteger(line.line_index)) map.set(line.line_index as number, line);
	return map;
}

function mergedLine(
	index: number,
	item: InterpLineItem,
	cat: CategorizeLine | undefined,
	perLineVat: boolean,
): Record<string, unknown> {
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
		confidence: cat && CONFIDENCES.has(cat.confidence ?? "") ? cat.confidence : "low",
		reason: cat?.reason ?? (cat ? "" : "no categorize entry for this line"),
		needs_review: cat?.needs_review ?? true,
	};
}

function factsVatTreatment(vat: GroupPlan["vat_treatment"]): string {
	if (vat === "vat") return "vat_7";
	if (vat === "non_vat") return "non_vat";
	return ""; // mixed: per-line vat_treatment drives the export
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

// One pages[] entry per distinct source file among the group's documents; the
// lines_owner file(s) carry the line items, evidence files claim their pages
// with no lines. This is what makes every page of the group reach Reviewed at
// the final Ledger Gate.
export function buildDocumentReviewData(
	group: GroupInterpretation,
	categorize: CategorizeFile,
	defaultBuyer: DefaultBuyer | null,
	groupDirRel: string, // client-root-relative group folder path
): Record<string, unknown> {
	const facts = group.facts;
	const catByIndex = categorizeByIndex(categorize);
	const perLineVat = group.category === "expense" && group.vat_treatment === "mixed";
	const lines = group.line_items.map((item, index) =>
		mergedLine(index, item, catByIndex.get(index), perLineVat),
	);
	// income-bound loan draws must reach a human even when a populate agent
	// wrote the group interpretation without carrying the flag over (script
	// populate adds LOAN_DRAW_WARNING to review_flags; this is the net for
	// agent-populated groups). Consult only the lines-owner/primary documents —
	// the same set buildDocumentGroupInterpretation checks (primary.documents) —
	// so a loan-role EVIDENCE doc alone does not silently flip needs_attention
	// with no matching flag text written anywhere.
	const primaryDocuments = group.documents.filter((doc) => doc.lines_owner);
	const loanWarning = loanDrawWarningFor(
		group.category,
		facts,
		group.line_items,
		primaryDocuments,
	);
	// Surface the group interpretation's review_flags to the reviewer, plus the
	// deterministic loan-draw warning when it fires here and isn't already
	// present (agent-populated groups whose interpretation dropped the flag).
	const reviewFlags = group.review_flags.map(String);
	if (loanWarning && !reviewFlags.includes(loanWarning)) reviewFlags.push(loanWarning);
	const anyReview =
		lines.some((l) => l.needs_review || l.confidence !== "high") ||
		group.review_flags.length > 0 ||
		group.questions_for_user.length > 0 ||
		(categorize.questions_for_user ?? []).length > 0 ||
		loanWarning != null;
	const grossTotal = facts.gross_total ?? null;
	const vatAmount = facts.vat ?? null;
	const pageFacts = {
		date: facts.document_date ?? null,
		document_no: facts.document_no ?? null,
		reference: facts.reference ?? null,
		seller: facts.seller_name ?? null,
		seller_tax_id: facts.seller_tax_id ?? null,
		buyer: facts.buyer_name ?? defaultBuyer?.name ?? null,
		buyer_tax_id: facts.buyer_tax_id ?? defaultBuyer?.tax_id ?? null,
		subtotal:
			grossTotal != null && vatAmount != null ? round2(grossTotal - vatAmount) : grossTotal,
		vat: vatAmount,
		total: grossTotal,
		paid: facts.net_paid ?? null,
		// amount withheld as printed on the document — never derived from a rate
		wht: facts.wht ?? null,
		summary: facts.description ?? null,
		vat_treatment: factsVatTreatment(group.vat_treatment),
		// currency of the money fields above — null/THB in the normal case; a
		// non-THB value tells the reviewer the THB amounts are conversions
		currency: facts.currency ?? null,
		// foreign-currency evidence (THB contract in the schema docs): the money
		// fields above are THB; these carry the document's face value so the
		// reviewer can see the conversion instead of digging into the interp file
		original_currency: facts.original_currency ?? null,
		original_amount: facts.original_amount ?? null,
		exchange_rate: facts.exchange_rate ?? null,
	};

	// group documents by source file (per sheet for workbooks — collapsing a
	// multi-sheet claim to one entry silently drops the other sheets from the
	// Page Ledger's Reviewed set): one reviewable entry per file/sheet
	type FileClaim = {
		file: string;
		firstPage: number | null;
		pages: Set<number>;
		sheet: string | null;
		linesOwner: boolean;
	};
	const claims = new Map<string, FileClaim>();
	for (const doc of group.documents) {
		const file = doc.source_file ?? doc.artifact ?? null;
		if (!file) continue;
		const claimKey = doc.source_sheet != null ? `${file}#${doc.source_sheet}` : file;
		const claim = claims.get(claimKey) ?? {
			file,
			firstPage: null,
			pages: new Set<number>(),
			sheet: null,
			linesOwner: false,
		};
		if (doc.source_page != null) {
			claim.pages.add(doc.source_page);
			if (claim.firstPage == null || doc.source_page < claim.firstPage)
				claim.firstPage = doc.source_page;
		}
		for (const p of doc.source_pages ?? []) claim.pages.add(p);
		if (doc.source_sheet != null) claim.sheet = doc.source_sheet;
		claim.linesOwner = claim.linesOwner || doc.lines_owner;
		claims.set(claimKey, claim);
	}
	if (claims.size === 0)
		throw new Error(
			`group ${group.group_id}: no documents with a source_file/artifact — review-data would claim no pages`,
		);

	const pages = [...claims.values()].map((claim) => {
		const base = claim.file.split("/").pop() ?? claim.file;
		const shortRef =
			claim.firstPage != null
				? `${base} p.${claim.firstPage}`
				: claim.sheet != null
					? `${base} [${claim.sheet}]`
					: base;
		return {
			ref: `${group.group_id}/${shortRef}`,
			short_ref: shortRef,
			source_src: claim.file,
			source_page: claim.firstPage,
			source_pages: claim.pages.size ? [...claim.pages].sort((a, b) => a - b) : null,
			source_sheet: claim.sheet,
			image_src: null,
			extract_path: `${groupDirRel}/interpretation.json`,
			categorize_path: `${groupDirRel}/categorize.json`,
			facts: pageFacts,
			lines: claim.linesOwner ? lines : [],
			initial_status: anyReview ? "needs_attention" : "reviewed",
			// ticket #42's export gate is human-only — the builder never sets it
			// true, but it must be emitted explicitly (not left absent) so the
			// review-data-merge baseline sidecar has an unambiguous "false" to
			// diff a human's saved `true` against.
			skipped: false,
		};
	});

	return {
		schema: "ksk_review_group_data.v1",
		group_id: group.group_id,
		label: `${pageFacts.seller ?? pageFacts.summary ?? group.group_id} — ${pageFacts.document_no ?? group.group_id}`,
		// group-level flags surfaced to the reviewer (the interpretation's
		// review_flags plus the deterministic loan-draw net) — tells a
		// needs_attention group WHY without digging into interpretation.json
		review_flags: reviewFlags,
		pages,
	};
}

// The group's top-level `source` block (written by buildStatementGroupInterpretation
// from the segment manifest's source list) is frequently left unpopulated
// (source_page/source_pages: null) — the segment manifest doesn't always carry
// an explicit page span. The group's `documents[]` (populated from the
// interpretation's own page_disposition via usedPagesByFile) is the reliable
// per-page record, so the review-data claim is derived from there and the
// top-level `source` block is used only as a last-resort fallback for the
// file name when no document names one.
function deriveStatementSource(group: GroupInterpretation): {
	source_src: string | null;
	source_page: number | null;
	source_pages: number[] | null;
	source_sheet: string | null;
	image_src: null;
} {
	const pages = new Set<number>();
	let firstPage: number | null = null;
	let file: string | null = null;
	let sheet: string | null = null;
	for (const doc of group.documents) {
		const docFile = doc.source_file ?? doc.artifact ?? null;
		if (!file && docFile) file = docFile;
		if (doc.source_page != null) {
			pages.add(doc.source_page);
			if (firstPage == null || doc.source_page < firstPage) firstPage = doc.source_page;
		}
		for (const p of doc.source_pages ?? []) pages.add(p);
		if (doc.source_sheet != null) sheet = doc.source_sheet;
	}
	return {
		source_src: file ?? group.source?.source_src ?? null,
		source_page: firstPage ?? group.source?.source_page ?? null,
		source_pages: pages.size ? [...pages].sort((a, b) => a - b) : (group.source?.source_pages ?? null),
		source_sheet: sheet ?? group.source?.source_sheet ?? null,
		image_src: null,
	};
}

// Reads a field off a StatementTransaction that is only reachable through its
// index signature (not one of the named/typed fields) and returns it only
// when it is actually a string — never `any`, so a stray non-string value
// under that key can't silently smuggle a non-string into a description/
// counterparty column.
function txnStringField(txn: StatementTransaction, key: string): string | null {
	const value: unknown = txn[key];
	return typeof value === "string" ? value : null;
}

// Some interpretations in the wild wrote each transaction using the
// statement's own printed column names — `channel` for "ช่องทาง",
// `detail` for "รายละเอียด" — instead of the canonical `description`/
// `counterparty` this schema names. Fall back to those only when the
// canonical field is genuinely absent (`null`/`undefined`); an explicit
// empty string is the agent's actual answer and must not be overwritten by
// the legacy field (`??` already has that behavior: it only falls through
// on null/undefined, never on `""`).
function statementDescription(txn: StatementTransaction): string | null {
	return txn.description ?? txnStringField(txn, "channel") ?? null;
}

function statementCounterparty(txn: StatementTransaction): string | null {
	return txn.counterparty ?? txnStringField(txn, "detail") ?? null;
}

// review_flags[]/questions_for_user[] are typed `unknown[]` on
// GroupInterpretation — an authoring agent could in principle write a
// number or object entry. The review page renders every entry as plain
// text, so coerce each entry to a display string rather than passing it
// through: strings pass verbatim, null/undefined drop out, primitives
// stringify with String(), and anything else (object/array) is
// JSON.stringify'd instead of hitting String() directly — String({...})
// renders the useless literal "[object Object]", the JSON text at least
// shows the content.
function toDisplayStrings(values: unknown[]): string[] {
	const out: string[] = [];
	for (const value of values) {
		if (typeof value === "string") {
			if (value.length > 0) out.push(value);
			continue;
		}
		if (value == null) continue;
		if (typeof value === "number" || typeof value === "boolean") {
			out.push(String(value));
			continue;
		}
		try {
			out.push(JSON.stringify(value));
		} catch {
			out.push(String(value));
		}
	}
	return out;
}

export function buildStatementReviewData(
	group: GroupInterpretation,
	categorize: CategorizeFile,
): Record<string, unknown> {
	if (!group.statement || !group.source)
		throw new Error(`group ${group.group_id}: statement/source blocks missing from interpretation.json`);
	const catByIndex = categorizeByIndex(categorize);
	const rows = (group.transactions ?? []).map((txn, index) => {
		const cat = catByIndex.get(index);
		if (!txn.date_iso)
			throw new Error(`group ${group.group_id}: transactions[${index}] has no date_iso`);
		if (txn.direction !== "in" && txn.direction !== "out")
			throw new Error(
				`group ${group.group_id}: transactions[${index}] direction "${txn.direction ?? "missing"}" (expected in|out)`,
			);
		if (typeof txn.amount !== "number")
			throw new Error(`group ${group.group_id}: transactions[${index}] amount is not a number`);
		return {
			row_index: index,
			date_iso: txn.date_iso,
			time: txn.time ?? null,
			description: statementDescription(txn),
			counterparty: statementCounterparty(txn),
			direction: txn.direction,
			amount: Math.abs(txn.amount),
			balance: txn.balance ?? null,
			account_code: cat?.account_code ?? "",
			sub_code: cat?.sub_code ?? "",
			account_name_th: cat?.account_name_th ?? "",
			confidence: cat && CONFIDENCES.has(cat.confidence ?? "") ? cat.confidence : "low",
			reason: cat?.reason ?? (cat ? "" : "no categorize entry for this row"),
			needs_review: cat?.needs_review ?? true,
			// see the matching comment on buildDocumentReviewData's page object —
			// same reason, same explicit-false requirement for the merge baseline.
			skipped: false,
		};
	});
	return {
		schema: "ksk_review_statement_data.v1",
		group_id: group.group_id,
		label: [group.statement.bank, group.statement.account_no, group.statement.period]
			.filter(Boolean)
			.join(" — ") || group.group_id,
		statement: {
			...group.statement,
			bank_account_code: categorize.bank_account_code ?? null,
			bank_sub_code: categorize.bank_sub_code ?? "",
		},
		source: deriveStatementSource(group),
		// Contract: absent in review-data.json written before these existed;
		// every consumer must treat a missing field as [], never as an error.
		review_flags: toDisplayStrings(group.review_flags ?? []),
		questions_for_user: toDisplayStrings(group.questions_for_user ?? []),
		rows,
	};
}
