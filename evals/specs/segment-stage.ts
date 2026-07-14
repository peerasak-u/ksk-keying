// segment-stage — StageGrader for Stage 1 (ksk-stage-segment).
//
// Grades each session's ข้อมูลระบบ/_segments tree deterministically:
//   tier-A (per session): manifest.yaml parses/validates as ksk_segments.v1
//     (every segment has a segment_id + ≥1 source with pages or sheets);
//     SUMMARY.md present + non-empty; ledger --gate segment PASSES (every
//     inventory page in EXACTLY one segment, 0 unaccounted).
//   cross-session: the sessions are each other's reference — agreement on
//     how the source pages are CARVED into segments (a partition), keyed by
//     each segment's normalized page-set membership rather than its
//     (arbitrary, session-local) segment_id.
//   tier-B: no expected partition set exists yet — ground_truth is always
//     null, but shaped so a future
//     `samples/evals/fixtures/segment/<fixture>.expected.json` (an expected
//     page-set partition) drops in without reshaping the summary envelope.
//
// Schema notes (ksk_segments.v1, per ledger.ts's SegmentSource type — the
// authoritative consumer):
//   • a source's `pages` is a 2-element INCLUSIVE RANGE tuple [start, end],
//     never an enumerated page list — [1, 5] means pages 1..5.
//   • `sheets` is a list of sheet-name strings; a source may carry pages OR
//     sheets (this grader requires at least one to be present and non-empty).
//   • `sub_ranges` (provisional sub-splits used only to cap interpretation
//     dispatch size in Stage 2) are NOT segment boundaries and are ignored
//     here — partition membership is derived from `sources` only.
//   • `source_class` (e.g. "possibly_derived_report") marks Stage-2
//     bookability, not a Stage-1 concern — every segment counts equally for
//     shape validation and partition agreement regardless of source_class.
//
// Never edits a session's output; a malformed/missing artifact is a finding
// reported as a failing metric.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadYaml } from "../lib";
import type {
	SessionGrade,
	StageGradeResult,
	StageGrader,
	StageRunContext,
} from "./stage-grader";

const MANIFEST_SCHEMA = "ksk_segments.v1";

function segmentsDir(client: string): string {
	return join(client, "ข้อมูลระบบ", "_segments");
}

function pagesDir(client: string): string {
	return join(client, "ข้อมูลระบบ", "_pages");
}

// ---------------------------------------------------------------------------
// manifest.yaml shape validation (pure — operates on an already-parsed doc)
// ---------------------------------------------------------------------------

export interface ManifestValidation {
	ok: boolean;
	detail: string; // "ok" | "no segments[] array" | "N invalid segments" | ...
	invalidSegments: string[]; // segment_id (or positional label) of each invalid segment
}

// A source is valid when it names a file and carries a usable page RANGE
// ([start,end] integers) and/or a non-empty sheets list.
function sourceHasUnits(source: any): boolean {
	const pagesOk =
		Array.isArray(source?.pages) &&
		source.pages.length === 2 &&
		Number.isInteger(source.pages[0]) &&
		Number.isInteger(source.pages[1]) &&
		source.pages[0] <= source.pages[1];
	const sheetsOk = Array.isArray(source?.sheets) && source.sheets.length > 0;
	return typeof source?.file === "string" && source.file.length > 0 && (pagesOk || sheetsOk);
}

export function validateManifest(doc: any): ManifestValidation {
	if (doc?.schema !== MANIFEST_SCHEMA)
		return { ok: false, detail: `schema mismatch (expected ${MANIFEST_SCHEMA})`, invalidSegments: [] };
	if (!Array.isArray(doc?.segments) || doc.segments.length === 0)
		return { ok: false, detail: "no segments[] array", invalidSegments: [] };

	const invalid: string[] = [];
	doc.segments.forEach((seg: any, i: number) => {
		const label = typeof seg?.segment_id === "string" && seg.segment_id ? seg.segment_id : `#${i}`;
		const hasId = typeof seg?.segment_id === "string" && seg.segment_id.length > 0;
		const sources = Array.isArray(seg?.sources) ? seg.sources : [];
		const hasValidSource = sources.length > 0 && sources.some(sourceHasUnits);
		if (!hasId || !hasValidSource) invalid.push(label);
	});
	return {
		ok: invalid.length === 0,
		detail: invalid.length === 0 ? "ok" : `${invalid.length} invalid segments`,
		invalidSegments: invalid,
	};
}

// ---------------------------------------------------------------------------
// Partition keying — segment_id-INDEPENDENT so cross-session comparison
// doesn't care that "seg-003" in one session and "seg-005" in another are
// arbitrary labels. A segment's identity for comparison purposes is the
// exact set of source pages/sheets it covers.
// ---------------------------------------------------------------------------

