// "How big is this month?" — the Page/unit count the dashboard shows for every
// client-month, INCLUDING one that has never been run, so the operator can see
// what a month costs before starting it.
//
// Two sources, in priority order:
//
//   1. ข้อมูลระบบ/_pages/inventory.yaml — the pipeline's OWN deterministic census
//      (.claude/skills/ksk-keying/scripts/inventory.ts, Stage 0). Once it
//      exists it is the truth: exact = true, and nothing here re-derives it.
//   2. A read-only scan of the source files, for a month whose Stage 0 has
//      never run. exact = false — this is an ESTIMATE and is labelled as one in
//      the UI.
//
// Why a second implementation instead of just running inventory.ts: that script
// WRITES (inventory.yaml, and it extracts .zip archives in place). A dashboard
// row must never mutate a client folder the operator hasn't started yet. So the
// counting RULES are mirrored here (pdf → pdfinfo pages, workbook → sheet
// count, image/csv/other → 1 unit, same closed skip-list) but nothing is
// written and no archive is touched — an un-extracted .zip counts as a single
// unit and is reported separately in `archives` so the UI can say the estimate
// is missing whatever is inside it.
//
// Cost control: a scan spawns one pdfinfo per PDF, so it is never run on the
// render path. MonthSizeCache.get() is synchronous and non-blocking — it hands
// back whatever it already knows (possibly nothing) and schedules the real work
// in the background; when a value lands or changes, onUpdated(relPath) fires so
// the caller can push the row over the existing SSE channel (server.ts's
// scheduleBroadcast). A month nobody is looking at costs nothing.
import { existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { parse as yamlParse } from "yaml";
import { readFile as readWorkbook } from "xlsx";
import type { Inventory } from "../sequencer/interpret-plan";

export type MonthSize = {
	/** Pages: PDF pages + workbook sheets + one per image/csv/other file. */
	units: number;
	/** Source files counted (not pages). */
	files: number;
	/** Un-extracted .zip archives counted as one unit each — whatever is inside
	 * them is NOT in `units`. Always 0 once the real census has run (inventory.ts
	 * extracts archives before censusing). */
	archives: number;
	/** true = read from the pipeline's own inventory.yaml; false = estimated. */
	exact: boolean;
};

// Mirrors .claude/skills/ksk-keying/scripts/paths.ts's GENERATED_DIRS. Not
// imported: console/ deliberately re-states the pipeline's path constants
// rather than reaching into the skill tree (same as run-store.ts/workspace.ts,
// which spell out "ข้อมูลระบบ"/"_pages" the same way).
const SKIP_DIRS = new Set(["ข้อมูลระบบ", "ตรวจทาน", "_segments", "_doc_groups", "_pages"]);
const SKIP_ROOT_FILES = new Set(["CLIENT.md", "coa.csv", "coa_usage.json", "learning-notes.md"]);
const OS_JUNK = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

// Only the extensions whose unit count ISN'T 1 need naming here: a PDF's page
// count and a workbook's sheet count. Images, csv and every unrecognised
// extension are one unit per file, so they need no list (inventory.ts lists
// IMAGE_EXTS only because it records a `kind` per file; this doesn't).
const WORKBOOK_EXTS = new Set([".xlsx", ".xls"]);

function isOsJunk(name: string): boolean {
	return OS_JUNK.has(name.toLowerCase()) || name.startsWith("._");
}

/** Sum an already-parsed inventory.yaml into a MonthSize. Pure — every
 * `page_count` here was produced by the pipeline's own census, so this only
 * adds up; it never re-counts anything. A file whose page_count isn't a
 * positive integer (a hand-edited or truncated inventory) counts as 1 rather
 * than poisoning the total with NaN. */
export function sumInventory(inventory: Inventory): MonthSize {
	const files = Array.isArray(inventory?.files) ? inventory.files : [];
	let units = 0;
	for (const file of files) {
		const n = file?.page_count;
		units += Number.isInteger(n) && (n as number) > 0 ? (n as number) : 1;
	}
	return { units, files: files.length, archives: 0, exact: true };
}

/** MonthSize from <targetDir>/ข้อมูลระบบ/_pages/inventory.yaml, or null when it
 * doesn't exist / doesn't parse. Same read-only, never-throw posture as
 * stage-progress.ts: a half-written file during Stage 0 is "not known yet". */
export function readInventorySize(targetDir: string): MonthSize | null {
	const path = join(targetDir, "ข้อมูลระบบ", "_pages", "inventory.yaml");
	if (!existsSync(path)) return null;
	try {
		const doc = yamlParse(readFileSync(path, "utf8")) as Inventory | null;
		if (!doc || !Array.isArray(doc.files)) return null;
		return sumInventory(doc);
	} catch {
		return null;
	}
}

async function pdfPageCount(path: string): Promise<number> {
	// Unlike inventory.ts (where a bad page count would corrupt the ledger's
	// denominator and MUST be loud), a failure here only makes one row's
	// estimate a little low — so it degrades to "at least 1 page" instead of
	// killing the whole dashboard scan. The exact number arrives from
	// inventory.yaml the moment the run's Stage 0 finishes.
	try {
		const proc = Bun.spawn(["pdfinfo", path], { stdout: "pipe", stderr: "ignore" });
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		if (proc.exitCode !== 0) return 1;
		const line = out.split(/\r?\n/).find((row) => row.startsWith("Pages:"));
		const count = line ? Number(line.split(":", 2)[1]?.trim()) : NaN;
		return Number.isInteger(count) && count >= 1 ? count : 1;
	} catch {
		return 1;
	}
}

function workbookSheetCount(path: string): number {
	try {
		const book = readWorkbook(path, { bookSheets: true });
		return Array.isArray(book.SheetNames) && book.SheetNames.length > 0 ? book.SheetNames.length : 1;
	} catch {
		return 1;
	}
}

/** Read-only estimate for a month whose Stage 0 census hasn't run. Never
 * writes, never extracts an archive, never throws — an unreadable folder reads
 * as zero, which the caller renders as "no number yet", not as "empty month". */
export async function scanSourceSize(targetDir: string): Promise<MonthSize> {
	const size: MonthSize = { units: 0, files: 0, archives: 0, exact: false };
	await walk(targetDir, targetDir, size);
	return size;
}

async function walk(root: string, dir: string, size: MonthSize): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const child = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			await walk(root, child, size);
			continue;
		}
		if (!entry.isFile()) continue;
		if (isOsJunk(entry.name)) continue;
		if (dir === root && SKIP_ROOT_FILES.has(entry.name)) continue;

		const ext = extname(entry.name).toLowerCase();
		size.files++;
		if (ext === ".pdf") {
			size.units += await pdfPageCount(child);
		} else if (WORKBOOK_EXTS.has(ext)) {
			size.units += workbookSheetCount(child);
		} else if (ext === ".zip") {
			// Counted as one unit, and flagged: the real census extracts it first,
			// so this estimate is short by however many documents are inside.
			size.archives++;
			size.units += 1;
		} else {
			// image / csv / anything unrecognised — one unit per file, exactly as
			// inventory.ts treats kind "image", "spreadsheet" (csv) and "other".
			size.units += 1;
		}
	}
}

