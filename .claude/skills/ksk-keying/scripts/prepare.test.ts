import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processClientDir, selectChunk, type Args } from "./prepare";

// Fix F — chunking (`--max-pages`) unit + integration coverage.
//
// The integration tests below deliberately use only "ready" files (.jpg
// placeholders) rather than real PDFs: prepareReadyFile just copies bytes and
// costs exactly 1 page each — no poppler/pdftoppm dependency, no rendering
// time, fully deterministic — while still exercising the EXACT same
// plan/select/execute/skip machinery a real client's PDFs go through
// (planPdf and planReadyFile both produce the same PlannedSource shape and
// feed the same selectChunk selector). Real-PDF rendering is left to the
// deployed pipeline; this suite is about the chunking/resumability contract,
// not pdftoppm behaviour (already covered by page-dpi.test.ts).

function baseArgs(clientDir: string, overrides: Partial<Args> = {}): Args {
	return {
		clientDir,
		dpi: 200,
		concurrency: 4,
		force: false,
		dryRun: false,
		json: false,
		jsonSummary: false,
		maxPages: undefined,
		...overrides,
	};
}

function makeReadyFiles(dir: string, count: number) {
	for (let i = 1; i <= count; i++) {
		writeFileSync(join(dir, `doc-${String(i).padStart(3, "0")}.jpg`), `fake-image-${i}`);
	}
}

describe("selectChunk", () => {
	test("no maxPages selects everything and reports no remaining work", () => {
		const { selected, total, workRemains } = selectChunk([5, 3, 2], undefined);
		expect(selected).toEqual([0, 1, 2]);
		expect(total).toBe(10);
		expect(workRemains).toBe(false);
	});

	test("empty list with no maxPages", () => {
		const { selected, total, workRemains } = selectChunk([], undefined);
		expect(selected).toEqual([]);
		expect(total).toBe(0);
		expect(workRemains).toBe(false);
	});

	test("greedily selects while under budget, stops once budget is reached", () => {
		// costs: 2,2,2,2,2 with maxPages=5 -> take 3 (total 6 >= 5), leave 2 pending
		const { selected, total, workRemains } = selectChunk([2, 2, 2, 2, 2], 5);
		expect(selected).toEqual([0, 1, 2]);
		expect(total).toBe(6);
		expect(workRemains).toBe(true);
	});

	test("exact boundary: total lands exactly on maxPages", () => {
		const { selected, total, workRemains } = selectChunk([3, 3, 4], 6);
		expect(selected).toEqual([0, 1]);
		expect(total).toBe(6);
		expect(workRemains).toBe(true);
	});

	test("always makes progress: first pending item is included even if its own cost exceeds the whole budget", () => {
		const { selected, total, workRemains } = selectChunk([50, 1, 1], 5);
		expect(selected).toEqual([0]);
		expect(total).toBe(50);
		expect(workRemains).toBe(true);
	});

	test("budget covers everything exactly: no work remains", () => {
		const { selected, total, workRemains } = selectChunk([1, 1, 1], 3);
		expect(selected).toEqual([0, 1, 2]);
		expect(total).toBe(3);
		expect(workRemains).toBe(false);
	});

	test("budget larger than total cost: no work remains", () => {
		const { selected, total, workRemains } = selectChunk([1, 1], 100);
		expect(selected).toEqual([0, 1]);
		expect(total).toBe(2);
		expect(workRemains).toBe(false);
	});
});

