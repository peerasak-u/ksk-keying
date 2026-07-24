// Excluded/skip review claim list (wayfinder ticket #44, part of the #40
// spec on issue #40). buildClaims is the pure core: given a client-month's
// dispositions.yaml entries plus two small cross-check inputs, it produces
// the exact ordered claim list the review page renders — no file I/O here
// (see readDispositions/readReviewedUnitsByGroup/hasReferenceReportCheckFile
// below for the thin I/O wrappers), mirroring sequencer/logic.ts's and
// merge-dispositions.ts's pure-core/thin-IO-wrapper split.
//
// Ground truth for the schema this reads: merge-dispositions.ts's
// DispositionEntry + unitKey() (reimplemented here rather than imported —
// that file has no import.meta.main guard and isn't designed to be
// imported as a library; ledger.ts is the same way, see its own
// loadDispositions/loadClaims, also not exported).
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse as yamlParse } from "yaml";

export type DispositionEntry = {
	file: string;
	page: number | null;
	sheet: string | null;
	disposition: "used" | "excluded";
	reason?: string;
	duplicate_of?: string;
	declared_by?: string;
	note?: string;
};

// The real 7-value vocabulary (decision-policy.md rules 3/4/9,
// ksk-stage-profile/SKILL.md) — replaces the superseded prototype's
// fabricated `summary_report`/`blank`. "superseded_by" is a prefix match:
// the real `reason` value is the literal string `superseded_by <seg-id>`
// with the id substituted in. "unknown" is the graceful fallback for any
// reason value not in this list, so a future new category never breaks
// the page or hides a claim.
export type ReasonCategory =
	| "context_file"
	| "duplicate"
	| "blank_or_separator"
	| "reference_example"
	| "superseded_by"
	| "redundant_archive"
	| "reference_report"
	| "unknown";

const SUPERSEDED_PREFIX = "superseded_by ";

function classifyReason(raw: string): ReasonCategory {
	if (raw.startsWith(SUPERSEDED_PREFIX)) return "superseded_by";
	switch (raw) {
		case "context_file":
		case "duplicate":
		case "blank_or_separator":
		case "reference_example":
		case "redundant_archive":
		case "reference_report":
			return raw;
		default:
			return "unknown";
	}
}

const REASON_LABEL: Record<Exclude<ReasonCategory, "unknown">, string> = {
	context_file: "ไฟล์อ้างอิง (ผังบัญชี)",
	duplicate: "ซ้ำกับเอกสารอื่น",
	blank_or_separator: "หน้าว่าง / หน้าคั่น",
	reference_example: "ตัวอย่างไฟล์นำเข้า PEAK",
	superseded_by: "ถูกแทนที่ด้วยเอกสารอื่น",
	redundant_archive: "ไฟล์บีบอัดซ้ำซ้อน (แตกไฟล์แล้ว)",
	reference_report: "รายงานอ้างอิง (ไม่ใช่ต้นฉบับ)",
};

function reasonLabelOf(raw: string, category: ReasonCategory): string {
	if (category === "unknown") return raw;
	if (category === "superseded_by") return `${REASON_LABEL.superseded_by} (${raw.slice(SUPERSEDED_PREFIX.length)})`;
	return REASON_LABEL[category];
}

export type ClaimFileKind = "pdf" | "xlsx";

function fileKindOf(file: string): ClaimFileKind {
	const dot = file.lastIndexOf(".");
	const ext = dot === -1 ? "" : file.slice(dot).toLowerCase();
	return ext === ".xlsx" || ext === ".xls" ? "xlsx" : "pdf";
}

// Same format as merge-dispositions.ts's unitKey() / ledger.ts's unitId() —
// file#pN for a page, file#sSheet for a sheet, bare file for a file-level
// entry. NFC-normalized for matching only, never for display.
export function unitKey(entry: { file: string; page: number | null; sheet: string | null }): string {
	const file = entry.file.normalize("NFC");
	if (entry.page != null) return `${file}#p${entry.page}`;
	if (entry.sheet != null) return `${file}#s${entry.sheet.normalize("NFC")}`;
	return file;
}

