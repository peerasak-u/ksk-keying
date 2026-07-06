// Derived Page Ledger for the ksk-keying pipeline (ADR 0001).
//
// Completeness is proven by evidence, never by agent bookkeeping: this script
// recomputes, from on-disk artifacts alone, a state for every Page unit of
// the Inventory and blocks the run at three Ledger Gates. It is stateless and
// idempotent — there is no writable status anywhere; a blocked gate is
// cleared only by new evidence or a new Exclusion Declaration, never by
// editing ledger output.
//
// Evidence read (all under the client folder's ข้อมูลระบบ/ machinery container):
//   ข้อมูลระบบ/_pages/inventory.yaml    — the fixed denominator (run `inventory` first)
//   ข้อมูลระบบ/_pages/dispositions.yaml — parent-recorded Exclusion Declarations / used marks
//   ข้อมูลระบบ/_segments/manifest.yaml  — ksk-columbo's proposed segment boundaries
//   ข้อมูลระบบ/_doc_groups/**/review-data.json — explicit per-unit review claims
//
// Page-unit identity (must match inventory.ts):
//   PDF page          -> "<path>#p<N>"      (1-based)
//   spreadsheet sheet -> "<path>#s<Sheet>"
//   image/other file  -> "<path>"           (whole file = one unit)
//
// Gates:
//   --gate segment    every unit not file-level-Excluded must fall in EXACTLY
//                     one segment source range — gaps AND overlaps fail
//                     (an overlap is a double-booking risk, same severity)
//   --gate interpret  every unit of every segment must appear in dispositions
//                     (used or excluded) — silence is not permitted
//   --gate final      every Inventory unit must be Reviewed or Excluded;
//                     claims pointing outside the Inventory warn (not fail)
//
// Exit codes: 0 pass, 1 blocked, 2 usage/environment error.

import { basename, dirname, join, relative, resolve } from "node:path";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { docGroupsDir, pagesDir as machineryPagesDir, segmentsDir } from "./paths";

const TOOL_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(TOOL_DIR, "../../../..");

const LEDGER_SCHEMA = "ksk_ledger.v1";
const GATES = ["segment", "interpret", "final"] as const;
// stdout listing cap per section — never truncate silently; the omitted count
// is printed and the full lists always land in _pages/ledger.yaml.
const LIST_CAP = 200;

type Gate = (typeof GATES)[number];

type Args = {
	clientDir: string;
	gate: Gate;
};

type InventoryFile = {
	path: string;
	kind: "pdf" | "image" | "spreadsheet" | "other";
	page_count: number;
	sheets: string[] | null;
};

type Disposition = {
	file: string;
	page: number | null;
	sheet: string | null;
	disposition: "used" | "excluded";
	reason?: string;
	declared_by?: string;
	note?: string;
};

type SegmentSource = {
	file: string;
	pages: [number, number] | null;
	sheets: string[] | null;
};

type Segment = {
	segment_id: string;
	sources: SegmentSource[];
};

type UnitState = "reviewed" | "excluded" | "segmented" | "unaccounted";

// Everything the ledger derives per unit. Keys are display unit ids;
// matching uses NFC-normalized ids so review-data/dispositions written with
// a different Unicode normalization of the same Thai filename still match.
type Unit = {
	id: string;
	file: string;
	reviewed: boolean;
	excluded: boolean;
	fileLevelExcluded: boolean;
	dispositioned: boolean; // used OR excluded — for the interpret gate
	segments: string[];
	// Set only when excluded=true, from the disposition entry that excluded
	// this unit — feeds the M2 agent-vs-human exclusion breakdown at the
	// final gate.
	excludedReason: string | null;
	excludedBy: string | null;
};

function usage(): never {
	console.error(`Usage: bun run ledger -- --gate segment|interpret|final <client-dir>

Derives the Page Ledger from on-disk evidence and blocks while any Page unit
is Unaccounted (or, at the segment gate, in zero or more than one Segment).
Writes the derived snapshot to <client>/_pages/ledger.yaml.

Exit codes: 0 pass, 1 blocked, 2 usage/environment error.
`);
	process.exit(2);
}