describe("processClientDir — --max-pages chunking (ready files only)", () => {
	function withTmpDir(fn: (dir: string) => Promise<void> | void) {
		const dir = mkdtempSync(join(tmpdir(), "ksk-prepare-chunk-"));
		return (async () => {
			try {
				await fn(dir);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		})();
	}

	test("no --max-pages: unbounded, matches pre-chunking behaviour", () =>
		withTmpDir(async (dir) => {
			makeReadyFiles(dir, 4);
			const payload = await processClientDir(baseArgs(dir));
			expect(payload.prepared).toBe(4);
			expect(payload.deferred).toBe(0);
			expect(payload.max_pages).toBeUndefined();
			expect(payload.chunk_pages_rendered).toBeUndefined();
			expect(payload.work_remains).toBe(false);
		}));

	test("--max-pages smaller than total work: renders a bounded chunk and reports work_remains", () =>
		withTmpDir(async (dir) => {
			makeReadyFiles(dir, 7);
			const payload = await processClientDir(baseArgs(dir, { maxPages: 3 }));
			expect(payload.prepared).toBe(3);
			expect(payload.deferred).toBe(4);
			expect(payload.max_pages).toBe(3);
			expect(payload.chunk_pages_rendered).toBe(3);
			expect(payload.work_remains).toBe(true);
			const statuses = payload.results.map((r: any) => r.status);
			expect(statuses.filter((s: string) => s === "prepared").length).toBe(3);
			expect(statuses.filter((s: string) => s === "deferred").length).toBe(4);
		}));

	test("looping the chunk to completion is resumable via the existing skip-if-exists check", () =>
		withTmpDir(async (dir) => {
			makeReadyFiles(dir, 10);
			let renderedTotal = 0;
			let iterations = 0;
			for (;;) {
				iterations++;
				const payload = await processClientDir(baseArgs(dir, { maxPages: 4 }));
				renderedTotal += payload.prepared;
				if (!payload.work_remains) break;
				if (iterations > 20) throw new Error("loop did not converge — test bug or regression");
			}
			expect(renderedTotal).toBe(10);
			// A final unbounded pass finds nothing left to do — every source is
			// skip-if-exists, none re-rendered.
			const final = await processClientDir(baseArgs(dir));
			expect(final.prepared).toBe(0);
			expect(final.skipped).toBe(10);
		}));

	test("a chunked invocation never re-renders a source an earlier chunk already prepared", () =>
		withTmpDir(async (dir) => {
			makeReadyFiles(dir, 5);
			const first = await processClientDir(baseArgs(dir, { maxPages: 2 }));
			expect(first.prepared).toBe(2);
			const preparedSourcesFirst = new Set(
				first.results.filter((r: any) => r.status === "prepared").map((r: any) => r.source),
			);
			const second = await processClientDir(baseArgs(dir, { maxPages: 2 }));
			expect(second.prepared).toBe(2);
			const preparedSourcesSecond = new Set(
				second.results.filter((r: any) => r.status === "prepared").map((r: any) => r.source),
			);
			for (const source of preparedSourcesSecond) expect(preparedSourcesFirst.has(source)).toBe(false);
		}));

	test("--force with --max-pages still bounds the chunk even though nothing is skip-eligible", () =>
		withTmpDir(async (dir) => {
			makeReadyFiles(dir, 6);
			await processClientDir(baseArgs(dir)); // fully prepare once
			const payload = await processClientDir(baseArgs(dir, { maxPages: 2, force: true }));
			expect(payload.prepared).toBe(2);
			expect(payload.deferred).toBe(4);
			expect(payload.skipped).toBe(0);
		}));

	// Blocker fix: --json-summary must print machine-readable JSON WITHOUT the
	// unbounded per-source `results[]` array — see this flag's Args.jsonSummary
	// comment for the incident (a 691,277-byte real chunk payload, 69% of
	// process-supervisor.ts's 1,000,000-byte retention cap) this exists to
	// avoid. CLI-level (spawnSync), not processClientDir-level, because the
	// `results`-stripping happens in main(), not in processClientDir itself.
	test("--json-summary omits results[] but keeps every counter --json would report", async () => {
		const { spawnSync } = await import("node:child_process");
		const dir = mkdtempSync(join(tmpdir(), "ksk-prepare-jsonsummary-"));
		try {
			makeReadyFiles(dir, 3);
			const result = spawnSync(
				"bun",
				["run", join(import.meta.dirname, "prepare.ts"), "--", "--json-summary", dir],
				{ encoding: "utf8" },
			);
			expect(result.status).toBe(0);
			const payload = JSON.parse(result.stdout);
			expect(payload.results).toBeUndefined();
			expect(payload.ok).toBe(true);
			expect(payload.prepared).toBe(3);
			expect(payload.skipped).toBe(0);
			expect(payload.deferred).toBe(0);
			expect(payload.pdf_count).toBe(0);
			expect(payload.ready_count).toBe(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects a non-positive --max-pages value at the CLI layer", async () => {
		const { spawnSync } = await import("node:child_process");
		const dir = mkdtempSync(join(tmpdir(), "ksk-prepare-badflag-"));
		try {
			const result = spawnSync("bun", ["run", join(import.meta.dirname, "prepare.ts"), "--", "--max-pages", "0", dir], {
				encoding: "utf8",
			});
			expect(result.status).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
