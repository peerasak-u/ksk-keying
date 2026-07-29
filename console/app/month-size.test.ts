import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { MonthSizeCache, readInventorySize, scanSourceSize, sumInventory } from "./month-size";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ksk-month-size-test-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function touch(relPath: string, content = "x") {
	const path = join(root, relPath);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

function writeInventory(files: { path: string; kind: string; page_count: number }[]) {
	const path = join(root, "ข้อมูลระบบ", "_pages", "inventory.yaml");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, yamlStringify({ schema: "ksk_inventory.v1", files: files.map((f) => ({ ...f, sheets: null })) }), "utf8");
}

describe("sumInventory", () => {
	test("adds the census's own page counts — never re-counts anything", () => {
		expect(
			sumInventory({
				files: [
					{ path: "a.pdf", kind: "pdf", page_count: 12, sheets: null },
					{ path: "b.jpg", kind: "image", page_count: 1, sheets: null },
					{ path: "c.xlsx", kind: "spreadsheet", page_count: 3, sheets: ["a", "b", "c"] },
				],
			}),
		).toEqual({ units: 16, files: 3, archives: 0, exact: true });
	});

	test("a corrupt page_count counts as one page instead of poisoning the total", () => {
		const size = sumInventory({
			files: [
				{ path: "a.pdf", kind: "pdf", page_count: Number.NaN, sheets: null },
				{ path: "b.pdf", kind: "pdf", page_count: 4, sheets: null },
			],
		});
		expect(size.units).toBe(5);
	});

	test("an empty census is a real zero, not a missing number", () => {
		expect(sumInventory({ files: [] })).toEqual({ units: 0, files: 0, archives: 0, exact: true });
	});
});

describe("readInventorySize", () => {
	test("null when the census hasn't run", () => {
		expect(readInventorySize(root)).toBeNull();
	});

	test("reads the pipeline's own census as exact", () => {
		writeInventory([
			{ path: "a.pdf", kind: "pdf", page_count: 10 },
			{ path: "b.pdf", kind: "pdf", page_count: 5 },
		]);
		expect(readInventorySize(root)).toEqual({ units: 15, files: 2, archives: 0, exact: true });
	});

	test("a half-written inventory reads as 'not known yet', never throws", () => {
		const path = join(root, "ข้อมูลระบบ", "_pages", "inventory.yaml");
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "files:\n  - path: a.pdf\n    page_count: [unclosed", "utf8");
		expect(readInventorySize(root)).toBeNull();
	});
});

describe("scanSourceSize", () => {
	test("one unit per image/csv/unknown file, and the file count comes with it", async () => {
		touch("bill.jpg");
		touch("statement.csv");
		touch("notes.txt");
		expect(await scanSourceSize(root)).toEqual({ units: 3, files: 3, archives: 0, exact: false });
	});

	test("recurses into source subfolders", async () => {
		touch("ใบกำกับภาษี/a.jpg");
		touch("ใบกำกับภาษี/ซื้อ/b.jpg");
		const size = await scanSourceSize(root);
		expect(size.files).toBe(2);
		expect(size.units).toBe(2);
	});

	test("skips the pipeline's own generated folders and client-context files", async () => {
		touch("bill.jpg");
		touch("ข้อมูลระบบ/_pages/inventory.yaml");
		touch("ตรวจทาน/ตรวจทาน.html");
		touch("_segments/manifest.yaml");
		touch("CLIENT.md");
		touch("coa.csv");
		const size = await scanSourceSize(root);
		expect(size.files).toBe(1);
		expect(size.units).toBe(1);
	});

	test("skips OS junk", async () => {
		touch("bill.jpg");
		touch(".DS_Store");
		touch("._bill.jpg");
		touch("Thumbs.db");
		expect((await scanSourceSize(root)).files).toBe(1);
	});

	test("a coa.csv deeper in the tree is a real document, not the client-context file", async () => {
		// The skip only applies at the run root, exactly as inventory.ts does it.
		touch("รายงาน/coa.csv");
		expect((await scanSourceSize(root)).files).toBe(1);
	});

	test("an un-extracted zip counts as one unit and is flagged as uncounted inside", async () => {
		touch("grab.zip");
		touch("bill.jpg");
		expect(await scanSourceSize(root)).toEqual({ units: 2, files: 2, archives: 1, exact: false });
	});

	test("a missing folder reads as zero rather than throwing", async () => {
		expect(await scanSourceSize(join(root, "nope"))).toEqual({ units: 0, files: 0, archives: 0, exact: false });
	});

	test("real PDF page counts when pdfinfo is available", async () => {
		// Skipped where poppler isn't installed — the production path (Docker)
		// always has it, and the fallback is covered by the estimate being
		// explicitly approximate.
		const hasPdfinfo = Bun.spawnSync(["which", "pdfinfo"]).exitCode === 0;
		if (!hasPdfinfo) return;
		// A minimal valid 2-page PDF, written by hand so the test needs no fixture
		// binary: two /Type /Page objects under one /Pages tree.
		const pdf = [
			"%PDF-1.4",
			"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
			"2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>endobj",
			"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj",
			"4 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj",
			"trailer<</Root 1 0 R/Size 5>>",
			"%%EOF",
		].join("\n");
		touch("two-pages.pdf", pdf);
		const size = await scanSourceSize(root);
		expect(size.files).toBe(1);
		expect(size.units).toBe(2);
	});
});

describe("MonthSizeCache", () => {
	test("get() never blocks: null first, real value after the background pass", async () => {
		touch("a.jpg");
		touch("b.jpg");
		let updates: string[] = [];
		const cache = new MonthSizeCache({ onUpdated: (relPath) => updates.push(relPath) });
		expect(cache.get("216/พ.ค.", root)).toBeNull();
		// The scheduled pass lands on its own; refresh() awaits the same work.
		const size = await cache.refresh("216/พ.ค.", root);
		expect(size).toEqual({ units: 2, files: 2, archives: 0, exact: false });
		expect(cache.get("216/พ.ค.", root)).toEqual({ units: 2, files: 2, archives: 0, exact: false });
		expect(updates).toContain("216/พ.ค.");
	});

	test("the census wins over the estimate as soon as it exists", async () => {
		touch("a.pdf", "not really a pdf");
		const cache = new MonthSizeCache();
		const estimate = await cache.refresh("216/พ.ค.", root);
		expect(estimate?.exact).toBe(false);
		writeInventory([{ path: "a.pdf", kind: "pdf", page_count: 42 }]);
		const exact = await cache.refresh("216/พ.ค.", root);
		expect(exact).toEqual({ units: 42, files: 1, archives: 0, exact: true });
	});

	test("onUpdated fires only when the number actually changed", async () => {
		touch("a.jpg");
		const updates: string[] = [];
		const cache = new MonthSizeCache({ onUpdated: (relPath) => updates.push(relPath) });
		await cache.refresh("216/พ.ค.", root);
		await cache.refresh("216/พ.ค.", root);
		expect(updates).toEqual(["216/พ.ค."]);
		touch("b.jpg");
		await cache.refresh("216/พ.ค.", root);
		expect(updates).toEqual(["216/พ.ค.", "216/พ.ค."]);
	});

	test("a month folder that disappears drops its cached size", async () => {
		touch("a.jpg");
		const cache = new MonthSizeCache();
		expect((await cache.refresh("216/พ.ค.", root))?.units).toBe(1);
		rmSync(root, { recursive: true, force: true });
		expect(await cache.refresh("216/พ.ค.", root)).toBeNull();
		expect(cache.get("216/พ.ค.", root)).toBeNull();
	});
});
