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

export type LinkMember = {
	segment?: string;
	document_no?: string | null;
	role?: string;
};

export type LinkCluster = {
	transaction_id?: string;
	segments?: string[];
	members?: LinkMember[];
	bookable_docs?: (string | null)[];
	evidence?: string;
	confidence?: string;
};

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
};

export type PlanResult = {
	groups: GroupPlan[];
	warnings: string[];
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
		const candidates = list.filter((r) => !isExcludedFromMatch(r.sourceEntry));
		const pool = candidates.length ? candidates : list;
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
				reason: `document_no "${documentNo}" matches ${matches.length} interpretation files`,
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
// that carries usable_for_booking says false (a lone duplicate page amid an
// otherwise-usable file must not blank out the whole document).
function isFileLevelBookable(file: InterpFile): boolean {
	const documents = file.json.documents ?? [];
	const flagged = documents.filter((d) => typeof d.usable_for_booking === "boolean");
	return !(flagged.length > 0 && flagged.every((d) => d.usable_for_booking === false));
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

function isApprovedBookable(record: DocRecord): boolean {
	if (typeof record.facts.document_no !== "string" || !record.facts.document_no) return false;
	if (hasPlaceholderDocumentNo(record.sourceEntry)) return false;
	return record.sourceEntry ? !isExcludedFromMatch(record.sourceEntry) : isFileLevelBookable(record.file);
}

// Stage-2 truth (interpsBySegment) vs. what actually landed in the finished
// group plan — catches the "sherlock link-drop" class of bug where an
// approved bookable document silently never becomes a group (dropped by
// links.yaml / the linker, not excluded by any Stage-2 evidence). Keyed
// ALWAYS by (segment_id, document_no), never bare document_no — the same
// number legitimately recurs across different segments (BUG-2: group ids are
// index-prefixed precisely so two segments each booking a doc "46" stay two
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
export function findDroppedBookableUnits(
	interpsBySegment: Map<string, InterpFile[]>,
	groups: GroupPlan[],
): string[] {
	const booked = new Map<string, number>();
	const primaryFiles = new Set<string>();
	const evidenceFor = new Map<string, Set<string>>(); // file path -> bookable_docs it supports
	for (const group of groups) {
		if (group.primary_interpretation) primaryFiles.add(group.primary_interpretation);
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
	const missing: string[] = [];
	for (const [segmentId, files] of [...interpsBySegment.entries()].sort()) {
		const grosses = new Map<string, Set<number>>();
		for (const file of files) {
			if (isStatementShaped(file.json)) continue;
			const supportedDocs = primaryFiles.has(file.path) ? undefined : evidenceFor.get(file.path);
			for (const record of documentRecordsOf(file)) {
				if (!isApprovedBookable(record)) continue;
				const no = record.facts.document_no as string;
				if (supportedDocs && !supportedDocs.has(no)) continue; // explained as evidence for a different doc
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
	});

	// Document groups whose bookable doc number is unknown must not slug from a
	// segment id — in the group id that reads like a real document number. They
	// get a loud per-plan ID_NOT_FOUND_<n> sentinel instead (statement groups
	// keep their segment-id slug: bank statements legitimately have no document
	// number).
	let unknownDocIds = 0;

	const documentDraft = (
		match: PrimaryMatch,
		bookableDoc: string | null,
		segments: string[],
		evidence: string[],
		cluster: LinkCluster | null,
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
		} else {
			groupWarnings.push("category/vat provisional (no primary interpretation) — ksk-marple populate must confirm");
		}
		let slugBase = bookableDoc ?? "";
		if (!slugBase) {
			unknownDocIds += 1;
			slugBase = `ID_NOT_FOUND_${unknownDocIds}`;
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
		};
	};

	if (clusters) {
		const coveredSegments = new Set<string>();
		for (const cluster of clusters) {
			const members = cluster.members ?? [];
			const segments = cluster.segments ?? members.map((m) => m.segment ?? "").filter(Boolean);
			for (const id of segments) coveredSegments.add(id);
			const bookableDocs = (cluster.bookable_docs ?? []).filter(
				(d): d is string => typeof d === "string" && d.length > 0,
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
					),
				);
				continue;
			}
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
				drafts.push(documentDraft(match, doc, segments, evidence, cluster));
			}
		}
		// segments never mentioned by links.yaml still become groups (sherlock
		// guarantees full coverage, but a skipped/partial links file must not
		// silently drop money)
		for (const [segmentId, files] of [...interpsBySegment.entries()].sort()) {
			if (coveredSegments.has(segmentId)) continue;
			warnings.push(`segment ${segmentId} not covered by links.yaml — standalone group(s) created`);
			for (const file of files) {
				if (isStatementShaped(file.json)) {
					drafts.push(statementDraft(file));
					continue;
				}
				for (const record of documentRecordsOf(file)) {
					const doc = record.facts.document_no ?? null;
					drafts.push(documentDraft({ ...record, reason: null }, doc, [segmentId], [], null));
				}
			}
		}
	} else {
		for (const [segmentId, files] of [...interpsBySegment.entries()].sort()) {
			for (const file of files) {
				if (isStatementShaped(file.json)) {
					drafts.push(statementDraft(file));
					continue;
				}
				for (const record of documentRecordsOf(file)) {
					const doc = record.facts.document_no ?? null;
					drafts.push(documentDraft({ ...record, reason: null }, doc, [segmentId], [], null));
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

	// stable ids: creation order, zero-padded, plus a slug of the bookable doc
	const groups: GroupPlan[] = drafts.map((draft, index) => {
		const { slugBase, ...rest } = draft;
		const id = `${String(index + 1).padStart(3, "0")}-${slugify(slugBase)}`;
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

	// completeness invariant: every approved bookable Stage-2 document must
	// land in some group — a hard block, not a warning, because the only
	// recovery is re-linking/re-inspecting links.yaml, never auto-backfilling
	// (that would book into a guessed category and paper over a clustering bug).
	const missing = findDroppedBookableUnits(interpsBySegment, groups);
	if (missing.length)
		throw new Error(
			`bookable documents dropped between Stage-2 and grouping (segment_id / document_no): ${missing.join("; ")} — links.yaml/clustering lost these. Re-run Stage 3 linking or inspect links.yaml; not auto-recovered.`,
		);

	return { groups, warnings };
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
		review_flags: primary.review_flags ?? [],
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
	const anyReview =
		lines.some((l) => l.needs_review || l.confidence !== "high") ||
		group.review_flags.length > 0 ||
		group.questions_for_user.length > 0 ||
		(categorize.questions_for_user ?? []).length > 0;
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
		};
	});

	return {
		schema: "ksk_review_group_data.v1",
		group_id: group.group_id,
		label: `${pageFacts.seller ?? pageFacts.summary ?? group.group_id} — ${pageFacts.document_no ?? group.group_id}`,
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
			description: txn.description ?? null,
			counterparty: txn.counterparty ?? null,
			direction: txn.direction,
			amount: Math.abs(txn.amount),
			balance: txn.balance ?? null,
			account_code: cat?.account_code ?? "",
			sub_code: cat?.sub_code ?? "",
			account_name_th: cat?.account_name_th ?? "",
			confidence: cat && CONFIDENCES.has(cat.confidence ?? "") ? cat.confidence : "low",
			reason: cat?.reason ?? (cat ? "" : "no categorize entry for this row"),
			needs_review: cat?.needs_review ?? true,
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
		rows,
	};
}
