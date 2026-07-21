import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

const SCRIPT = join(import.meta.dir, "..", "inventory.ts");

const tmps: string[] = [];
function tempRunRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "ksk-inventory-"));
	tmps.push(dir);
	return dir;
}
afterAll(() => {
	for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

// Minimal but well-formed 1-page PDF; pdfinfo reads "Pages: 1" from it. The
// census refuses to guess page counts, so the fixture must satisfy pdfinfo.
const MINI_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>
endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer
<< /Size 4 /Root 1 0 R >>
startxref
187
%%EOF
`;

function commandAvailable(cmd: string): boolean {
	return spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;
}

const HAS_DITTO = commandAvailable("ditto");
const HAS_7Z = commandAvailable("7z");
// Whether this machine can build the fixture zip at all — checked once so the
// suite can skip cleanly (rather than fail) on a box with neither tool.
const HAS_ZIP_CREATOR = HAS_DITTO || HAS_7Z;

// Same shape of tool the census uses to extract, driven in reverse to build
// the fixture zip. Prefers ditto (macOS: -c -k = create a PKZip archive of
// the folder's contents), falls back to 7z on Linux where ditto doesn't
// exist — mirrors inventory.ts's own extractor fallback so this fixture
// helper stays portable across dev machines.
function zipInPlace(srcDir: string, zipPath: string) {
	if (HAS_DITTO) {
		const result = spawnSync("ditto", ["-c", "-k", srcDir, zipPath], {
			encoding: "utf8",
		});
		if (result.status !== 0)
			throw new Error(`ditto zip failed: ${result.stderr || result.stdout}`);
		return;
	}
	if (HAS_7Z) {
		// 7z's "a" archives the given path itself, not just its contents; feed
		// it the contents (srcDir/*) so the zip layout matches ditto's -c -k.
		const result = spawnSync("7z", ["a", "-tzip", zipPath, join(srcDir, "*")], {
			encoding: "utf8",
		});
		if (result.status !== 0)
			throw new Error(`7z zip failed: ${result.stderr || result.stdout}`);
		return;
	}
	throw new Error("no zip creator available (need ditto or 7z)");
}

function runInventory(runRoot: string) {
	return spawnSync("bun", [SCRIPT, "--json", runRoot], { encoding: "utf8" });
}

function readInventory(runRoot: string) {
	const path = join(runRoot, "ข้อมูลระบบ", "_pages", "inventory.yaml");
	return yamlParse(readFileSync(path, "utf8")) as {
		files: { path: string; kind: string; page_count: number }[];
		skipped: { path: string; reason: string }[];
	};
}

// A zip of receipts (e.g. a Grab export) must become real files in the census:
// extracted in place into a sibling folder, censused as PDFs, with the zip
// itself skipped as archive_extracted — so segments/ledger/review all see real
// documents and the denominator counts the content exactly once.
describe.skipIf(!HAS_ZIP_CREATOR)("inventory zip extraction", () => {
	test("extracts a zip in place, censuses its PDFs, skips the zip", () => {
		const runRoot = tempRunRoot();
		const folder = join(runRoot, "ค่าใช้จ่าย vat");
		mkdirSync(folder, { recursive: true });

		// Build the zip from a staging dir outside the run root, including the
		// junk a real macOS/Grab zip carries.
		const staging = mkdtempSync(join(tmpdir(), "ksk-zip-src-"));
		tmps.push(staging);
		writeFileSync(join(staging, "receipt-a.pdf"), MINI_PDF);
		writeFileSync(join(staging, "receipt-b.pdf"), MINI_PDF);
		writeFileSync(join(staging, ".DS_Store"), "junk");
		mkdirSync(join(staging, "__MACOSX"));
		writeFileSync(join(staging, "__MACOSX", "._receipt-a.pdf"), "junk");
		zipInPlace(staging, join(folder, "ค่าใช้จ่าย Grab 05-69.zip"));

		const run = runInventory(runRoot);
		expect(run.status).toBe(0);

		// Extraction landed next to the zip, inside the same source folder.
		const extractedDir = join(folder, "ค่าใช้จ่าย Grab 05-69");
		expect(existsSync(join(extractedDir, "receipt-a.pdf"))).toBe(true);
		expect(existsSync(join(extractedDir, "__MACOSX"))).toBe(false);
		expect(existsSync(join(extractedDir, ".DS_Store"))).toBe(false);

		const inventory = readInventory(runRoot);
		const paths = inventory.files.map((f) => f.path).sort();
		expect(paths).toEqual([
			"ค่าใช้จ่าย vat/ค่าใช้จ่าย Grab 05-69/receipt-a.pdf",
			"ค่าใช้จ่าย vat/ค่าใช้จ่าย Grab 05-69/receipt-b.pdf",
		]);
		for (const file of inventory.files) {
			expect(file.kind).toBe("pdf");
			expect(file.page_count).toBe(1);
		}
		expect(inventory.skipped).toContainEqual({
			path: "ค่าใช้จ่าย vat/ค่าใช้จ่าย Grab 05-69.zip",
			reason: "archive_extracted",
		});
	});

	test("re-running is idempotent — no re-extract, same census", () => {
		const runRoot = tempRunRoot();
		const folder = join(runRoot, "เอกสาร");
		mkdirSync(folder, { recursive: true });
		const staging = mkdtempSync(join(tmpdir(), "ksk-zip-src-"));
		tmps.push(staging);
		writeFileSync(join(staging, "doc.pdf"), MINI_PDF);
		zipInPlace(staging, join(folder, "docs.zip"));

		expect(runInventory(runRoot).status).toBe(0);
		const first = readInventory(runRoot);
		// Reviewer may annotate extracted files between runs; a re-run must not
		// clobber the extracted folder.
		const marker = join(folder, "docs", "reviewer-note.txt");
		writeFileSync(marker, "keep me");
		expect(runInventory(runRoot).status).toBe(0);
		expect(readFileSync(marker, "utf8")).toBe("keep me");
		const second = readInventory(runRoot);
		expect(second.files.map((f) => f.path)).toContain("เอกสาร/docs/doc.pdf");
		expect(first.files.map((f) => f.path)).toContain("เอกสาร/docs/doc.pdf");
	});

	test("nested zip inside a zip extracts too", () => {
		const runRoot = tempRunRoot();
		const folder = join(runRoot, "เอกสาร");
		mkdirSync(folder, { recursive: true });

		const inner = mkdtempSync(join(tmpdir(), "ksk-zip-inner-"));
		tmps.push(inner);
		writeFileSync(join(inner, "inner.pdf"), MINI_PDF);
		const outer = mkdtempSync(join(tmpdir(), "ksk-zip-outer-"));
		tmps.push(outer);
		writeFileSync(join(outer, "outer.pdf"), MINI_PDF);
		zipInPlace(inner, join(outer, "inner.zip"));
		zipInPlace(outer, join(folder, "outer.zip"));

		expect(runInventory(runRoot).status).toBe(0);
		const inventory = readInventory(runRoot);
		const paths = inventory.files.map((f) => f.path).sort();
		expect(paths).toEqual([
			"เอกสาร/outer/inner/inner.pdf",
			"เอกสาร/outer/outer.pdf",
		]);
		const skippedPaths = inventory.skipped.map((s) => s.path).sort();
		expect(skippedPaths).toEqual(["เอกสาร/outer.zip", "เอกสาร/outer/inner.zip"]);
	});

	test("zips inside pipeline dirs are left alone", () => {
		const runRoot = tempRunRoot();
		const sysDir = join(runRoot, "ข้อมูลระบบ", "_pages");
		mkdirSync(sysDir, { recursive: true });
		const staging = mkdtempSync(join(tmpdir(), "ksk-zip-src-"));
		tmps.push(staging);
		writeFileSync(join(staging, "doc.pdf"), MINI_PDF);
		zipInPlace(staging, join(sysDir, "artifact.zip"));
		writeFileSync(join(runRoot, "doc.pdf"), MINI_PDF);
		expect(runInventory(runRoot).status).toBe(0);
		expect(existsSync(join(sysDir, "artifact"))).toBe(false);
	});
});