function parseArgs(argv: string[]): Args {
	let clientDir = "";
	let gate: Gate | "" = "";
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--gate") {
			const value = argv[++i];
			if (!GATES.includes(value as Gate)) usage();
			gate = value as Gate;
		} else if (arg === "--help" || arg === "-h" || arg.startsWith("--")) usage();
		else if (!clientDir) clientDir = arg;
		else usage();
	}
	if (!clientDir || !gate) usage();
	return { clientDir, gate };
}

function resolveClientDir(input: string) {
	const path = resolve(input);
	if (existsSync(path) && statSync(path).isDirectory()) return path;
	const fromRoot = resolve(PROJECT_ROOT, input);
	if (existsSync(fromRoot) && statSync(fromRoot).isDirectory()) return fromRoot;
	console.error(`not a client directory: ${input}`);
	process.exit(2);
}

// NFC-normalize for matching only — stored/display ids keep the Inventory's
// exact bytes (never mangle Thai filenames).
function norm(text: string) {
	return text.normalize("NFC");
}

function unitId(file: string, page: number | null, sheet: string | null) {
	if (page != null) return `${file}#p${page}`;
	if (sheet != null) return `${file}#s${sheet}`;
	return file;
}

function parseUnitId(id: string): { file: string; page: number | null; sheet: string | null } {
	const pageMatch = id.match(/^(.*)#p(\d+)$/);
	if (pageMatch) return { file: pageMatch[1], page: Number(pageMatch[2]), sheet: null };
	const sheetMatch = id.match(/^(.*)#s(.+)$/);
	if (sheetMatch) return { file: sheetMatch[1], page: null, sheet: sheetMatch[2] };
	return { file: id, page: null, sheet: null };
}

// Display helper for a unit's segment hits — every matching source range is
// pushed (m1), so the same segment_id can repeat when two ranges in one
// segment both cover this unit; show that as "id xN" instead of silently
// collapsing it back into a single mention.
function formatHits(segmentIds: string[]): string {
	const counts = new Map<string, number>();
	for (const id of segmentIds) counts.set(id, (counts.get(id) ?? 0) + 1);
	return [...counts.entries()].map(([id, n]) => (n > 1 ? `${id} x${n}` : id)).join(", ");
}

// m3: when a final-gate claim doesn't match any inventory unit, hint at a
// near-miss unit on the SAME file that differs only by case or leading/
// trailing whitespace in the sheet name — a common typo source, since Excel
// sheet names are otherwise matched strictly (case-sensitive).
function nearMissHint(id: string, units: Map<string, Unit>): string | null {
	const claimed = parseUnitId(id);
	if (claimed.sheet == null) return null;
	const target = claimed.sheet.trim().toLowerCase();
	for (const unit of units.values()) {
		if (norm(unit.file) !== norm(claimed.file)) continue;
		const candidate = parseUnitId(unit.id);
		if (candidate.sheet == null || candidate.sheet === claimed.sheet) continue;
		if (candidate.sheet.trim().toLowerCase() === target) return unit.id;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Evidence loading

function loadYaml(path: string, label: string): unknown {
	try {
		return yamlParse(readFileSync(path, "utf8"));
	} catch (error) {
		console.error(
			`failed to parse ${label} (${path}): ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(2);
	}
}

function loadInventory(clientDir: string): InventoryFile[] {
	const path = join(machineryPagesDir(clientDir), "inventory.yaml");
	if (!existsSync(path)) {
		console.error(
			`missing ${path} — run \`bun run inventory -- "<client-dir>"\` first; the ledger's denominator must come from the deterministic Inventory, never from an agent's count`,
		);
		process.exit(2);
	}
	const doc = loadYaml(path, "inventory") as {
		schema?: string;
		files?: unknown[];
	};
	if (doc?.schema !== "ksk_inventory.v1" || !Array.isArray(doc.files)) {
		console.error(`unexpected inventory schema in ${path} (expected ksk_inventory.v1)`);
		process.exit(2);
	}
	const malformed: string[] = [];
	const files: InventoryFile[] = [];
	doc.files.forEach((entry, index) => {
		const f = entry as Partial<InventoryFile>;
		if (
			typeof f.path !== "string" ||
			typeof f.kind !== "string" ||
			!Number.isInteger(f.page_count) ||
			(f.sheets != null && !Array.isArray(f.sheets))
		) {
			malformed.push(`files[${index}]: ${JSON.stringify(entry)}`);
			return;
		}
		files.push(f as InventoryFile);
	});
	if (malformed.length) {
		console.error(`malformed inventory entries in ${path}:`);
		for (const line of malformed) console.error(`  ${line}`);
		process.exit(2);
	}
	return files;
}

// Tolerant parse (extra fields fine), strict on the structure we rely on:
// file, page/sheet types, disposition value, reason required when excluded.
function loadDispositions(clientDir: string, notes: string[]): Disposition[] {
	const path = join(machineryPagesDir(clientDir), "dispositions.yaml");
	if (!existsSync(path)) {
		notes.push(`no ${relative(clientDir, path)} — treating as zero dispositions`);
		return [];
	}
	const doc = loadYaml(path, "dispositions") as { entries?: unknown[] };
	if (!Array.isArray(doc?.entries)) {
		console.error(`malformed dispositions (${path}): missing entries[] list`);
		process.exit(2);
	}
	const malformed: string[] = [];
	const entries: Disposition[] = [];
	doc.entries.forEach((entry, index) => {
		const d = entry as Partial<Disposition>;
		const bad =
			typeof d.file !== "string" ||
			(d.page != null && !Number.isInteger(d.page)) ||
			(d.sheet != null && typeof d.sheet !== "string") ||
			(d.page != null && d.sheet != null) ||
			(d.disposition !== "used" && d.disposition !== "excluded") ||
			(d.disposition === "excluded" && !d.reason);
		if (bad) {
			malformed.push(`entries[${index}]: ${JSON.stringify(entry)}`);
			return;
		}
		entries.push({
			file: d.file as string,
			page: d.page ?? null,
			sheet: d.sheet ?? null,
			disposition: d.disposition as "used" | "excluded",
			reason: d.reason,
			declared_by: d.declared_by,
			note: d.note,
		});
	});
	if (malformed.length) {
		console.error(`malformed disposition entries in ${path} (need file, page|sheet|neither, disposition used|excluded, reason when excluded):`);
		for (const line of malformed) console.error(`  ${line}`);
		process.exit(2);
	}
	return entries;
}

// Legacy manifests may lack `schema`; extra fields are fine. We rely only on
// segments[].segment_id and sources[] {file, pages, sheets}.
function loadSegments(clientDir: string, notes: string[]): Segment[] {
	const path = join(segmentsDir(clientDir), "manifest.yaml");
	if (!existsSync(path)) {
		notes.push(`no ${relative(clientDir, path)} — treating as zero segments`);
		return [];
	}
	const doc = loadYaml(path, "segment manifest") as { segments?: unknown[] };
	if (!Array.isArray(doc?.segments)) {
		console.error(`malformed segment manifest (${path}): missing segments[] list`);
		process.exit(2);
	}
	const malformed: string[] = [];
	const segments: Segment[] = [];
	doc.segments.forEach((entry, index) => {
		const s = entry as { segment_id?: unknown; sources?: unknown[] };
		if (typeof s.segment_id !== "string" || !Array.isArray(s.sources)) {
			malformed.push(`segments[${index}]: missing segment_id or sources[]`);
			return;
		}
		const sources: SegmentSource[] = [];
		s.sources.forEach((raw, si) => {
			const src = raw as Partial<SegmentSource>;
			const pagesOk =
				src.pages == null ||
				(Array.isArray(src.pages) &&
					src.pages.length === 2 &&
					Number.isInteger(src.pages[0]) &&
					Number.isInteger(src.pages[1]));
			const sheetsOk =
				src.sheets == null ||
				(Array.isArray(src.sheets) && src.sheets.every((x) => typeof x === "string"));
			if (typeof src.file !== "string" || !pagesOk || !sheetsOk) {
				malformed.push(
					`segments[${index}].sources[${si}] (${s.segment_id}): ${JSON.stringify(raw)}`,
				);
				return;
			}
			sources.push({
				file: src.file,
				pages: src.pages ?? null,
				sheets: src.sheets ?? null,
			});
		});
		segments.push({ segment_id: s.segment_id, sources });
	});
	if (malformed.length) {
		console.error(`malformed segment manifest entries in ${path}:`);
		for (const line of malformed) console.error(`  ${line}`);
		process.exit(2);
	}
	return segments;
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

type Claim = {
	source: string; // review-data.json path, client-relative (for messages)
	unitIds: string[]; // resolved display-agnostic ids built from claim fields
};

type ClaimEntryFields = {
	source_src?: string | null;
	source_pages?: unknown;
	source_page?: number | null;
	source_sheet?: string | null;
};

// Resolve one claim entry (an invoice-schema pages[] entry, or a
// statement-schema `source` block) into unit ids. A claim names units via
// source_src + source_pages (full claimed span) and/or source_sheet;
// source_page (int) is a legacy fallback for source_pages and warns.
// source_page: null with no source_pages/source_sheet claims the file's
// single unit only when the Inventory says the file IS single-unit —
// membership in a reviewed file proves nothing for multi-unit files.
// Returns null (having pushed a warning) when the entry claims nothing.
function resolveClaimIds(
	entry: ClaimEntryFields,
	rel: string,
	label: string,
	singleUnitFiles: Set<string>,
	warnings: string[],
): string[] | null {
	const src = entry.source_src;
	if (typeof src !== "string" || !src) {
		warnings.push(`${rel} ${label}: no source_src — claims nothing`);
		return null;
	}
	const ids: string[] = [];
	let pages: number[] | null = null;
	if (Array.isArray(entry.source_pages)) {
		pages = entry.source_pages.filter((n): n is number => Number.isInteger(n));
	} else if (entry.source_page != null && Number.isInteger(entry.source_page)) {
		pages = [entry.source_page];
		warnings.push(
			`${rel} ${label}: legacy source_page used as source_pages=[${entry.source_page}] — migrate to explicit source_pages`,
		);
	}
	if (pages) for (const n of pages) ids.push(unitId(src, n, null));
	if (typeof entry.source_sheet === "string" && entry.source_sheet)
		ids.push(unitId(src, null, entry.source_sheet));
	if (!ids.length) {
		if (singleUnitFiles.has(norm(src))) ids.push(src);
		else {
			warnings.push(
				`${rel} ${label}: claim on multi-unit file "${src}" without source_pages/source_sheet — claims nothing (explicit per-unit claims required)`,
			);
			return null;
		}
	}
	return ids;
}

// review-data.json comes in two shapes: invoice-schema docs carry a
// pages[] array (one claim per reviewable document); statement-schema
// docs (`ksk_review_statement_data.v1`) carry a single top-level `source`
// block instead — that block is one claim, resolved the same way as an
// invoice pages[] entry (M1). A doc with neither shape never silently
// skips — it gets a warning naming the file. No legitimate schema mixes
// both shapes; if a doc carries both, pages[] wins as the claim source and
// a warning names the file so the ignored `source` block is never silent.
function loadClaims(
	clientDir: string,
	singleUnitFiles: Set<string>,
	warnings: string[],
): Claim[] {
	const claims: Claim[] = [];
	for (const path of findReviewDataFiles(clientDir)) {
		const rel = relative(clientDir, path);
		let doc: { pages?: unknown[]; source?: unknown };
		try {
			doc = JSON.parse(readFileSync(path, "utf8")) as {
				pages?: unknown[];
				source?: unknown;
			};
		} catch (error) {
			console.error(
				`failed to parse ${rel}: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(2);
		}
		if (Array.isArray(doc.pages)) {
			if (doc.source && typeof doc.source === "object")
				warnings.push(
					`${rel}: has both pages[] and source — source ignored in favor of pages[]`,
				);
			doc.pages.forEach((raw, index) => {
				const ids = resolveClaimIds(
					raw as ClaimEntryFields,
					rel,
					`pages[${index}]`,
					singleUnitFiles,
					warnings,
				);
				if (ids) claims.push({ source: rel, unitIds: ids });
			});
		} else if (doc.source && typeof doc.source === "object") {
			const ids = resolveClaimIds(
				doc.source as ClaimEntryFields,
				rel,
				"source",
				singleUnitFiles,
				warnings,
			);
			if (ids) claims.push({ source: rel, unitIds: ids });
		} else {
			warnings.push(
				`${rel}: no pages[] or source — claims nothing (unrecognized review-data shape)`,
			);
		}
	}
	return claims;
}

// ---------------------------------------------------------------------------
// Derivation

function inventoryUnits(files: InventoryFile[]): Map<string, Unit> {
	const units = new Map<string, Unit>(); // key: NFC id → Unit (display id kept as-is)
	for (const file of files) {
		const push = (id: string) =>
			units.set(norm(id), {
				id,
				file: file.path,
				reviewed: false,
				excluded: false,
				fileLevelExcluded: false,
				dispositioned: false,
				segments: [],
				excludedReason: null,
				excludedBy: null,
			});
		if (file.kind === "pdf") {
			for (let p = 1; p <= file.page_count; p++) push(unitId(file.path, p, null));
		} else if (file.sheets != null) {
			for (const sheet of file.sheets) push(unitId(file.path, null, sheet));
		} else {
			push(file.path);
		}
	}
	return units;
}

function stateOf(unit: Unit): UnitState {
	if (unit.reviewed) return "reviewed";
	if (unit.excluded) return "excluded";
	if (unit.segments.length > 0) return "segmented";
	return "unaccounted";
}

function listSection(title: string, items: string[], lines: string[]) {
	if (!items.length) return;
	lines.push(`${title} (${items.length}):`);
	for (const item of items.slice(0, LIST_CAP)) lines.push(`  - ${item}`);
	if (items.length > LIST_CAP)
		lines.push(
			`  ... ${items.length - LIST_CAP} more omitted from stdout — full list in _pages/ledger.yaml`,
		);
}

function main() {
	const args = parseArgs(Bun.argv.slice(2));
	const clientDir = resolveClientDir(args.clientDir);
	const notes: string[] = [];
	const warnings: string[] = [];

	const files = loadInventory(clientDir);
	const units = inventoryUnits(files);
	const filesByNorm = new Map(files.map((f) => [norm(f.path), f]));
	const singleUnitFiles = new Set(
		files.filter((f) => f.kind !== "pdf" && f.sheets == null).map((f) => norm(f.path)),
	);
	const unitsOfFile = (file: string): Unit[] => {
		const key = norm(file);
		const out: Unit[] = [];
		for (const unit of units.values()) if (norm(unit.file) === key) out.push(unit);
		return out;
	};

	// Dispositions → excluded / dispositioned marks. Entries pointing outside
	// the Inventory are surfaced as warnings — evidence about nothing.
	const dispositions = loadDispositions(clientDir, notes);
	dispositions.forEach((d, index) => {
		const fileKnown = filesByNorm.has(norm(d.file));
		if (!fileKnown) {
			warnings.push(
				`dispositions entries[${index}]: file "${d.file}" not in inventory`,
			);
			return;
		}
		const targets =
			d.page == null && d.sheet == null
				? unitsOfFile(d.file) // file-level entry covers every unit of the file
				: (() => {
						const unit = units.get(norm(unitId(d.file, d.page, d.sheet)));
						return unit ? [unit] : [];
					})();
		if (!targets.length) {
			warnings.push(
				`dispositions entries[${index}]: unit "${unitId(d.file, d.page, d.sheet)}" not in inventory`,
			);
			return;
		}
		for (const unit of targets) {
			unit.dispositioned = true;
			if (d.disposition === "excluded") {
				unit.excluded = true;
				if (d.page == null && d.sheet == null) unit.fileLevelExcluded = true;
				unit.excludedReason = d.reason ?? null;
				unit.excludedBy = d.declared_by ?? null;
			}
		}
	});

	// Segments → membership. Sources expanding to unknown units are reported
	// as invalid (a range past the true page count is evidence of a bad
	// manifest and blocks the segment gate).
	const segments = loadSegments(clientDir, notes);
	const invalidSources: string[] = [];
	for (const segment of segments) {
		for (const source of segment.sources) {
			const file = filesByNorm.get(norm(source.file));
			if (!file) {
				invalidSources.push(
					`${segment.segment_id}: file "${source.file}" not in inventory`,
				);
				continue;
			}
			let ids: string[] = [];
			if (source.pages != null) {
				const [start, end] = source.pages;
				for (let p = start; p <= end; p++) ids.push(unitId(source.file, p, null));
			}
			if (source.sheets != null)
				for (const sheet of source.sheets)
					ids.push(unitId(source.file, null, sheet));
			if (source.pages == null && source.sheets == null)
				ids = unitsOfFile(source.file).map((u) => u.id);
			for (const id of ids) {
				const unit = units.get(norm(id));
				if (!unit) {
					invalidSources.push(`${segment.segment_id}: unit "${id}" not in inventory`);
					continue;
				}
				// Push once per matching source range, never deduped by
				// segment_id — two ranges in the SAME segment both covering
				// this unit is still a double-booking (m1) and must count
				// as an overlap, same as two different segments claiming it.
				unit.segments.push(segment.segment_id);
			}
		}
	}

	// Review-data claims → reviewed marks. Claims pointing outside the
	// Inventory warn (surfaced at the final gate) — they never fail the run.
	const claims = loadClaims(clientDir, singleUnitFiles, warnings);
	const unknownClaims: string[] = [];
	for (const claim of claims) {
		for (const id of claim.unitIds) {
			const unit = units.get(norm(id));
			if (!unit) {
				const hint = nearMissHint(id, units);
				unknownClaims.push(
					`${claim.source}: claimed unit "${id}" not in inventory` +
						(hint ? ` — did you mean "${hint}"?` : ""),
				);
				continue;
			}
			unit.reviewed = true;
		}
	}

	// Per-state buckets (reviewed wins over excluded for display; a unit that
	// is both is also flagged as a conflict warning).
	const byState: Record<UnitState, string[]> = {
		reviewed: [],
		excluded: [],
		segmented: [],
		unaccounted: [],
	};
	for (const unit of units.values()) {
		byState[stateOf(unit)].push(unit.id);
		if (unit.reviewed && unit.excluded)
			warnings.push(`unit "${unit.id}" is both reviewed and excluded — check dispositions vs review data`);
	}

	// M2: exclusions are proposals, never hard-blocking — but agent-declared
	// ones must stay visible through to the human. Split the excluded count
	// by who declared it: `declared_by: human` (a recorded human decision) vs
	// everything else (an agent's Page Disposition the parent recorded).
	// Both buckets are counted from the SAME basis — the raw `excluded` flag
	// (not the display state, where reviewed wins over excluded) — so a unit
	// that is both reviewed and agent-excluded still counts as an agent
	// exclusion (it must keep surfacing for human review per SKILL.md) and
	// the human/agent counts can never disagree or go negative.
	const agentDeclaredExclusions = [...units.values()]
		.filter((unit) => unit.excluded && unit.excludedBy !== "human")
		.map((unit) => ({
			unit: unit.id,
			reason: unit.excludedReason,
			declared_by: unit.excludedBy ?? "unspecified",
		}));
	const humanDeclaredExcludedCount = [...units.values()].filter(
		(unit) => unit.excluded && unit.excludedBy === "human",
	).length;

	// Gate evaluation
	const offenses: { title: string; items: string[] }[] = [];
	if (args.gate === "segment") {
		const gaps: string[] = [];
		const overlaps: string[] = [];
		for (const unit of units.values()) {
			if (unit.fileLevelExcluded) continue; // only file-level exclusions exempt here
			if (unit.segments.length === 0) gaps.push(unit.id);
			else if (unit.segments.length > 1)
				overlaps.push(`${unit.id} — in ${formatHits(unit.segments)}`);
		}
		offenses.push({ title: "Segmentation gaps (unit in no segment)", items: gaps });
		offenses.push({
			title: "Segmentation overlaps (unit in more than one segment — double-booking risk)",
			items: overlaps,
		});
		offenses.push({ title: "Invalid segment sources", items: invalidSources });
	} else if (args.gate === "interpret") {
		const missing: string[] = [];
		for (const unit of units.values()) {
			if (unit.segments.length > 0 && !unit.dispositioned)
				missing.push(`${unit.id} — in ${formatHits(unit.segments)}, no disposition (silence is not permitted)`);
		}
		offenses.push({
			title: "Segment units with no Page Disposition (used or excluded)",
			items: missing,
		});
	} else {
		offenses.push({
			title: "Unaccounted units (no Terminal State: neither Reviewed nor Excluded)",
			items: byState.unaccounted.concat(byState.segmented),
		});
		warnings.push(...unknownClaims);
	}

	const blocked = offenses.some((o) => o.items.length > 0);
	const result = blocked ? "blocked" : "pass";

	// Derived snapshot — recomputed every run, never edited.
	const pagesDir = machineryPagesDir(clientDir);
	mkdirSync(pagesDir, { recursive: true });
	const ledgerPath = join(pagesDir, "ledger.yaml");
	writeFileSync(
		ledgerPath,
		yamlStringify({
			schema: LEDGER_SCHEMA,
			gate: args.gate,
			result,
			counts: {
				files: files.length,
				units: units.size,
				reviewed: byState.reviewed.length,
				excluded: byState.excluded.length,
				excluded_human: humanDeclaredExcludedCount,
				excluded_agent: agentDeclaredExclusions.length,
				segmented: byState.segmented.length,
				unaccounted: byState.unaccounted.length,
			},
			units: byState,
			offenses: offenses.map((o) => ({ title: o.title, items: o.items })),
			// Agent-declared exclusions are proposals, not evidence of a final
			// decision (ADR 0001 / CONTEXT.md) — listed here so the parent's
			// completion report always surfaces them for human review, even
			// though they never block the final gate on their own.
			agent_declared_exclusions: agentDeclaredExclusions,
			warnings,
			notes,
		}),
	);

	// Human-readable report
	const lines: string[] = [];
	lines.push(`Page Ledger — gate: ${args.gate} — ${basename(clientDir)}`);
	lines.push(`Inventory: ${files.length} files, ${units.size} units`);
	lines.push("Unit states:");
	lines.push(`  reviewed:    ${byState.reviewed.length}`);
	lines.push(
		`  excluded:    ${byState.excluded.length}  (human-declared: ${humanDeclaredExcludedCount}, agent-proposed: ${agentDeclaredExclusions.length})`,
	);
	lines.push(`  segmented:   ${byState.segmented.length} (non-terminal)`);
	lines.push(`  unaccounted: ${byState.unaccounted.length}`);
	for (const note of notes) lines.push(`note: ${note}`);
	for (const offense of offenses) listSection(offense.title, offense.items, lines);
	listSection("Warnings (non-blocking)", warnings, lines);
	// M2: agent-declared exclusions are proposals, not blocking — but they
	// must not go quiet. At the final gate (the one before the parent may
	// report success) print every one prominently so it lands in the
	// completion report for human review.
	if (args.gate === "final" && agentDeclaredExclusions.length > 0) {
		lines.push("");
		lines.push(
			`AGENT-PROPOSED EXCLUSIONS — must appear in the completion report for human review (${agentDeclaredExclusions.length}):`,
		);
		for (const e of agentDeclaredExclusions.slice(0, LIST_CAP))
			lines.push(`  - ${e.unit} — reason: ${e.reason ?? "(none)"} — declared_by: ${e.declared_by}`);
		if (agentDeclaredExclusions.length > LIST_CAP)
			lines.push(
				`  ... ${agentDeclaredExclusions.length - LIST_CAP} more omitted from stdout — full list in _pages/ledger.yaml`,
			);
	}
	lines.push(`snapshot: ${ledgerPath}`);
	lines.push(
		blocked
			? `RESULT: BLOCKED — resolve with new evidence or a new Exclusion Declaration, never by editing the ledger`
			: `RESULT: PASS`,
	);
	console.log(lines.join("\n"));
	process.exit(blocked ? 1 : 0);
}

main();
