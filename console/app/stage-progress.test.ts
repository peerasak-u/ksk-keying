import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { createProgressTicker, readStageProgress } from "./stage-progress";
import { STAGES } from "../sequencer/logic";

const STAGE_INDEX: Record<string, number> = Object.fromEntries(STAGES.map((s, i) => [s.id, i]));

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ksk-stage-progress-test-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeYaml(path: string, value: unknown) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, yamlStringify(value), "utf8");
}

describe("readStageProgress — opaque stages", () => {
	test("stage 0 (profile) is always null", async () => {
		expect(await readStageProgress(root, STAGE_INDEX.profile)).toBeNull();
	});
	test("stage 3 (link) is always null", async () => {
		expect(await readStageProgress(root, STAGE_INDEX.link)).toBeNull();
	});
	test("stage 6 (final) is always null", async () => {
		expect(await readStageProgress(root, STAGE_INDEX.final)).toBeNull();
	});
	// Validator finding: stage 1 (segment) has no rendering work of its own —
	// prepare.ts's page rendering runs inside runInterpretStage (stage 2), not
	// the segment stage (its only script is the segment Ledger Gate). Mapping
	// it to prepared-page counting produced two invented bars: pinned at 0/N
	// for a fresh run's entire stage-1 duration, and instantly full N/N on a
	// re-run of an already-prepared month that had done zero segment work.
	// Stage 1 is therefore opaque, same as profile/link/final, EVEN WHEN
	// inventory.yaml and rendered pages already exist on disk.
	test("stage 1 (segment) is always null, even with a real inventory.yaml and rendered pages on disk", async () => {
		writeYaml(join(root, "ข้อมูลระบบ", "_pages", "inventory.yaml"), {
			schema: "ksk_inventory.v1",
			files: [{ path: "a.pdf", kind: "pdf", page_count: 3, sheets: null }],
		});
		mkdirSync(join(root, "_pages", "a"), { recursive: true });
		writeFileSync(join(root, "_pages", "a", "page-001.png"), "x");
		expect(await readStageProgress(root, STAGE_INDEX.segment)).toBeNull();
	});
});