export type ClaimUnitRef = { file: string; page: number | null; sheet: string | null; unitKey: string };

export type Claim = {
	unitKey: string;
	file: string;
	page: number | null;
	sheet: string | null;
	fileKind: ClaimFileKind;
	reasonRaw: string;
	reasonCategory: ReasonCategory;
	reasonLabel: string;
	extraScrutiny: boolean;
	declaredBy: "agent" | "agent_policy";
	duplicateOf: ClaimUnitRef | null;
	conflictGroup: string | null;
	referenceReportCheckMissing: boolean;
};

/** Pure core: dispositions entries (the WHOLE file, not just excluded ones —
 * needed to resolve a duplicate claim's counterpart) + two small cross-check
 * inputs -> the exact ordered claim list the review page renders. */
export function buildClaims(
	allEntries: DispositionEntry[],
	reviewedUnitsByGroup: Map<string, string>,
	hasReferenceReportCheck: boolean,
): Claim[] {
	const byKey = new Map<string, DispositionEntry>();
	for (const entry of allEntries) byKey.set(unitKey(entry), entry);

	const claims: Claim[] = [];
	for (const entry of allEntries) {
		if (entry.disposition !== "excluded") continue;
		if (entry.declared_by !== "agent" && entry.declared_by !== "agent_policy") continue;

		const key = unitKey(entry);
		const category = classifyReason(entry.reason ?? "");
		const raw = entry.reason ?? "";

		let duplicateOf: ClaimUnitRef | null = null;
		if (entry.duplicate_of) {
			const targetKey = entry.duplicate_of.normalize("NFC");
			const target = byKey.get(targetKey);
			duplicateOf = target
				? { file: target.file, page: target.page, sheet: target.sheet, unitKey: unitKey(target) }
				: { file: entry.duplicate_of, page: null, sheet: null, unitKey: entry.duplicate_of };
		}

		claims.push({
			unitKey: key,
			file: entry.file,
			page: entry.page,
			sheet: entry.sheet,
			fileKind: fileKindOf(entry.file),
			reasonRaw: raw,
			reasonCategory: category,
			reasonLabel: reasonLabelOf(raw, category),
			extraScrutiny: category === "reference_report",
			declaredBy: entry.declared_by as "agent" | "agent_policy",
			duplicateOf,
			conflictGroup: reviewedUnitsByGroup.get(key) ?? null,
			referenceReportCheckMissing: category === "reference_report" && !hasReferenceReportCheck,
		});
	}

	// reference_report first (highest historical risk), stable otherwise —
	// Array.prototype.sort is spec-guaranteed stable.
	claims.sort((a, b) => {
		const aFirst = a.reasonCategory === "reference_report" ? 0 : 1;
		const bFirst = b.reasonCategory === "reference_report" ? 0 : 1;
		return aFirst - bFirst;
	});
	return claims;
}

// ---------------------------------------------------------------------------
// Thin I/O wrappers — read real on-disk artifacts, never unit tested directly
// (covered by the manual smoke test instead, same convention as #38/#39).

const SYS_DIR = "ข้อมูลระบบ";
const PAGES_DIR = "_pages";
const DOC_GROUPS_DIR = "_doc_groups";

function pagesDir(clientDir: string): string {
	return join(clientDir, SYS_DIR, PAGES_DIR);
}

function docGroupsDir(clientDir: string): string {
	return join(clientDir, SYS_DIR, DOC_GROUPS_DIR);
}

/** Reads ข้อมูลระบบ/_pages/dispositions.yaml. Returns [] if it doesn't exist
 * yet (no Stage 2 interpret has run). */
export async function readDispositions(clientDir: string): Promise<DispositionEntry[]> {
	const path = join(pagesDir(clientDir), "dispositions.yaml");
	if (!existsSync(path)) return [];
	const doc = yamlParse(await readFile(path, "utf8")) as { entries?: DispositionEntry[] } | null;
	return doc?.entries ?? [];
}

