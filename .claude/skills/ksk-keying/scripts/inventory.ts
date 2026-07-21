// Deterministic Inventory census for the Page Ledger (ADR 0001).
//
// Walks a run root — one month folder inside a client folder (see paths.ts) —
// and writes `ข้อมูลระบบ/_pages/inventory.yaml` (schema: ksk_inventory.v1)
// under it — the fixed denominator the Page Ledger validates against. Page counts come from `pdfinfo` and sheet enumeration
// (xlsx lib), never from any agent's count.
//
// Only a closed, code-owned skip-list is skipped (pipeline artifacts and OS
// junk); every other file recurses into files[], unknown extensions as
// kind "other" — surfacing unknown files is the point: they must later be
// Excluded or Reviewed, the tool never judges.
//
// Zip archives are the one mechanical exception: a .zip of receipts (e.g. a
// Grab export) is extracted IN PLACE first — into a sibling folder named after
// the zip, inside the same source folder — so every downstream consumer
// (columbo's segments, the ledger, the review preview) sees real PDF/image
// files instead of an opaque archive. The zip itself then lands in skipped[]
// as "archive_extracted": its content IS the extracted files; censusing both
// would double the denominator.
//
// Page-unit identity (consumed by ledger.ts):
//   PDF page          -> "<path>#p<N>"      (1-based)
//   spreadsheet sheet -> "<path>#s<Sheet>"
//   image/other file  -> "<path>"           (whole file = one unit)
// Paths are run-root-relative, forward slashes, kept as-is (Thai
// filenames and spaces are normal — never mangle).

import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { readFile as readWorkbook } from "xlsx";
import { stringify as yamlStringify } from "yaml";
import { GENERATED_DIRS, pagesDir as machineryPagesDir } from "./paths";

const TOOL_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(TOOL_DIR, "../../../..");

const INVENTORY_SCHEMA = "ksk_inventory.v1";

// Closed, code-owned skip-list — NOTHING else may be skipped. The two Thai
// container folders (ข้อมูลระบบ = machinery, ตรวจทาน = deliverable) are skipped
// at the top level, which also skips everything nested inside them; the legacy
// top-level _segments/_doc_groups/_pages names stay listed for older folders.
const SKIP_DIRS = new Set(GENERATED_DIRS);
// Client-context files normally live at the client root (outside the month run
// root); this skip keeps legacy everything-at-root layouts and eval fixtures
// censusing correctly when they appear at the run root itself.
const SKIP_ROOT_FILES = new Set(["CLIENT.md", "coa.csv", "coa_usage.json"]);
const OS_JUNK = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

const IMAGE_EXTS = new Set([
	".png",
	".jpg",
	".jpeg",
	".heic",
	".webp",
	".tif",
	".tiff",
	".gif",
	".bmp",
]);
const WORKBOOK_EXTS = new Set([".xlsx", ".xls"]);
const ARCHIVE_EXTS = new Set([".zip"]);

type Kind = "pdf" | "image" | "spreadsheet" | "other";

type InventoryFile = {
	path: string;
	kind: Kind;
	page_count: number;
	sheets: string[] | null;
};

type SkippedEntry = {
	path: string;
	reason: "os_junk" | "pipeline_artifact" | "archive_extracted";
};

type Args = {
	clientDir: string;
	json: boolean;
};

function usage(): never {
	console.error(`Usage: bun run inventory -- [options] <client-dir>

Writes <client>/ข้อมูลระบบ/_pages/inventory.yaml (schema: ${INVENTORY_SCHEMA}) — the
deterministic census of every source file and its true Page count.

Options:
  --json    Print machine-readable JSON summary
`);
	process.exit(2);
}

function parseArgs(argv: string[]): Args {
	const args: Args = { clientDir: "", json: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") args.json = true;
		else if (arg === "--help" || arg === "-h") usage();
		else if (arg.startsWith("--")) usage();
		else if (!args.clientDir) args.clientDir = arg;
		else usage();
	}
	if (!args.clientDir) usage();
	return args;
}