describe("readStageProgress — stage 2 (interpret)", () => {
	function paths() {
		return {
			manifest: join(root, "ข้อมูลระบบ", "_segments", "manifest.yaml"),
			inventory: join(root, "ข้อมูลระบบ", "_pages", "inventory.yaml"),
			fragments: join(root, "ข้อมูลระบบ", "_pages", "fragments"),
		};
	}

	function writeOneSegmentPlan() {
		const p = paths();
		writeYaml(p.manifest, {
			schema: "ksk_segments.v1",
			segments: [{ segment_id: "seg-001", type: "pdf_range", sources: [{ file: "a.pdf", pages: [1, 2], sheets: null }] }],
		});
		writeYaml(p.inventory, { schema: "ksk_inventory.v1", files: [{ path: "a.pdf", kind: "pdf", page_count: 2, sheets: null }] });
	}

	// Two-phase composite (validator finding): while runInterpretStage's own
	// page-rendering prologue is still short of the inventory's page total,
	// the honest number is the PAGE ratio, not a frozen 0/N unit count — the
	// interpret units themselves don't exist yet at that point.
	test("phase 1: reports the page-rendering ratio while prepared pages are short of the inventory total", async () => {
		writeOneSegmentPlan(); // a.pdf, page_count: 2 — no rendered pages yet
		const progress = await readStageProgress(root, STAGE_INDEX.interpret);
		expect(progress).toEqual({ done: 0, total: 2, unitLabel: "หน้า" });

		mkdirSync(join(root, "_pages", "a"), { recursive: true });
		writeFileSync(join(root, "_pages", "a", "page-001.png"), "x");
		const mid = await readStageProgress(root, STAGE_INDEX.interpret);
		expect(mid).toEqual({ done: 1, total: 2, unitLabel: "หน้า" });
	});

	// Phase 2 (validator finding): once every inventory page has a rendered
	// file on disk, progress switches to the real unit count via
	// createInterpretPlan — recomputes the exact unit count via
	// createInterpretPlan; done counts existing fragments.
	test("phase 2: switches to the createInterpretPlan unit ratio once page rendering has fully caught up", async () => {
		writeOneSegmentPlan();
		mkdirSync(join(root, "_pages", "a"), { recursive: true });
		writeFileSync(join(root, "_pages", "a", "page-001.png"), "x");
		writeFileSync(join(root, "_pages", "a", "page-002.png"), "x"); // 2/2 — phase 1 done

		const progress = await readStageProgress(root, STAGE_INDEX.interpret);
		expect(progress).toEqual({ done: 0, total: 1, unitLabel: "หน่วยตีความ" });

		mkdirSync(paths().fragments, { recursive: true });
		writeFileSync(join(paths().fragments, "seg-001.yaml"), "x", "utf8");
		const after = await readStageProgress(root, STAGE_INDEX.interpret);
		expect(after).toEqual({ done: 1, total: 1, unitLabel: "หน่วยตีความ" });
	});

	// Validator finding: countPreparedPageFiles used to count EVERY file under
	// _pages (including a spreadsheet ready-file's copied `page-001.xlsx`),
	// while inventoryPageTotal() deliberately excludes spreadsheet kinds from
	// the denominator — so a spreadsheet alongside pdf pages inflated `done`
	// past what pdf/image pages alone could ever reach, and could flip phase 1
	// to "done" (and switch to phase 2) before every pdf page was rendered.
	test("phase 1: a rendered spreadsheet ready-file does not inflate the page numerator", async () => {
		const p = paths();
		writeYaml(p.manifest, {
			schema: "ksk_segments.v1",
			segments: [{ segment_id: "seg-001", type: "pdf_range", sources: [{ file: "a.pdf", pages: [1, 2], sheets: null }] }],
		});
		writeYaml(p.inventory, {
			schema: "ksk_inventory.v1",
			files: [
				{ path: "a.pdf", kind: "pdf", page_count: 2, sheets: null },
				{ path: "b.xlsx", kind: "spreadsheet", page_count: 1, sheets: 1 },
			],
		});
		// Only one of the two pdf pages is rendered so far...
		mkdirSync(join(root, "_pages", "a"), { recursive: true });
		writeFileSync(join(root, "_pages", "a", "page-001.png"), "x");
		// ...but the spreadsheet ready-file has already been copied in full.
		mkdirSync(join(root, "_pages", "b"), { recursive: true });
		writeFileSync(join(root, "_pages", "b", "page-001.xlsx"), "x");

		const progress = await readStageProgress(root, STAGE_INDEX.interpret);
		// Denominator stays at 2 (pdf pages only) and done must NOT count the
		// spreadsheet artifact — it must still read 1/2, not a false 2/2.
		expect(progress).toEqual({ done: 1, total: 2, unitLabel: "หน้า" });
	});

	// Validator finding (MAJOR 3): PREPARED_PAGE_FILE used to only match
	// .png/.jpg/.jpeg, even though prepare.ts's planReadyFile copies a ready
	// .webp document to page-001.webp verbatim — a real customer folder with
	// a LINE/web-downloaded .webp image would sit at a numerator that could
	// never reach its denominator.
	test("phase 1: a fully-prepared .webp document reaches phase 2 (numerator counts .webp artifacts)", async () => {
		const p = paths();
		writeYaml(p.manifest, {
			schema: "ksk_segments.v1",
			segments: [{ segment_id: "seg-001", type: "pdf_range", sources: [{ file: "a.webp", pages: [1, 1], sheets: null }] }],
		});
		writeYaml(p.inventory, {
			schema: "ksk_inventory.v1",
			files: [{ path: "a.webp", kind: "image", page_count: 1, sheets: null }],
		});
		mkdirSync(join(root, "_pages", "a"), { recursive: true });
		writeFileSync(join(root, "_pages", "a", "page-001.webp"), "x");

		const progress = await readStageProgress(root, STAGE_INDEX.interpret);
		// 1/1 prepared pages — phase 1 is caught up, so this must already have
		// switched to phase 2 (the unit ratio), not be stuck reporting 0/1 หน้า.
		expect(progress).toEqual({ done: 0, total: 1, unitLabel: "หน่วยตีความ" });
	});

	// Validator finding (MAJOR 3): inventory.ts's own IMAGE_EXTS includes
	// .heic (the iPhone camera default) but prepare.ts has no READY_EXTS
	// branch for it at all — it can never produce a page-NNN artifact for
	// one. Counting it in the denominator anyway pinned `done < total`
	// forever for any month with such a file.
	test("phase 1: a .heic document is excluded from the page denominator entirely (prepare.ts cannot prepare it)", async () => {
		const p = paths();
		writeYaml(p.manifest, {
			schema: "ksk_segments.v1",
			segments: [{ segment_id: "seg-001", type: "pdf_range", sources: [{ file: "a.pdf", pages: [1, 1], sheets: null }] }],
		});
		writeYaml(p.inventory, {
			schema: "ksk_inventory.v1",
			files: [
				{ path: "a.pdf", kind: "pdf", page_count: 1, sheets: null },
				{ path: "b.heic", kind: "image", page_count: 1, sheets: null },
			],
		});
		mkdirSync(join(root, "_pages", "a"), { recursive: true });
		writeFileSync(join(root, "_pages", "a", "page-001.png"), "x");

		const progress = await readStageProgress(root, STAGE_INDEX.interpret);
		// Denominator is 1 (the pdf page only) — the .heic page never counts,
		// so this reaches phase 2 instead of sitting at 1/2 forever.
		expect(progress).toEqual({ done: 0, total: 1, unitLabel: "หน่วยตีความ" });
	});

	test("missing manifest.yaml or inventory.yaml yields null", async () => {
		expect(await readStageProgress(root, STAGE_INDEX.interpret)).toBeNull();
	});

	test("a manifest the plan itself rejects (unknown inventory file) yields null, not a throw", async () => {
		const p = paths();
		writeYaml(p.manifest, {
			schema: "ksk_segments.v1",
			segments: [{ segment_id: "seg-001", type: "pdf_range", sources: [{ file: "missing.pdf", pages: [1, 1], sheets: null }] }],
		});
		writeYaml(p.inventory, { schema: "ksk_inventory.v1", files: [] });
		expect(await readStageProgress(root, STAGE_INDEX.interpret)).toBeNull();
	});

	test("malformed manifest.yaml yields null rather than throwing", async () => {
		mkdirSync(join(root, "ข้อมูลระบบ", "_segments"), { recursive: true });
		writeFileSync(join(root, "ข้อมูลระบบ", "_segments", "manifest.yaml"), "segments: [", "utf8");
		writeYaml(paths().inventory, { schema: "ksk_inventory.v1", files: [] });
		expect(await readStageProgress(root, STAGE_INDEX.interpret)).toBeNull();
	});
});

