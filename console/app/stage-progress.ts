// Real numerator/denominator for the active-run card + row detail cell
// (wayfinder ticket #3, following #1's SSE channel and #2's coarse "ขั้นที่ X
// จาก 7" card). Every function here is READ-ONLY against artifacts a live
// pipeline is concurrently writing — a missing, half-written, or malformed
// file must read as "no honest number" (null), never throw and never take
// down a dashboard render for every OTHER client-month in the same page.
//
// The operator's explicit choice (see server.ts's subscriber-gated ticker):
// this module does its own filesystem reads, but WHEN those reads happen is
// entirely up to the caller — readStageProgress itself has no timer, no
// cache, no side effects. A 90-minute overnight run with nobody watching the
// dashboard must cost zero calls into this file.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { parse as yamlParse } from "yaml";
import { STAGES } from "../sequencer/logic";
import { createInterpretPlan, type Disposition, type Inventory, type SegmentsManifest } from "../sequencer/interpret-plan";

export type StageProgress = { done: number; total: number; unitLabel: string };

const STAGE_ID_AT: (string | undefined)[] = STAGES.map((s) => s.id);

function readYaml<T>(path: string): T | null {
	if (!existsSync(path)) return null;
	try {
		return yamlParse(readFileSync(path, "utf8")) as T;
	} catch {
		// Half-written by a concurrent stage, or simply malformed — either way
		// this is "no honest number yet", not a reason to blow up the caller.
		return null;
	}
}

// Mirrors spawn-stage.ts's countPreparedPageArtifacts() walk under
// <targetDir>/_pages, with TWO deliberate differences: that function counts
// EVERY file (including one manifest.yaml per prepared source, and every
// copied spreadsheet/image ready-file) because it exists to detect "did
// anything change" for a supervisor's liveness probe — any file appearing is
// enough. This one feeds an honest done/total PAGE ratio against
// inventoryPageTotal(), which counts ONLY pdf/image pages, so the numerator
// must be restricted the same way: only files named `page-<N>.png`,
// `page-<N>.jpg`/`.jpeg`, `page-<N>.webp`, or `page-<N>.gif` count, because
// that is the full set of artifact shapes prepare.ts ever produces for a
// pdf-rendered page (renderTier, prepare.ts, always .png) or a ready image
// file (planReadyFile, prepare.ts — copies to `page-001<ext>` with the
// source's own extension, restricted to prepare.ts's own IMAGE_EXTS: .png/
// .jpg/.jpeg/.webp/.gif). A ready SPREADSHEET file is copied the same way but
// keeps its own extension (`page-001.xlsx`, `.xls`, `.csv`) — those must NOT
// be counted here, because inventoryPageTotal() deliberately excludes
// spreadsheet kinds from the denominator (a spreadsheet's page_count is a
// sheet-count placeholder, not a page prepare.ts ever renders one-per-page).
// Without this filter, a month with spreadsheet documents alongside pdfs
// inflates `done` past the true pdf/image page count, and can flip
// interpretProgress into phase 2 (unit counting) before every pdf page is
// actually rendered — verified against samples/clients/216/เดือนมีนาคม: 42
// rendered page-NNN.png files + 36 manifest.yaml siblings + zero
// spreadsheets, against 42 pdf/image pages recorded in inventory.yaml.
//
// Validator finding (MAJOR 3): this regex used to omit .webp/.gif, even
// though planReadyFile DOES copy a ready .webp/.gif file to
// `page-001.webp`/`.gif` — those artifacts landed on disk but were never
// counted, permanently starving the numerator whenever such a file was
// present.
const PREPARED_PAGE_FILE = /^page-\d+\.(png|jpe?g|webp|gif)$/i;

// The image extensions prepare.ts can actually turn into a page-NNN artifact
// (mirrors prepare.ts's own IMAGE_EXTS exactly — see planReadyFile/renderTier
// there). inventory.ts's own IMAGE_EXTS is wider (also .heic/.tif/.tiff/.bmp
// — real formats an iPhone camera or a scanner produces), but prepare.ts's
// READY_EXTS has no branch for those at all, so a file in one of those
// extensions is inventoried but never prepared — it can never contribute to
// `done` above. Counting it in the denominator anyway is exactly MAJOR 3's
// bug: inventoryPageTotal() and countPreparedPageFiles() must describe the
// SAME set of pages, or `done` can never reach `total` and phase 1 never
// completes.
const PREPARABLE_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function countPreparedPageFiles(targetDir: string): number {
	const root = join(targetDir, "_pages");
	let count = 0;
	const walk = (dir: string) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // not rendered yet, or vanished mid-walk — reads as 0 from here
		}
		for (const entry of entries) {
			if (entry.isDirectory()) walk(join(dir, entry.name));
			else if (entry.isFile() && PREPARED_PAGE_FILE.test(entry.name)) count += 1;
		}
	};
	walk(root);
	return count;
}