function resolveClientDir(input: string) {
	const path = resolve(input);
	if (existsSync(path) && statSync(path).isDirectory()) return path;
	const fromRoot = resolve(PROJECT_ROOT, input);
	if (existsSync(fromRoot) && statSync(fromRoot).isDirectory()) return fromRoot;
	console.error(`not a client directory: ${input}`);
	process.exit(2);
}

function toPosix(path: string) {
	return path.split("\\").join("/");
}

function ensurePdfinfo() {
	if (!commandAvailable("pdfinfo")) {
		console.error(
			"pdfinfo not found — install poppler (brew install poppler; on Windows, install poppler for Windows and add its bin/ to PATH); refusing to guess PDF page counts",
		);
		process.exit(2);
	}
}

// True page count from pdfinfo. Any failure is a loud error (exit 2) — never
// silently skip a file: a wrong denominator would let pages vanish unnoticed.
function pdfPageCount(pdfPath: string): number {
	const result = spawnSync("pdfinfo", [pdfPath], { encoding: "utf8" });
	if (result.status !== 0) {
		console.error(
			`pdfinfo failed on ${pdfPath}: ${(result.stderr || result.stdout || "").trim()}`,
		);
		process.exit(2);
	}
	const line = result.stdout
		.split(/\r?\n/)
		.find((row: string) => row.startsWith("Pages:"));
	const count = line ? Number(line.split(":", 2)[1].trim()) : NaN;
	if (!Number.isInteger(count) || count < 1) {
		console.error(`could not read page count from pdfinfo output for ${pdfPath}`);
		process.exit(2);
	}
	return count;
}

