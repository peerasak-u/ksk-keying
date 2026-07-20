// Review-page generator for the ksk-keying workflow: reads the machinery under
// ข้อมูลระบบ/_doc_groups/ and writes the human, all-Thai deliverable tree under
// ตรวจทาน/ (see paths.ts).
//
// Reads from the machinery container:
//   ข้อมูลระบบ/_doc_groups/
//     expense/vat/<group-id>/review-data.json
//     expense/non_vat/<group-id>/review-data.json
//     expense/mixed/<group-id>/review-data.json
//     income/vat/<group-id>/review-data.json
//     income/non_vat/<group-id>/review-data.json
//     bank_statement/<group-id>/review-data.json
//
// review-data.json schema for document buckets (ksk_review_group_data.v1):
//   { schema, group_id, label, pages: ReviewPage[] }
// where each page's image_src is relative to the CLIENT root.
//
// The bank_statement bucket instead expects ksk_review_statement_data.v1:
//   { schema, group_id, label, statement, source, rows: StatementRow[] }
// (PRD docs/improve-bank-stm-review/PRD.md §D1). A statement-schema file in a
// document bucket (or a document-schema file in bank_statement) is a hard
// error naming the offending file (see loadGroupReviewData).
//
// For every bucket that has at least one group, this writes a single
// self-contained HTML file (vendored JS inlined, no assets/ folder) into the
// Thai deliverable tree — e.g. bucket expense/vat ->
//   ตรวจทาน/ค่าใช้จ่าย/มีภาษี/ตรวจทาน.html
// The reviewer opens that one file via file:// and exports the PEAK XLSX
// (downloaded as "นำเข้า PEAK - <หมวด ภาษี>.xlsx") from it. source_src/image_src
// are rewritten relative to the page's location in the ตรวจทาน/ tree.

import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { parse as yamlParse } from "yaml";
import { readFile as readWorkbook, utils as xlsxUtils, type WorkBook } from "xlsx";
import {
	compareReviewPagesBySource,
	hashString,
	inlineVendorScripts,
	loadCoaRows,
	renderReviewHtml,
	type ReviewData,
	type ReviewHtmlData,
	type ReviewPage,
	type SheetPreview,
	type StatementEmbedded,
	type StatementGroupData,
	type StatementHtmlData,
	type StatementSource,
} from "./review-template";
import {
	renderReviewExcludedHtml,
	renderReviewIndexHtml,
	type ReviewExcludedData,
	type ReviewExcludedItem,
	type ReviewIndexData,
} from "./review-index-template";
import {
	REVIEW_DIR,
	REVIEW_EXCLUDED_HTML_NAME,
	REVIEW_HTML_NAME,
	REVIEW_INDEX_HTML_NAME,
	docGroupsDir as machineryDocGroupsDir,
	pagesDir as machineryPagesDir,
	resolveContextFile,
	reviewBucketLabel,
	reviewBucketSegments,
	segmentsDir,
} from "./paths";

const TOOL_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(TOOL_DIR, "../../../..");
const REVIEW_DATA_FILE = "review-data.json";

const BUCKETS = [
	"expense/vat",
	"expense/non_vat",
	"expense/mixed",
	"income/vat",
	"income/non_vat",
	"bank_statement",
] as const;

type Bucket = (typeof BUCKETS)[number];

type Args = {
	clientDir: string;
	coaCsvPath?: string;
	force: boolean;
	skipMissing: boolean;
};

type ClientContext = {
	business_name?: string;
	coa_csv?: string;
};

type GroupReviewData = {
	schema: "ksk_review_group_data.v1";
	group_id: string;
	label?: string;
	review_flags?: unknown[];
	pages: ReviewPage[];
};

// Discriminant for which review-data.json shape a bucket's group folders must
// carry: bank_statement is the only "statement" bucket, everything else is
// "documents" (PRD §D2).
type BucketKind = "documents" | "statement";

function bucketKind(bucket: Bucket): BucketKind {
	return bucket === "bank_statement" ? "statement" : "documents";
}