// Stage 1 (segment) has NO page-rendering work of its own — it's a plain
// `claude -p` segmentation pass whose only script is the segment Ledger Gate
// (.claude/skills/ksk-stage-segment/SKILL.md). Page rendering (prepare.ts,
// countPreparedPageFiles below) happens inside runInterpretStage, i.e. STAGE
// 2 (spawn-stage.ts:1614 calls runPreparePagesChunked from there, not from
// the segment stage). Mapping stage 1 to prepared-page counting — the
// original wiring — produced two invented bars validation caught: a fresh
// run's stage 1 pinned at 0/N for the stage's entire duration (nothing under
// <targetDir>/_pages exists yet), and a re-run of an already-prepared month
// showing an instantly-full N/N bar for a stage that did zero work. Stage 1
// therefore joins profile/link/final as genuinely opaque — no honest
// numerator/denominator exists for it, so it falls back to the caller's
// elapsed-time line like the others. The page ratio moves to interpretProgress
// below, as phase 1 of that stage's own composite, since that's where the
// rendering actually happens.
function segmentProgress(_targetDir: string): StageProgress | null {
	return null;
}

// Total pdf/image pages recorded in inventory.yaml — pdf/image kinds only （a
// spreadsheet's own "page_count" is a sheet-ish placeholder, not a page
// prepare.ts ever renders one-per-page, and counting it would leave the
// denominator permanently one short of what "done" can ever reach). Shared by
// interpretProgress's page-rendering phase below.
//
// Validator finding (MAJOR 3): an "image" kind here previously counted EVERY
// extension inventory.ts's own IMAGE_EXTS recognises — including .heic/.tif/
// .tiff/.bmp, which prepare.ts cannot prepare at all (no READY_EXTS branch
// for them). Those files inflated the denominator with pages that could never
// be counted as done by countPreparedPageFiles() above, so `done` got stuck
// below `total` forever — a real customer folder with even one iPhone .heic
// photo or one .bmp scan would never let phase 1 (page rendering) complete,
// freezing the interpret bar at whatever fraction was reached right before
// it. Excluding an unpreparable image from the denominator entirely (rather
// than, say, still counting it and hoping done reaches it some other way) is
// correct because prepare.ts genuinely never produces an artifact for one —
// there is no "done" state for it to reach.
function inventoryPageTotal(inventory: Inventory): number {
	let total = 0;
	for (const file of inventory.files) {
		if (typeof file.page_count !== "number") continue;
		if (file.kind === "pdf") total += file.page_count;
		else if (file.kind === "image" && PREPARABLE_IMAGE_EXTS.has(extname(file.path).toLowerCase())) total += file.page_count;
	}
	return total;
}

// Stage 2 (interpret): a TWO-PHASE composite, because the stage itself has two
// visibly-distinct phases of work and only one denominator can be honest at a
// time. Phase 1 is runInterpretStage's own page-rendering prologue
// (runPreparePagesChunked, spawn-stage.ts:1614) — on a big client this alone
// can run over an hour, and without this phase the card would report a
// frozen 0/N หน่วยตีความ for the whole thing (the interpret UNITS below don't
// exist yet; only pages do). Once every inventory page has a rendered file on
// disk, phase 1 is done and progress switches to phase 2: the real unit
// count via createInterpretPlan (see below). The two phases share one
// denominator space in the UI only in the sense that a caller always gets a
// SINGLE StageProgress back — never both fractions at once — so the card
// never has to decide which one to show.
function interpretProgress(targetDir: string): StageProgress | null {
	const inventory = readYaml<Inventory>(join(targetDir, "ข้อมูลระบบ", "_pages", "inventory.yaml"));
	if (!inventory || !Array.isArray(inventory.files)) return null;
	const pageTotal = inventoryPageTotal(inventory);
	if (pageTotal > 0) {
		const preparedPages = countPreparedPageFiles(targetDir);
		if (preparedPages < pageTotal) return { done: preparedPages, total: pageTotal, unitLabel: "หน้า" };
	}

	// loadInterpretPlan (spawn-stage.ts) derives its plan from manifest.yaml +
	// inventory.yaml + dispositions.yaml through the pure createInterpretPlan —
	// recomputing it here, read-only, gives the EXACT unit count the executor
	// itself will work through, not an approximation. "done" is a unit whose
	// fragment file already landed in ข้อมูลระบบ/_pages/fragments/
	// (createInterpretPlan already computes each unit's own fragmentPath —
	// checking existsSync on that path, rather than re-deriving the fragment
	// naming scheme here, is what keeps this from ever drifting out of sync
	// with the real executor).
	const manifest = readYaml<SegmentsManifest>(join(targetDir, "ข้อมูลระบบ", "_segments", "manifest.yaml"));
	if (!manifest) return null;
	const dispositions = readYaml<{ entries?: Disposition[] }>(join(targetDir, "ข้อมูลระบบ", "_pages", "dispositions.yaml")) ?? {};
	let plan;
	try {
		plan = createInterpretPlan({ runRoot: targetDir, manifest, inventory, dispositions });
	} catch {
		// A manifest/inventory pairing the plan itself would reject (e.g. a
		// half-written manifest mid-Stage-1-retry) — no honest number, not a crash.
		return null;
	}
	if (plan.units.length === 0) return null;
	const done = plan.units.filter((unit) => existsSync(unit.fragmentPath)).length;
	return { done, total: plan.units.length, unitLabel: "หน่วยตีความ" };
}