// Expand one segment's sources into individual (file, page|sheet) unit ids,
// same id scheme the ledger uses ("<file>#p<N>" / "<file>#s<Sheet>") so a
// segment's membership is directly comparable to inventory/ledger units.
export function segmentUnitKeys(seg: any): string[] {
	const sources = Array.isArray(seg?.sources) ? seg.sources : [];
	const units: string[] = [];
	for (const source of sources) {
		if (typeof source?.file !== "string" || !source.file) continue;
		const { file } = source;
		if (
			Array.isArray(source.pages) &&
			source.pages.length === 2 &&
			Number.isInteger(source.pages[0]) &&
			Number.isInteger(source.pages[1])
		) {
			const [start, end] = source.pages;
			for (let p = start; p <= end; p++) units.push(`${file}#p${p}`);
		}
		if (Array.isArray(source.sheets)) {
			for (const sheet of source.sheets) units.push(`${file}#s${sheet}`);
		}
	}
	return units;
}

// A NORMALIZED (sorted, joined) key for one segment's page-set — the
// partition "cell" identity used for cross-session agreement. Two segments
// (in the same or different sessions) with the same page-set produce the
// same key regardless of their segment_id or declaration order.
export function segmentPartitionKey(seg: any): string {
	return [...segmentUnitKeys(seg)].sort().join("|");
}

// All partition-cell keys for a manifest doc, skipping segments with an
// empty unit-set (already flagged by validateManifest as invalid — an empty
// key would otherwise collide across sessions and falsely "agree").
export function manifestPartitionKeys(doc: any): string[] {
	const segments = Array.isArray(doc?.segments) ? doc.segments : [];
	return segments.map(segmentPartitionKey).filter((k: string) => k.length > 0);
}

export interface PartitionAgreement {
	allKeys: string[]; // union of every session's partition-cell keys
	keysInAll: string[]; // cells reproduced identically in EVERY session
	droppedKeys: string[]; // cells missing from at least one session
	agreement: string; // "N/M (P%)" | "n/a" (no sessions produced any valid segment)
	equal: boolean; // true iff every session produced the exact same partition
}

// The core comparator: does every session carve the same source pages into
// the same segments? Compares SETS of partition-cell keys per session — a
// session contributes an empty set when its manifest didn't parse/validate.
export function partitionAgreement(sessionKeys: string[][]): PartitionAgreement {
	const sessionSets = sessionKeys.map((keys) => new Set(keys));
	const allKeys = new Set<string>();
	for (const set of sessionSets) for (const k of set) allKeys.add(k);
	const keysInAll = [...allKeys].filter((k) => sessionSets.every((set) => set.has(k)));
	const droppedKeys = [...allKeys].filter((k) => !keysInAll.includes(k));
	const agreement = allKeys.size
		? `${keysInAll.length}/${allKeys.size} (${((keysInAll.length / allKeys.size) * 100).toFixed(1)}%)`
		: "n/a";
	// Equal partitions ⟺ nothing was dropped AND no session carries an extra
	// cell beyond the shared set (guards the case where every SESSION's set is
	// the same size as keysInAll but a session still has a cell missing from
	// keysInAll due to a duplicate key collision within that session).
	const equal =
		allKeys.size > 0 && droppedKeys.length === 0 && sessionSets.every((set) => set.size === allKeys.size);
	return { allKeys: [...allKeys], keysInAll, droppedKeys, agreement, equal };
}

// ---------------------------------------------------------------------------
// Inventory accounting — total page/sheet units, for the coverage metric.
// Mirrors ledger.ts's inventoryUnits() unit count (pdf: page_count units;
// spreadsheet with sheets: one unit per sheet name; otherwise: the whole
// file is one unit) without re-deriving segment/disposition membership —
// the ledger gate call already derives that authoritatively (its stdout
// `unaccounted:` count is exactly "neither segmented nor policy-excluded").
// ---------------------------------------------------------------------------

export function totalInventoryUnits(inv: any): number {
	const files = Array.isArray(inv?.files) ? inv.files : [];
	let total = 0;
	for (const f of files) {
		if (f?.kind === "pdf") total += Number.isInteger(f?.page_count) ? f.page_count : 0;
		else if (Array.isArray(f?.sheets)) total += f.sheets.length;
		else total += 1;
	}
	return total;
}

// ---------------------------------------------------------------------------
// Per-session grading
// ---------------------------------------------------------------------------

interface SegmentSessionGrade extends SessionGrade {
	manifestOk: boolean;
	manifestDetail: string;
	summaryOk: boolean;
	ledgerPass: boolean;
	unaccounted: number;
	coverage: string; // "accounted/total" inventory units, or "n/a"
}

function readManifest(client: string): any | null {
	const path = join(segmentsDir(client), "manifest.yaml");
	if (!existsSync(path)) return null;
	try {
		return loadYaml<any>(path);
	} catch {
		return null;
	}
}

function summaryOk(client: string): boolean {
	const path = join(segmentsDir(client), "SUMMARY.md");
	if (!existsSync(path)) return false;
	try {
		return readFileSync(path, "utf8").trim().length > 0;
	} catch {
		return false;
	}
}