describe("readStageProgress — stage 4 (group) and stage 5 (categorize)", () => {
	function writeSkeleton() {
		writeYaml(join(root, "ข้อมูลระบบ", "_doc_groups", "manifest.yaml"), {
			schema: "ksk_doc_groups.v1",
			layout: "category_vat_tree.v1",
			groups: [
				{ id: "seg-002", path: "bank_statement/seg-002" },
				{ id: "seg-003-x", path: "income/vat/seg-003-x" },
			],
		});
	}

	test("stage 4: counts groups with interpretation.json against the skeleton's group count", async () => {
		writeSkeleton();
		const groupDir = join(root, "ข้อมูลระบบ", "_doc_groups", "bank_statement", "seg-002");
		mkdirSync(groupDir, { recursive: true });
		writeFileSync(join(groupDir, "interpretation.json"), "{}", "utf8");
		const progress = await readStageProgress(root, STAGE_INDEX.group);
		expect(progress).toEqual({ done: 1, total: 2, unitLabel: "กลุ่มเอกสาร" });
	});

	test("stage 5: counts groups with categorize.json against the same skeleton", async () => {
		writeSkeleton();
		const bankDir = join(root, "ข้อมูลระบบ", "_doc_groups", "bank_statement", "seg-002");
		const incomeDir = join(root, "ข้อมูลระบบ", "_doc_groups", "income", "vat", "seg-003-x");
		mkdirSync(bankDir, { recursive: true });
		mkdirSync(incomeDir, { recursive: true });
		writeFileSync(join(bankDir, "categorize.json"), "{}", "utf8");
		writeFileSync(join(incomeDir, "categorize.json"), "{}", "utf8");
		const progress = await readStageProgress(root, STAGE_INDEX.categorize);
		expect(progress).toEqual({ done: 2, total: 2, unitLabel: "กลุ่มเอกสาร" });
	});

	test("missing manifest.yaml yields null for both stages", async () => {
		expect(await readStageProgress(root, STAGE_INDEX.group)).toBeNull();
		expect(await readStageProgress(root, STAGE_INDEX.categorize)).toBeNull();
	});

	test("malformed manifest.yaml yields null rather than throwing", async () => {
		mkdirSync(join(root, "ข้อมูลระบบ", "_doc_groups"), { recursive: true });
		writeFileSync(join(root, "ข้อมูลระบบ", "_doc_groups", "manifest.yaml"), "groups: [", "utf8");
		expect(await readStageProgress(root, STAGE_INDEX.group)).toBeNull();
	});
});