type GroupSkeletonGroup = { path?: unknown };
type GroupSkeleton = { groups?: unknown };

// Shared by stage 4 (group) and stage 5 (categorize): both count against the
// SAME group-skeleton manifest.yaml (ข้อมูลระบบ/_doc_groups/manifest.yaml,
// schema ksk_doc_groups.v1) — group-skeleton.ts writes it once, deterministically,
// before either stage's populate/categorize work starts, so "how many groups
// exist" never itself changes mid-stage.
function groupSkeletonPaths(targetDir: string): string[] | null {
	const manifest = readYaml<GroupSkeleton>(join(targetDir, "ข้อมูลระบบ", "_doc_groups", "manifest.yaml"));
	if (!manifest || !Array.isArray(manifest.groups)) return null;
	const paths = (manifest.groups as GroupSkeletonGroup[])
		.map((g) => (g && typeof g.path === "string" ? g.path : null))
		.filter((p): p is string => p !== null);
	return paths.length > 0 ? paths : null;
}

// Stage 4 (group): a group counts as populated once its own
// <group.path>/interpretation.json exists (schema ksk_group_interpretation.v1
// — written either by group-populate.ts's script copy for `populate: script`
// groups, or by the ksk-marple wave for `populate: agent` ones; either way,
// the same file name is the populated marker for both).
function groupProgress(targetDir: string): StageProgress | null {
	const paths = groupSkeletonPaths(targetDir);
	if (!paths) return null;
	const doc_groups = join(targetDir, "ข้อมูลระบบ", "_doc_groups");
	const done = paths.filter((p) => existsSync(join(doc_groups, p, "interpretation.json"))).length;
	return { done, total: paths.length, unitLabel: "กลุ่มเอกสาร" };
}

// Stage 5 (categorize): same group list as stage 4, "done" now means
// <group.path>/categorize.json exists (the ⚡ ksk-poirot wave's output).
function categorizeProgress(targetDir: string): StageProgress | null {
	const paths = groupSkeletonPaths(targetDir);
	if (!paths) return null;
	const doc_groups = join(targetDir, "ข้อมูลระบบ", "_doc_groups");
	const done = paths.filter((p) => existsSync(join(doc_groups, p, "categorize.json"))).length;
	return { done, total: paths.length, unitLabel: "กลุ่มเอกสาร" };
}

/**
 * Stage 0 (profile), 3 (link) and 6 (final) are genuinely opaque — one
 * unbounded `claude -p` call (0), a short deterministic pass with nothing
 * meaningfully "N of M" about it (3), or not a working stage at all (6, the
 * completion gate). Rendering an invented bar for those would be worse than
 * rendering nothing — the caller (dashboard.ts) falls back to
 * "กำลังทำงาน · ผ่านไป N นาที" whenever this returns null, using timing data
 * it already has, not a fabricated fraction.
 *
 * MUST NEVER THROW: every helper above already treats a missing/malformed
 * artifact as null, but the outer try/catch is the actual guarantee against
 * anything unanticipated (e.g. an fs error class none of the above expects)
 * against a directory a live pipeline is concurrently writing into.
 */
export async function readStageProgress(targetDir: string, stageIndex: number): Promise<StageProgress | null> {
	try {
		switch (STAGE_ID_AT[stageIndex]) {
			case "segment":
				return segmentProgress(targetDir);
			case "interpret":
				return interpretProgress(targetDir);
			case "group":
				return groupProgress(targetDir);
			case "categorize":
				return categorizeProgress(targetDir);
			default:
				return null;
		}
	} catch {
		return null;
	}
}

// --- Subscriber-gated poll ticker (wayfinder #3's hard requirement) --------
// The operator's explicit choice: the server reads the disk for progress ONLY
// while at least one SSE client is connected. server.ts owns the actual
// subscriber Set and calls onSubscriberCountChange(eventSubscribers.size)
// every time a connection opens or closes; this factory only ever tracks
// 0-vs-nonzero and starts/stops exactly one interval, so a burst of N tabs
// connecting/disconnecting can never leak N timers or leave one running with
// nobody left to receive it. `timerApi` is injectable so a test can assert
// start/stop calls directly instead of waiting on a real 5s tick.
export type ProgressTicker = {
	onSubscriberCountChange(count: number): void;
	isRunning(): boolean;
};

export function createProgressTicker(
	onTick: () => void,
	intervalMs = 5_000,
	timerApi: { setInterval: typeof setInterval; clearInterval: typeof clearInterval } = { setInterval, clearInterval },
): ProgressTicker {
	let handle: ReturnType<typeof setInterval> | null = null;
	return {
		onSubscriberCountChange(count: number) {
			if (count > 0 && handle === null) {
				handle = timerApi.setInterval(onTick, intervalMs);
			} else if (count <= 0 && handle !== null) {
				timerApi.clearInterval(handle);
				handle = null;
			}
		},
		isRunning() {
			return handle !== null;
		},
	};
}