function gradeSession(ctx: StageRunContext, s: number): { grade: SegmentSessionGrade; partitionKeys: string[] } {
	const client = ctx.clientDir(s);

	const manifestDoc = readManifest(client);
	const manifestParsed = manifestDoc != null;
	const shape = manifestParsed
		? validateManifest(manifestDoc)
		: { ok: false, detail: "manifest.yaml missing or unparsable", invalidSegments: [] as string[] };
	const manifestOk = shape.ok;

	const summary = summaryOk(client);

	// ledger needs the --gate flag: pass it as args before the client dir.
	const ledgerRes = ctx.script("ledger", client, ["--gate", "segment"]);
	const ledgerPass = /RESULT:\s*PASS/.test(ledgerRes.out);
	const unaccounted = Number(ledgerRes.out.match(/unaccounted:\s*(\d+)/)?.[1] ?? -1);

	// coverage = inventory units accounted (segmented or policy-excluded) /
	// total inventory units. "accounted" = total - unaccounted (reviewed is
	// always 0 pre-Stage-2, so the ledger's "unaccounted" state is exactly
	// "neither in a segment nor policy-excluded").
	let coverage = "n/a";
	const invPath = join(pagesDir(client), "inventory.yaml");
	if (existsSync(invPath)) {
		try {
			const inv = loadYaml<any>(invPath);
			const total = totalInventoryUnits(inv);
			if (total > 0 && unaccounted >= 0) coverage = `${Math.max(0, total - unaccounted)}/${total}`;
		} catch {
			// leave coverage "n/a" — a malformed inventory is a Stage-0 problem,
			// not something this grader should mask or crash on.
		}
	}

	const pass = manifestOk && summary && ledgerPass && unaccounted === 0;

	return {
		grade: {
			session: s,
			manifestOk,
			manifestDetail: shape.detail,
			summaryOk: summary,
			ledgerPass,
			unaccounted,
			coverage,
			pass,
		},
		partitionKeys: manifestParsed ? manifestPartitionKeys(manifestDoc) : [],
	};
}

export const segmentStageGrader: StageGrader = {
	stage: "segment",
	grade(ctx: StageRunContext): StageGradeResult {
		const { run, runId } = ctx;
		const graded: SegmentSessionGrade[] = [];
		const partitionsBySession: string[][] = [];
		for (let s = 1; s <= run.sessions; s++) {
			const { grade, partitionKeys } = gradeSession(ctx, s);
			graded.push(grade);
			partitionsBySession.push(partitionKeys);
		}

		const part = partitionAgreement(partitionsBySession);
		const reliability = graded.filter((g) => g.pass).length;

		// No expected partition set exists yet — see samples/evals/fixtures/
		// segment/<fixture>.expected.json in the CONTRACT header. Kept as an
		// explicit null (rather than omitted) so the envelope shape doesn't
		// change when tier-B is wired up.
		const groundTruth: unknown | null = null;

		const summary = {
			reliability: `${reliability}/${run.sessions}`,
			partition_agreement: part.agreement,
			partitions_equal: part.equal,
			segments_compared: part.allKeys.length,
			segments_dropped: part.droppedKeys.length,
			dropped_partition_keys: part.droppedKeys,
			ground_truth: groundTruth,
			per_session: graded.map((g) => ({
				session: g.session,
				pass: g.pass,
				manifest: g.manifestOk ? "ok" : g.manifestDetail,
				summary_md: g.summaryOk ? "ok" : "missing/empty",
				ledger: g.ledgerPass ? "PASS" : "BLOCK",
				unaccounted: g.unaccounted,
				coverage: g.coverage,
			})),
		};

		const scoreboard: string[] = [];
		scoreboard.push(`\nstage-${ctx.stage} · ${run.fixture} · ${run.sessions} sessions · run ${runId}`);
		scoreboard.push(
			`  reliability ${summary.reliability} · partition-agreement ${part.agreement} · ` +
				`segments compared ${part.allKeys.length} · dropped ${part.droppedKeys.length}`,
		);
		graded.forEach((g) =>
			scoreboard.push(
				`  s${g.session}: ${g.pass ? "PASS" : "FAIL"} · manifest ${g.manifestOk ? "ok" : g.manifestDetail} · ` +
					`summary ${g.summaryOk ? "ok" : "missing/empty"} · ledger ${g.ledgerPass ? "PASS" : "BLOCK"} · ` +
					`unaccounted ${g.unaccounted} · coverage ${g.coverage}`,
			),
		);
		if (part.droppedKeys.length)
			scoreboard.push(`  ⚠ ${part.droppedKeys.length} partition cell(s) not reproduced in every session`);
		scoreboard.push(
			part.equal ? "\n  partitions: IDENTICAL across all sessions" : "\n  partitions: differ across sessions",
		);
		scoreboard.push("\n  ground truth: no expected partition set (skipped tier-B)");

		return { sessionGrades: graded, summary, scoreboard };
	},
};