function usage(): never {
	console.error(`Usage: bun run review-groups -- [options] <client-dir>

Reads ข้อมูลระบบ/_doc_groups/<bucket>/ and generates one self-contained
ตรวจทาน/<หมวด>/<ภาษี>/ตรวจทาน.html per bucket
(expense/vat, expense/non_vat, expense/mixed, income/vat, income/non_vat, bank_statement).

Options:
  --coa-csv PATH  Explicit COA CSV path (default: {client}/coa.csv)
  --force         Overwrite existing review.html
  --skip-missing  Skip group folders without ${REVIEW_DATA_FILE} instead of failing
`);
	process.exit(2);
}

function parseArgs(argv: string[]): Args {
	const args: Args = { clientDir: "", force: false, skipMissing: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--coa-csv") {
			args.coaCsvPath = argv[++i];
			continue;
		}
		if (arg === "--force") {
			args.force = true;
			continue;
		}
		if (arg === "--skip-missing") {
			args.skipMissing = true;
			continue;
		}
		if (arg === "--help" || arg === "-h" || arg.startsWith("--")) usage();
		if (args.clientDir) usage();
		args.clientDir = arg;
	}
	if (!args.clientDir) usage();
	return args;
}

function resolveInput(input: string) {
	const path = resolve(input);
	if (existsSync(path)) return path;
	const fromRoot = resolve(PROJECT_ROOT, input);
	if (existsSync(fromRoot)) return fromRoot;
	return path;
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function toPosix(path: string) {
	return path.split("\\").join("/");
}

function isDir(path: string) {
	return existsSync(path) && statSync(path).isDirectory();
}

function resolveClientDir(input: string) {
	const clientDir = resolveInput(input);
	if (!isDir(clientDir))
		throw new Error(`not a client directory: ${clientDir}`);
	return clientDir;
}

function resolveCoaCsv(args: Args, clientDir: string) {
	if (args.coaCsvPath) return resolveInput(args.coaCsvPath);
	const clientPath = join(clientDir, "client.json");
	const client = existsSync(clientPath)
		? readJson<ClientContext>(clientPath)
		: ({} as ClientContext);
	if (client.coa_csv) return resolve(clientDir, client.coa_csv);
	// coa.csv is client-level context: run root first, then the parent client
	// root. Fall back to the run-root path so the missing-file error names it.
	return resolveContextFile(clientDir, "coa.csv") ?? resolve(clientDir, "coa.csv");
}

function groupFolders(bucketDir: string) {
	return readdirSync(bucketDir)
		.filter((name) => name !== "assets" && !name.startsWith("."))
		.map((name) => join(bucketDir, name))
		.filter((path) => statSync(path).isDirectory())
		.sort();
}

function loadDocumentGroupData(path: string): GroupReviewData {
	const data = readJson<GroupReviewData>(path);
	if (data.schema !== "ksk_review_group_data.v1")
		throw new Error(
			`unexpected schema "${data.schema}" in document bucket (expected ksk_review_group_data.v1): ${path}`,
		);
	if (!Array.isArray(data.pages))
		throw new Error(`missing pages array: ${path}`);
	return data;
}

function loadStatementGroupData(path: string): StatementGroupData {
	const data = readJson<StatementGroupData>(path);
	if (data.schema !== "ksk_review_statement_data.v1")
		throw new Error(
			`unexpected schema "${data.schema}" in bank_statement bucket (expected ksk_review_statement_data.v1): ${path}`,
		);
	if (!data.statement || typeof data.statement !== "object")
		throw new Error(`missing statement object: ${path}`);
	if (!data.source || typeof data.source !== "object")
		throw new Error(`missing source object: ${path}`);
	if (!Array.isArray(data.rows))
		throw new Error(`missing rows array: ${path}`);
	return data;
}

// Dispatch on the bucket's expected schema (PRD §D2): a statement-schema file
// in a document bucket, or vice versa, is a hard error naming the file (the
// per-schema checks live in loadStatementGroupData/loadDocumentGroupData
// above). Overloaded so callers narrowed to a literal BucketKind get back the
// matching concrete type instead of the union.
function loadGroupReviewData(path: string, kind: "statement"): StatementGroupData;
function loadGroupReviewData(path: string, kind: "documents"): GroupReviewData;
function loadGroupReviewData(
	path: string,
	kind: BucketKind,
): GroupReviewData | StatementGroupData {
	return kind === "statement"
		? loadStatementGroupData(path)
		: loadDocumentGroupData(path);
}

// review-data.json stores image_src relative to the client root; the page is
// served from the bucket dir, so rewrite each src relative to the bucket.
function rewriteImageSrc(
	src: string | null,
	clientDir: string,
	bucketDir: string,
) {
	if (!src) return null;
	const absolute = resolve(clientDir, src);
	if (!existsSync(absolute)) return null;
	return toPosix(relative(bucketDir, absolute));
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

// Map each segment id to its source file path (client-root-relative) by reading
// _segments/manifest.yaml. Used to recover the source document for bare
// `seg-XXX/page-NNN` refs that dropped the filename.
function loadSegmentSources(clientDir: string): Map<string, string> {
	const map = new Map<string, string>();
	const manifestPath = join(segmentsDir(clientDir), "manifest.yaml");
	if (!existsSync(manifestPath)) return map;
	let currentPath = "";
	for (const line of readFileSync(manifestPath, "utf8").split(/\r?\n/)) {
		const pathMatch = line.match(/^\s*-\s*path:\s*"?(.+?)"?\s*$/);
		if (pathMatch) {
			currentPath = pathMatch[1];
			continue;
		}
		const idMatch = line.match(/^\s*-\s*id:\s*"?(seg-[^"\s]+)"?/);
		if (idMatch && currentPath) map.set(idMatch[1], currentPath);
	}
	return map;
}

function sourceKind(path: string): "pdf" | "image" | "other" {
	const ext = extname(path).toLowerCase();
	if (ext === ".pdf") return "pdf";
	if (IMAGE_EXTS.has(ext)) return "image";
	return "other";
}

// --- Spreadsheet source preview -------------------------------------------
// file:// pages cannot fetch() the workbook sitting next to them, so the
// referenced sheet is read here at generation time and embedded into the page
// payload as a bounded table (SheetPreview in review-template.ts).

const SHEET_EXTS = new Set([".xlsx", ".xls"]);
const SHEET_MAX_ROWS = 500;
const SHEET_MAX_COLS = 40;

const workbookCache = new Map<string, WorkBook | null>();

function loadWorkbookCached(absPath: string): WorkBook | null {
	let workbook = workbookCache.get(absPath);
	if (workbook === undefined) {
		try {
			workbook = readWorkbook(absPath);
		} catch (error) {
			console.error(
				`warning: cannot read workbook for sheet preview: ${absPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
			workbook = null;
		}
		workbookCache.set(absPath, workbook);
	}
	return workbook;
}

function buildSheetPreview(
	absPath: string,
	sheetName: string | null | undefined,
): SheetPreview | null {
	if (!SHEET_EXTS.has(extname(absPath).toLowerCase())) return null;
	const workbook = loadWorkbookCached(absPath);
	if (!workbook) return null;
	const name =
		sheetName && workbook.SheetNames.includes(sheetName)
			? sheetName
			: workbook.SheetNames[0];
	const sheet = name ? workbook.Sheets[name] : undefined;
	if (!sheet) return null;
	// raw:false keeps the formatted display text (dates, thousand separators)
	// instead of raw serial numbers.
	const all = xlsxUtils.sheet_to_json(sheet, {
		header: 1,
		raw: false,
		defval: null,
	}) as (string | number | null)[][];
	while (all.length && all[all.length - 1].every((cell) => cell == null))
		all.pop();
	if (!all.length) return null;
	let truncated = all.length > SHEET_MAX_ROWS;
	const rows = all.slice(0, SHEET_MAX_ROWS).map((row) => {
		if (row.length > SHEET_MAX_COLS) truncated = true;
		return row.slice(0, SHEET_MAX_COLS);
	});
	return { sheet: name, rows, total_rows: all.length, truncated };
}

// Resolve the real source document to preview for a page. Prefers the explicit
// source_src field (client-root-relative); falls back to deriving it from the
// page ref (dropping any leading `seg-XXX/` prefix) so older review-data.json
// files still get a live preview. Returns bucket-relative paths.
function resolveSource(
	page: ReviewPage,
	clientDir: string,
	bucketDir: string,
	segmentSources: Map<string, string>,
): {
	source_src: string | null;
	source_page: number | null;
	source_kind: "pdf" | "image" | "other" | null;
	sheet_preview: SheetPreview | null;
} {
	let raw = page.source_src ?? null;
	let derivedPage: number | null = null;
	// A bare `seg-XXX/page-NNN` ref keeps no filename — recover it from the
	// segment manifest and read the page number off the trailing marker.
	if (!raw && page.ref) {
		const segMatch = page.ref.match(/^(seg[^/]*)\/(.+)$/);
		const segFile = segMatch ? segmentSources.get(segMatch[1]) : undefined;
		if (segFile && existsSync(resolve(clientDir, segFile))) {
			raw = segFile;
			const pageMatch = segMatch![2].match(/(\d+)/);
			if (pageMatch) derivedPage = Number(pageMatch[1]);
		}
	}
	if (!raw && page.ref) {
		// Fallback for review-data.json without an explicit source_src: refs are
		// shaped like `seg-001/<file>`, `<file>.pdf/p.5,6,9`, `<file>.pdf/page-001`,
		// or `<file>.pdf#page=45-47`. Strip any leading segment prefix, then anchor
		// on the file extension: everything up to it is the real file, and the first
		// number in the trailing marker is the page to open to.
		const rest = page.ref.replace(/^seg[^/]*\//, "");
		const fileMatch = rest.match(/^(.*?\.(?:pdf|png|jpe?g|webp|gif))(.*)$/i);
		const candidate = fileMatch ? fileMatch[1] : rest;
		if (fileMatch) {
			const pageMatch = fileMatch[2].match(/(\d+)/);
			if (pageMatch) derivedPage = Number(pageMatch[1]);
		}
		if (candidate && existsSync(resolve(clientDir, candidate))) raw = candidate;
	}
	if (!raw)
		return { source_src: null, source_page: null, source_kind: null, sheet_preview: null };
	const absolute = resolve(clientDir, raw);
	if (!existsSync(absolute))
		return { source_src: null, source_page: null, source_kind: null, sheet_preview: null };
	const kind = sourceKind(raw);
	return {
		source_src: toPosix(relative(bucketDir, absolute)),
		source_page: page.source_page ?? derivedPage,
		source_kind: kind,
		sheet_preview:
			kind === "other" ? buildSheetPreview(absolute, page.source_sheet) : null,
	};
}

// Statement source_src is always explicit (no page-ref derivation like
// resolveSource's document fallback — statement groups don't have per-page
// refs), so this only needs the existence check + bucket-relative rewrite,
// same convention as resolveSource/rewriteImageSrc above.
function resolveStatementSource(
	source: StatementSource,
	clientDir: string,
	bucketDir: string,
): StatementSource {
	const image_src = rewriteImageSrc(source.image_src, clientDir, bucketDir);
	let source_src: string | null = null;
	let sheet_preview: SheetPreview | null = null;
	if (source.source_src) {
		const absolute = resolve(clientDir, source.source_src);
		if (existsSync(absolute)) {
			source_src = toPosix(relative(bucketDir, absolute));
			if (sourceKind(source.source_src) === "other")
				sheet_preview = buildSheetPreview(absolute, source.source_sheet);
		}
	}
	return {
		source_src,
		source_page: source_src ? source.source_page : null,
		image_src,
		sheet_preview,
	};
}

// --- ตรวจทาน/index.html + ตรวจทาน/ที่ถูกตัดออก.html -------------------------
// Sourced from ข้อมูลระบบ/_pages/ledger.yaml (ledger.ts) — the same
// gate-independent derivation the Ledger Gates use, never a fresh read of
// dispositions.yaml here (one source of truth for exclusion counts).

type LedgerSnapshot = {
	schema?: string;
	counts?: {
		units?: number;
		excluded_agent?: number;
		excluded_human?: number;
	};
	agent_declared_exclusions?: {
		unit: string;
		reason: string | null;
		duplicate_of?: string | null;
		declared_by: string;
	}[];
};

function loadLedgerSnapshot(clientDir: string): LedgerSnapshot | null {
	const path = join(machineryPagesDir(clientDir), "ledger.yaml");
	if (!existsSync(path)) return null;
	try {
		return yamlParse(readFileSync(path, "utf8")) as LedgerSnapshot;
	} catch (error) {
		console.error(
			`warning: cannot parse ${path} for the review index (skipping coverage/exclusion sections): ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

// Mirrors ledger.ts's own unitId/parseUnitId (not exported from there —
// small enough to duplicate rather than reshape ledger.ts into a shared lib).
function parseLedgerUnitId(id: string): { file: string; page: number | null; sheet: string | null } {
	const pageMatch = id.match(/^(.*)#p(\d+)$/);
	if (pageMatch) return { file: pageMatch[1], page: Number(pageMatch[2]), sheet: null };
	const sheetMatch = id.match(/^(.*)#s(.+)$/);
	if (sheetMatch) return { file: sheetMatch[1], page: null, sheet: sheetMatch[2] };
	return { file: id, page: null, sheet: null };
}

// Same convention as resolveSource/resolveStatementSource above, but for a
// raw Inventory unit (file+page|sheet straight off the ledger, never a
// review-data.json page) — there is no ref-derivation to do, the unit id
// already names the exact file and page/sheet.
function resolveExcludedSource(
	file: string,
	page: number | null,
	sheet: string | null,
	clientDir: string,
	outDir: string,
): {
	source_src: string | null;
	source_page: number | null;
	source_kind: "pdf" | "image" | "other" | null;
	sheet_preview: SheetPreview | null;
} {
	const absolute = resolve(clientDir, file);
	if (!existsSync(absolute))
		return { source_src: null, source_page: null, source_kind: null, sheet_preview: null };
	const kind = sourceKind(file);
	return {
		source_src: toPosix(relative(outDir, absolute)),
		source_page: page,
		source_kind: kind,
		sheet_preview: kind === "other" ? buildSheetPreview(absolute, sheet) : null,
	};
}

function bucketStatements(
	clientDir: string,
	bucketDir: string,
	groups: { dir: string; data: StatementGroupData }[],
): StatementEmbedded[] {
	return groups.map(({ dir, data }) => ({
		group_id: data.group_id || basename(dir),
		label: data.label,
		statement: data.statement,
		source: resolveStatementSource(data.source, clientDir, bucketDir),
		rows: data.rows,
	}));
}

function bucketPages(
	clientDir: string,
	bucketDir: string,
	groups: { dir: string; data: GroupReviewData }[],
	segmentSources: Map<string, string>,
): ReviewPage[] {
	const pages: ReviewPage[] = [];
	for (const { dir, data } of groups) {
		const groupId = data.group_id || basename(dir);
		const groupReviewFlags = (data.review_flags ?? []).map(String);
		for (const page of data.pages) {
			const source = resolveSource(page, clientDir, bucketDir, segmentSources);
			pages.push({
				...page,
				ref: `${groupId}/${page.ref}`,
				short_ref: page.short_ref || basename(page.ref),
				image_src: rewriteImageSrc(page.image_src, clientDir, bucketDir),
				source_src: source.source_src,
				source_page: source.source_page,
				source_kind: source.source_kind,
				sheet_preview: source.sheet_preview,
				group_id: groupId,
				group_label: data.label || page.group_label,
				group_review_flags: groupReviewFlags,
			});
		}
	}
	// Review order = reading order of the source documents (file, then page),
	// not group-id order: group ids derive from document numbers, which made the
	// preview hop between PDFs and jump pages within one PDF.
	return pages.sort(compareReviewPagesBySource);
}

// Resolve each group folder's review-data.json path, honoring --skip-missing.
// Schema validation (and the hard-error-on-mismatch) happens in the caller via
// loadDocumentGroupData/loadStatementGroupData, once the bucket's expected
// kind is known.
function collectGroupDataPaths(
	folders: string[],
	clientDir: string,
	skipMissing: boolean,
	skipped: string[],
): { dir: string; dataPath: string }[] {
	const found: { dir: string; dataPath: string }[] = [];
	for (const dir of folders) {
		const dataPath = join(dir, REVIEW_DATA_FILE);
		if (!existsSync(dataPath)) {
			if (!skipMissing)
				throw new Error(
					`missing ${REVIEW_DATA_FILE}: ${dataPath}\n(write it from the group's interpretation + categorize artifacts, or pass --skip-missing)`,
				);
			skipped.push(toPosix(relative(clientDir, dir)));
			continue;
		}
		found.push({ dir, dataPath });
	}
	return found;
}

function main() {
	const args = parseArgs(Bun.argv.slice(2));
	const clientDir = resolveClientDir(args.clientDir);
	const docGroupsRoot = machineryDocGroupsDir(clientDir);
	if (!isDir(docGroupsRoot))
		throw new Error(`missing ${relative(clientDir, docGroupsRoot)} under ${clientDir}`);
	const coaCsvPath = resolveCoaCsv(args, clientDir);
	if (!existsSync(coaCsvPath))
		throw new Error(`missing COA CSV: ${coaCsvPath}`);
	const coaRows = loadCoaRows(coaCsvPath);
	const segmentSources = loadSegmentSources(clientDir);
	// Vendored libs inlined once and shared across every bucket's page, so each
	// generated ตรวจทาน.html is a single self-contained file (no assets/ folder).
	const scripts = inlineVendorScripts();

	const outputs: {
		bucket: Bucket;
		review_html: string;
		groups: number;
		pages: number;
	}[] = [];
	const skipped: string[] = [];

	for (const bucket of BUCKETS) {
		const inBucketDir = join(docGroupsRoot, ...bucket.split("/"));
		if (!isDir(inBucketDir)) continue;
		const folders = groupFolders(inBucketDir);
		if (!folders.length) continue;

		const kind = bucketKind(bucket);
		const found = collectGroupDataPaths(
			folders,
			clientDir,
			args.skipMissing,
			skipped,
		);
		if (!found.length) continue;

		// The page is written into the Thai deliverable tree, not next to its
		// source data — so every relative source_src/image_src must be computed
		// from outDir (where the .html lives), not the machinery bucket dir.
		const outDir = join(clientDir, REVIEW_DIR, ...reviewBucketSegments(bucket));
		const out = join(outDir, REVIEW_HTML_NAME);
		if (existsSync(out) && !args.force)
			throw new Error(`exists: ${out} (pass --force)`);
		const reviewLabel = reviewBucketLabel(bucket);

		let data: ReviewHtmlData;
		let groupCount: number;
		let itemCount: number;

		if (kind === "statement") {
			const groups = found.map(({ dir, dataPath }) => ({
				dir,
				data: loadGroupReviewData(dataPath, kind),
			}));
			const statements = bucketStatements(clientDir, outDir, groups);
			const payload = { group: bucket, statements, coa: coaRows };
			data = {
				schema: "ksk_review_statement_html_data.v1",
				kind: "statement",
				client_dir: clientDir,
				client_key: basename(clientDir),
				group: bucket,
				group_dir: outDir,
				review_label: reviewLabel,
				generated_at: new Date().toISOString(),
				content_fingerprint: hashString(JSON.stringify(payload)),
				coa_csv: coaCsvPath,
				coa_rows: coaRows,
				statements,
			};
			groupCount = groups.length;
			itemCount = statements.reduce((n, s) => n + s.rows.length, 0);
		} else {
			const groups = found.map(({ dir, dataPath }) => ({
				dir,
				data: loadGroupReviewData(dataPath, kind),
			}));
			const pages = bucketPages(clientDir, outDir, groups, segmentSources);
			const payload = { group: bucket, pages, coa: coaRows };
			data = {
				schema: "ksk_review_group_html_data.v1",
				kind: "documents",
				client_dir: clientDir,
				client_key: basename(clientDir),
				group: bucket,
				group_dir: outDir,
				review_label: reviewLabel,
				generated_at: new Date().toISOString(),
				content_fingerprint: hashString(JSON.stringify(payload)),
				coa_csv: coaCsvPath,
				coa_rows: coaRows,
				pages,
			};
			groupCount = groups.length;
			itemCount = pages.length;
		}

		mkdirSync(outDir, { recursive: true });
		writeFileSync(out, renderReviewHtml(data, scripts));
		outputs.push({
			bucket,
			review_html: out,
			groups: groupCount,
			pages: itemCount,
		});
	}

	if (!outputs.length)
		throw new Error(
			`no bucket with review-data.json found under ${docGroupsRoot}\nexpected e.g. ${machineryDocGroupsDir(".")}/expense/vat/<group-id>/${REVIEW_DATA_FILE}`,
		);

	// Navigation pages — recomputed every run, same as every ตรวจทาน.html
	// above (never hand-edited, no exists-guard needed).
	const reviewRoot = join(clientDir, REVIEW_DIR);
	const ledger = loadLedgerSnapshot(clientDir);
	const agentExclusions = ledger?.agent_declared_exclusions ?? [];

	let excludedHref: string | null = null;
	if (agentExclusions.length) {
		const items: ReviewExcludedItem[] = agentExclusions.map((entry) => {
			const { file, page, sheet } = parseLedgerUnitId(entry.unit);
			const source = resolveExcludedSource(file, page, sheet, clientDir, reviewRoot);
			let duplicateOf: ReviewExcludedItem["duplicate_of"] = null;
			if (entry.duplicate_of) {
				const orig = parseLedgerUnitId(entry.duplicate_of);
				const origSource = resolveExcludedSource(
					orig.file,
					orig.page,
					orig.sheet,
					clientDir,
					reviewRoot,
				);
				duplicateOf = {
					file: orig.file,
					page: orig.page,
					sheet: orig.sheet,
					href: origSource.source_src
						? origSource.source_src +
							(origSource.source_page ? `#page=${origSource.source_page}` : "")
						: null,
					source_src: origSource.source_src,
					source_page: origSource.source_page,
					source_kind: origSource.source_kind,
					sheet_preview: origSource.sheet_preview,
				};
			}
			return {
				unit: entry.unit,
				file,
				page,
				sheet,
				reason: entry.reason,
				duplicate_of: duplicateOf,
				source_src: source.source_src,
				source_page: source.source_page,
				source_kind: source.source_kind,
				sheet_preview: source.sheet_preview,
			};
		});
		const excludedData: ReviewExcludedData = {
			schema: "ksk_review_excluded_html_data.v1",
			client_key: basename(clientDir),
			generated_at: new Date().toISOString(),
			index_href: REVIEW_INDEX_HTML_NAME,
			items,
		};
		mkdirSync(reviewRoot, { recursive: true });
		writeFileSync(
			join(reviewRoot, REVIEW_EXCLUDED_HTML_NAME),
			renderReviewExcludedHtml(excludedData),
		);
		excludedHref = REVIEW_EXCLUDED_HTML_NAME;
	}

	const indexData: ReviewIndexData = {
		schema: "ksk_review_index_html_data.v1",
		client_key: basename(clientDir),
		generated_at: new Date().toISOString(),
		total_units: ledger?.counts?.units ?? null,
		excluded_agent_count: ledger?.counts?.excluded_agent ?? agentExclusions.length,
		excluded_human_count: ledger?.counts?.excluded_human ?? 0,
		buckets: outputs.map((o) => ({
			bucket: o.bucket,
			label: reviewBucketLabel(o.bucket),
			href: toPosix(relative(reviewRoot, o.review_html)),
			groups: o.groups,
			pages: o.pages,
		})),
		excluded_href: excludedHref,
	};
	mkdirSync(reviewRoot, { recursive: true });
	writeFileSync(join(reviewRoot, REVIEW_INDEX_HTML_NAME), renderReviewIndexHtml(indexData));

	console.log(
		JSON.stringify(
			{
				ok: true,
				client_dir: clientDir,
				doc_groups: docGroupsRoot,
				review_dir: reviewRoot,
				buckets: outputs,
				skipped_groups: skipped,
				review_index: join(reviewRoot, REVIEW_INDEX_HTML_NAME),
				review_excluded: excludedHref ? join(reviewRoot, REVIEW_EXCLUDED_HTML_NAME) : null,
				ledger_found: ledger != null,
			},
			null,
			2,
		),
	);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