describe("createProgressTicker — subscriber-gated 5s poll", () => {
	function fakeTimers() {
		const calls: { started: boolean; intervalMs?: number }[] = [];
		let nextHandle = 1;
		const active = new Set<number>();
		return {
			setInterval: ((fn: () => void, ms: number) => {
				const handle = nextHandle++;
				active.add(handle);
				calls.push({ started: true, intervalMs: ms });
				return handle as unknown as ReturnType<typeof setInterval>;
			}) as typeof setInterval,
			clearInterval: ((handle: any) => {
				active.delete(handle);
				calls.push({ started: false });
			}) as typeof clearInterval,
			calls,
			activeCount: () => active.size,
		};
	}

	test("does not start a timer while the subscriber count is zero", () => {
		const timers = fakeTimers();
		const ticker = createProgressTicker(() => {}, 5_000, timers);
		expect(ticker.isRunning()).toBe(false);
		expect(timers.calls).toHaveLength(0);
	});

	test("starts exactly one interval on 0 -> 1, and never a second one on a further increase", () => {
		const timers = fakeTimers();
		const ticker = createProgressTicker(() => {}, 5_000, timers);
		ticker.onSubscriberCountChange(1);
		expect(ticker.isRunning()).toBe(true);
		expect(timers.activeCount()).toBe(1);
		ticker.onSubscriberCountChange(2); // a second tab connecting
		expect(timers.activeCount()).toBe(1); // still exactly one shared timer
	});

	test("stops the interval on N -> 0", () => {
		const timers = fakeTimers();
		const ticker = createProgressTicker(() => {}, 5_000, timers);
		ticker.onSubscriberCountChange(1);
		ticker.onSubscriberCountChange(0);
		expect(ticker.isRunning()).toBe(false);
		expect(timers.activeCount()).toBe(0);
	});

	test("passes the configured interval through to setInterval", () => {
		const timers = fakeTimers();
		const ticker = createProgressTicker(() => {}, 7_000, timers);
		ticker.onSubscriberCountChange(1);
		expect(timers.calls[0]).toEqual({ started: true, intervalMs: 7_000 });
	});
});