/** One month's newest source-file mtime + file count, cheap enough to run on a
 * refresh tick: it's a plain directory walk with no pdfinfo spawns. Used only
 * to decide whether a cached ESTIMATE is still describing the same folder — an
 * exact (inventory.yaml) size is never invalidated by this. */
async function sourceFingerprint(targetDir: string): Promise<string> {
	let newest = 0;
	let count = 0;
	const visit = async (dir: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) await visit(join(dir, entry.name));
				continue;
			}
			if (!entry.isFile() || isOsJunk(entry.name)) continue;
			count++;
			const st = await stat(join(dir, entry.name)).catch(() => null);
			if (st && st.mtimeMs > newest) newest = st.mtimeMs;
		}
	};
	await visit(targetDir);
	return `${count}:${Math.round(newest)}`;
}

function sameSize(a: MonthSize | null, b: MonthSize | null): boolean {
	if (!a || !b) return a === b;
	return a.units === b.units && a.files === b.files && a.archives === b.archives && a.exact === b.exact;
}

type Entry = { size: MonthSize; fingerprint: string; computedAt: number };

export type MonthSizeCacheOptions = {
	/** Fired after a background computation produced a DIFFERENT value than what
	 * was cached (including the first one) — the caller re-renders that row. */
	onUpdated?: (relPath: string) => void;
	/** How long a cached value is served before a background refresh is
	 * scheduled. Default 10 minutes. */
	ttlMs?: number;
	/** How many months may be scanned at once. Default 2 — a scan is mostly
	 * waiting on pdfinfo, but a workspace with 40 months shouldn't fork 40
	 * processes at once against the same disk a live run is using. */
	concurrency?: number;
};