function findReviewDataFiles(clientDir: string): string[] {
	const root = docGroupsDir(clientDir);
	if (!existsSync(root) || !statSync(root).isDirectory()) return [];
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const child = join(dir, name);
			const st = statSync(child);
			if (st.isDirectory()) walk(child);
			else if (st.isFile() && name === "review-data.json") found.push(child);
		}
	};
	walk(root);
	return found;
}

/** Fallback group display name when a review-data.json carries neither
 * `label` nor `group_id` (malformed/legacy) — the folder path under
 * _doc_groups/ is 3 levels deep in practice (category/vat-or-mixed/seg-id),
 * so this is a last resort, not the primary source of truth. */
function groupNameFromPath(clientDir: string, reviewDataPath: string): string {
	const rel = relative(docGroupsDir(clientDir), reviewDataPath);
	const dir = rel.slice(0, rel.lastIndexOf("/"));
	return dir || rel;
}

type ReviewDataDoc = {
	group_id?: string;
	label?: string;
	pages?: Array<{ source_src?: string; source_pages?: unknown; source_page?: number; source_sheet?: string }>;
	source?: { source_src?: string; source_pages?: unknown; source_page?: number; source_sheet?: string };
};

function resolveReviewedUnitIds(entry: { source_src?: string; source_pages?: unknown; source_page?: number; source_sheet?: string }): string[] {
	const src = entry.source_src;
	if (typeof src !== "string" || !src) return [];
	const ids: string[] = [];
	let pages: number[] = [];
	if (Array.isArray(entry.source_pages)) pages = entry.source_pages.filter((n): n is number => Number.isInteger(n));
	else if (typeof entry.source_page === "number" && Number.isInteger(entry.source_page)) pages = [entry.source_page];
	for (const p of pages) ids.push(unitKey({ file: src, page: p, sheet: null }));
	if (typeof entry.source_sheet === "string" && entry.source_sheet) ids.push(unitKey({ file: src, page: null, sheet: entry.source_sheet }));
	return ids;
}

/** Walks every _doc_groups/.../review-data.json and maps each claimed unit key
 * to its group's human-readable display name — the input to buildClaims's
 * conflict-warning cross-reference. Advisory only (mirrors the same
 * "reviewed" signal ledger.ts's own Page Ledger gate already computes, at
 * lower fidelity — this never blocks anything, it only feeds a warning
 * banner). Prefers review-data.json's own `label` (e.g. "บริษัท ชามหวาน
 * จำกัด — RT-20260500001") over its `group_id` (e.g.
 * "seg-002-RT-20260500001") so the banner names something a human
 * recognizes, not just an internal id. */
export async function readReviewedUnitsByGroup(clientDir: string): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	for (const path of findReviewDataFiles(clientDir)) {
		let doc: ReviewDataDoc;
		try {
			doc = JSON.parse(await readFile(path, "utf8"));
		} catch {
			continue;
		}
		const groupName = doc.label || doc.group_id || groupNameFromPath(clientDir, path);
		const claimEntries = Array.isArray(doc.pages) ? doc.pages : doc.source ? [doc.source] : [];
		for (const entry of claimEntries) {
			for (const id of resolveReviewedUnitIds(entry)) {
				if (!result.has(id)) result.set(id, groupName);
			}
		}
	}
	return result;
}

/** Whether this client-month has ever had ANY excluded disposition entry
 * (regardless of who declared it) — distinguishes "every claim has been
 * reviewed to completion" (still true) from "this month never had any
 * exclusion claims at all" (also zero claims from buildClaims, but a
 * genuinely different situation to show the operator). */
export function hasAnyExcludedEntries(allEntries: DispositionEntry[]): boolean {
	return allEntries.some((e) => e.disposition === "excluded");
}

/** Whether ข้อมูลระบบ/_pages/reference-report-check.yaml exists — it's only
 * written at the Completion check (decision-policy.md rule 9), so a
 * client-month still earlier in the pipeline simply won't have it yet. */
export function hasReferenceReportCheckFile(clientDir: string): boolean {
	return existsSync(join(pagesDir(clientDir), "reference-report-check.yaml"));
}