// Sheet names via the xlsx lib (bookSheets: names only, no cell data).
// Failures are loud (exit 2), same rule as pdfinfo.
function workbookSheets(path: string): string[] {
	try {
		const book = readWorkbook(path, { bookSheets: true });
		const sheets = book.SheetNames;
		if (!Array.isArray(sheets) || sheets.length === 0)
			throw new Error("workbook has no sheets");
		return sheets;
	} catch (error) {
		console.error(
			`failed to enumerate sheets of ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(2);
	}
}

function fileKind(path: string): Kind {
	const ext = extname(path).toLowerCase();
	if (ext === ".pdf") return "pdf";
	if (IMAGE_EXTS.has(ext)) return "image";
	if (WORKBOOK_EXTS.has(ext) || ext === ".csv") return "spreadsheet";
	return "other";
}

function isOsJunk(name: string) {
	return OS_JUNK.has(name.toLowerCase()) || name.startsWith("._");
}

function censusFile(clientDir: string, absPath: string): InventoryFile {
	const path = toPosix(relative(clientDir, absPath));
	const kind = fileKind(absPath);
	if (kind === "pdf")
		return { path, kind, page_count: pdfPageCount(absPath), sheets: null };
	if (kind === "spreadsheet" && WORKBOOK_EXTS.has(extname(absPath).toLowerCase())) {
		const sheets = workbookSheets(absPath);
		return { path, kind, page_count: sheets.length, sheets };
	}
	// csv → single-unit spreadsheet; image/other → whole file = one unit.
	return { path, kind, page_count: 1, sheets: null };
}

// --- In-place zip extraction ------------------------------------------------
// Runs before the census walk. Each .zip extracts into a sibling folder named
// after the zip (minus extension) in the SAME source folder — never a pipeline
// dir — so segment/review paths stay inside the client tree. An existing
// sibling folder means "already extracted" (idempotent re-runs); extraction
// junk (__MACOSX, ._*, .DS_Store) is deleted so it never enters the census.
// Failures are loud (exit 2), same rule as pdfinfo: silently keeping the zip
// opaque would let its pages vanish from the denominator.

function extractedDirFor(zipPath: string): string {
	return join(dirname(zipPath), basename(zipPath, extname(zipPath)));
}

function removeExtractionJunk(dir: string) {
	for (const name of readdirSync(dir)) {
		const child = join(dir, name);
		if (statSync(child).isDirectory()) {
			if (name === "__MACOSX") rmSync(child, { recursive: true, force: true });
			else removeExtractionJunk(child);
			continue;
		}
		if (isOsJunk(name)) rmSync(child, { force: true });
	}
}

function commandAvailable(cmd: string): boolean {
	// `which` doesn't exist on native Windows (cmd.exe/PowerShell) — only
	// inside WSL/Git Bash; `where` is the native equivalent there.
	const finder = process.platform === "win32" ? "where" : "which";
	return spawnSync(finder, [cmd], { encoding: "utf8" }).status === 0;
}

type ZipExtractor = {
	name: string;
	extract: (zipPath: string, staging: string) => ReturnType<typeof spawnSync>;
};

// ditto (macOS) handles UTF-8/Thai zip entry names correctly where plain
// unzip mangles legacy encodings — prefer it when present. Elsewhere (Linux,
// where ditto doesn't exist), 7z is the next-best for UTF-8 names; unzip
// -O UTF-8 is the next fallback. Neither ships on native Windows by default
// (unzip isn't bundled, 7z needs a manual install often left off PATH), so
// PowerShell's built-in Expand-Archive is the last resort there — always
// present on Windows 10/11, no extra install, though its legacy-CP437
// handling is less battle-tested than ditto/7z for older Thai-named zips.
// Detected by availability, not process.platform, so e.g. a Linux box with
// ditto shimmed in still uses it, and a macOS box missing ditto still falls
// back cleanly.
let cachedZipExtractor: ZipExtractor | null | undefined;
function findZipExtractor(): ZipExtractor | null {
	if (cachedZipExtractor !== undefined) return cachedZipExtractor;
	if (commandAvailable("ditto")) {
		cachedZipExtractor = {
			name: "ditto",
			extract: (zipPath, staging) =>
				spawnSync("ditto", ["-x", "-k", zipPath, staging], { encoding: "utf8" }),
		};
	} else if (commandAvailable("7z")) {
		cachedZipExtractor = {
			name: "7z",
			extract: (zipPath, staging) =>
				spawnSync("7z", ["x", `-o${staging}`, zipPath], { encoding: "utf8" }),
		};
	} else if (commandAvailable("unzip")) {
		cachedZipExtractor = {
			name: "unzip",
			extract: (zipPath, staging) =>
				spawnSync("unzip", ["-O", "UTF-8", zipPath, "-d", staging], { encoding: "utf8" }),
		};
	} else if (process.platform === "win32" && commandAvailable("powershell")) {
		cachedZipExtractor = {
			name: "powershell Expand-Archive",
			extract: (zipPath, staging) => {
				const escape = (path: string) => path.replace(/'/g, "''");
				return spawnSync(
					"powershell",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						`Expand-Archive -LiteralPath '${escape(zipPath)}' -DestinationPath '${escape(staging)}' -Force`,
					],
					{ encoding: "utf8" },
				);
			},
		};
	} else {
		cachedZipExtractor = null;
	}
	return cachedZipExtractor;
}

function extractZip(zipPath: string, target: string) {
	// Stage into a sibling temp folder, then rename: a crash mid-extract must
	// never leave a half-filled folder a later run would trust as complete.
	const staging = `${target}.extracting`;
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	const extractor = findZipExtractor();
	if (!extractor) {
		rmSync(staging, { recursive: true, force: true });
		console.error(
			`failed to extract ${zipPath}: no zip extractor available (need ditto, 7z, unzip, or PowerShell on Windows)`,
		);
		process.exit(2);
	}
	const result = extractor.extract(zipPath, staging);
	if (result.status !== 0) {
		rmSync(staging, { recursive: true, force: true });
		console.error(
			`failed to extract ${zipPath}: ${(result.stderr || result.stdout || `${extractor.name} not available`).trim()}`,
		);
		process.exit(2);
	}
	removeExtractionJunk(staging);
	if (readdirSync(staging).length === 0) {
		rmSync(staging, { recursive: true, force: true });
		console.error(`zip extracted to nothing (empty or junk-only archive): ${zipPath}`);
		process.exit(2);
	}
	renameSync(staging, target);
}

function extractArchives(clientDir: string, dir: string, extracted: string[]) {
	for (const name of readdirSync(dir).sort()) {
		const child = join(dir, name);
		const st = statSync(child);
		if (st.isDirectory()) {
			if (SKIP_DIRS.has(name)) continue;
			extractArchives(clientDir, child, extracted);
			continue;
		}
		if (!st.isFile() || isOsJunk(name)) continue;
		if (!ARCHIVE_EXTS.has(extname(name).toLowerCase())) continue;
		const target = extractedDirFor(child);
		// An existing sibling folder counts as already extracted — including a
		// pre-existing unrelated folder that happens to share the zip's name;
		// the census will surface its files either way.
		if (existsSync(target)) continue;
		extractZip(child, target);
		extracted.push(toPosix(relative(clientDir, target)));
		// The freshly created folder isn't in this loop's readdir snapshot —
		// recurse explicitly so nested zips extract too.
		extractArchives(clientDir, target, extracted);
	}
}

function walk(
	clientDir: string,
	dir: string,
	files: InventoryFile[],
	skipped: SkippedEntry[],
) {
	for (const name of readdirSync(dir).sort()) {
		const child = join(dir, name);
		const rel = toPosix(relative(clientDir, child));
		const st = statSync(child);
		if (st.isDirectory()) {
			if (SKIP_DIRS.has(name)) {
				skipped.push({ path: `${rel}/`, reason: "pipeline_artifact" });
				continue;
			}
			walk(clientDir, child, files, skipped);
			continue;
		}
		if (!st.isFile()) continue;
		if (isOsJunk(name)) {
			skipped.push({ path: rel, reason: "os_junk" });
			continue;
		}
		if (dir === clientDir && SKIP_ROOT_FILES.has(name)) {
			skipped.push({ path: rel, reason: "pipeline_artifact" });
			continue;
		}
		// A zip whose extracted sibling folder exists is a container, not a
		// page: its files were censused from the folder. A zip WITHOUT the
		// folder (extraction pre-pass didn't run/apply) still falls through to
		// censusFile as kind "other" so it can never silently vanish.
		if (
			ARCHIVE_EXTS.has(extname(name).toLowerCase()) &&
			existsSync(extractedDirFor(child)) &&
			statSync(extractedDirFor(child)).isDirectory()
		) {
			skipped.push({ path: rel, reason: "archive_extracted" });
			continue;
		}
		files.push(censusFile(clientDir, child));
	}
}

function main() {
	const args = parseArgs(Bun.argv.slice(2));
	const clientDir = resolveClientDir(args.clientDir);
	ensurePdfinfo();

	const files: InventoryFile[] = [];
	const skipped: SkippedEntry[] = [];
	const extracted: string[] = [];
	extractArchives(clientDir, clientDir, extracted);
	walk(clientDir, clientDir, files, skipped);

	const inventory = { schema: INVENTORY_SCHEMA, files, skipped };
	const pagesDir = machineryPagesDir(clientDir);
	mkdirSync(pagesDir, { recursive: true });
	const out = join(pagesDir, "inventory.yaml");
	writeFileSync(out, yamlStringify(inventory));

	const unitCount = files.reduce((n, f) => n + f.page_count, 0);
	const summary = {
		ok: true,
		client_dir: clientDir,
		inventory: out,
		files: files.length,
		units: unitCount,
		skipped: skipped.length,
		extracted_archives: extracted,
	};
	if (args.json) {
		console.log(JSON.stringify(summary, null, 2));
		return;
	}
	console.log(`Inventory — ${basename(clientDir)}`);
	console.log(`  files:   ${files.length}`);
	console.log(`  units:   ${unitCount} (Pages: PDF pages + sheets + single-unit files)`);
	console.log(`  skipped: ${skipped.length} (closed skip-list only)`);
	for (const dir of extracted) console.log(`  [extracted] ${dir}/`);
	for (const file of files) {
		const detail =
			file.sheets != null
				? `${file.page_count} sheet(s): ${file.sheets.join(", ")}`
				: `${file.page_count} unit(s)`;
		console.log(`  [${file.kind}] ${file.path} — ${detail}`);
	}
	for (const entry of skipped)
		console.log(`  [skipped:${entry.reason}] ${entry.path}`);
	console.log(`wrote ${out}`);
}

main();