/**
 * Non-blocking, self-refreshing cache of every month's size.
 *
 * `get()` is synchronous by design: the dashboard render must not wait on a
 * pdfinfo sweep. It returns what is known now (null the very first time) and
 * schedules the work; `onUpdated` then drives the row's re-render through the
 * SSE path that already exists.
 */
export class MonthSizeCache {
	private entries = new Map<string, Entry>();
	private queued = new Set<string>();
	private queue: { relPath: string; targetDir: string }[] = [];
	private running = 0;
	private readonly onUpdated?: (relPath: string) => void;
	private readonly ttlMs: number;
	private readonly concurrency: number;

	constructor(options: MonthSizeCacheOptions = {}) {
		this.onUpdated = options.onUpdated;
		this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
		this.concurrency = Math.max(1, options.concurrency ?? 2);
	}

	/** What's known right now; schedules a (re)computation when nothing is
	 * cached or the cached value has aged past the TTL. Never throws, never
	 * blocks. */
	get(relPath: string, targetDir: string): MonthSize | null {
		const entry = this.entries.get(relPath);
		if (!entry || Date.now() - entry.computedAt >= this.ttlMs) this.schedule(relPath, targetDir);
		return entry?.size ?? null;
	}

	/** Compute one month synchronously (awaited) — used by tests and by any
	 * caller that genuinely wants to wait. Updates the cache the same way the
	 * background worker does. */
	async refresh(relPath: string, targetDir: string): Promise<MonthSize | null> {
		const previous = this.entries.get(relPath)?.size ?? null;
		const exact = readInventorySize(targetDir);
		const size = exact ?? (existsSync(targetDir) ? await scanSourceSize(targetDir) : null);
		if (!size) {
			this.entries.delete(relPath);
			if (previous) this.onUpdated?.(relPath);
			return null;
		}
		// An exact size can't go stale from source files changing (the census is
		// a property of the run, not of the folder), so it stores a fixed
		// fingerprint instead of paying for a walk.
		const fingerprint = size.exact ? "exact" : await sourceFingerprint(targetDir);
		this.entries.set(relPath, { size, fingerprint, computedAt: Date.now() });
		if (!sameSize(previous, size)) this.onUpdated?.(relPath);
		return size;
	}

	/** Drop everything — a workspace-wide invalidation hook for tests. */
	clear(): void {
		this.entries.clear();
	}

	private schedule(relPath: string, targetDir: string): void {
		if (this.queued.has(relPath)) return;
		this.queued.add(relPath);
		this.queue.push({ relPath, targetDir });
		this.pump();
	}

	private pump(): void {
		while (this.running < this.concurrency && this.queue.length > 0) {
			const job = this.queue.shift()!;
			this.running++;
			void this.run(job.relPath, job.targetDir).finally(() => {
				this.running--;
				this.queued.delete(job.relPath);
				this.pump();
			});
		}
	}

	private async run(relPath: string, targetDir: string): Promise<void> {
		const entry = this.entries.get(relPath);
		// A cached ESTIMATE whose folder hasn't changed doesn't need re-scanning —
		// just re-stamp it so the TTL doesn't re-queue it every tick. The
		// fingerprint walk is spawn-free, so this is the cheap path a steady
		// workspace settles into. (An inventory.yaml appearing DOES need picking
		// up, so that's checked first, before the fingerprint shortcut.)
		if (entry && !entry.size.exact) {
			const exact = readInventorySize(targetDir);
			if (!exact) {
				const fingerprint = await sourceFingerprint(targetDir);
				if (fingerprint === entry.fingerprint) {
					this.entries.set(relPath, { ...entry, computedAt: Date.now() });
					return;
				}
			}
		}
		await this.refresh(relPath, targetDir).catch(() => null);
	}
}
