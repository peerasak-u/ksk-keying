import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { bucketIntoRuns, classifyPageDpis, type DpiRun } from "./page-dpi";

const TOOL_DIR = import.meta.dir;
const PROJECT_ROOT = resolve(TOOL_DIR, "../../../..");
const DEFAULT_DPI = 200;
const DEFAULT_CONCURRENCY = 4;
const SPREADSHEET_EXTS = new Set([".xls", ".xlsx", ".csv"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const READY_EXTS = new Set([...SPREADSHEET_EXTS, ...IMAGE_EXTS]);

export type Args = {
	clientDir: string;
	dpi: number;
	concurrency: number;
	force: boolean;
	dryRun: boolean;
	json: boolean;
	// Blocker fix (spawn-stage.ts's chunk loop): `--json` alone still emits the
	// full `results[]` array — one row per discovered source, `prepared` rows
	// carrying every rendered page filename plus the manifest path. MEASURED
	// (samples/clients/336, 2026-07-27): a realistic mid-run chunk payload for
	// that client's 1,405 sources is 691,277 bytes pretty-printed, 69% of
	// process-supervisor.ts's default 1,000,000-byte maxOutputBytes retention
	// cap — and it scales linearly with source count, so a client ~1.45x that
	// size truncates it outright. The chunk loop's only real control signal is
	// the small counters block (`prepared`/`deferred`/`chunk_pages_rendered`/
	// `work_remains`), never the per-source rows, so give it a way to ask for
	// JUST that: `--json-summary` prints the same payload with `results`
	// omitted, bounded by the number of DISTINCT fields above rather than by
	// source count. `--json` (full payload, `results` included) is unchanged
	// for every other caller — human/CI callers that actually want the
	// per-source detail keep getting it.
	jsonSummary: boolean;
	// Fix F: bounded-work budget, in pages, for ONE invocation of this script.
	// undefined (the default, no flag passed) preserves every caller's existing
	// behaviour exactly — render everything discovered, no chunking, no
	// "work_remains" bookkeeping. Only set by a caller (console/sequencer's
	// prepare-pages chunk loop) that wants to guarantee no single invocation
	// can approach console/sequencer/spawn-stage.ts's MAX_SUPERVISED_WALL_MS.
	maxPages?: number;
};

type PrepareResult = {
	source: string;
	status: string;
	kind: string;
	output_dir: string;
	reason?: string;
	page_count?: number;
	text_pages?: number;
	image_pages?: number;
	pages?: string[];
	manifest?: string;
};

function usage(): never {
	console.error(`Usage: bun run prepare-pages -- [options] <client-dir>

Options:
  --dpi N             Render DPI (default: ${DEFAULT_DPI})
  --concurrency N     Parallel PDF renders (default: ${DEFAULT_CONCURRENCY})
  --force             Re-render even when manifest.yaml exists
  --dry-run           Print planned outputs without writing files
  --json              Print machine-readable JSON (includes per-source \`results[]\`)
  --json-summary      Print machine-readable JSON without \`results[]\` — just
                      the counters (prepared/skipped/deferred/work_remains/…);
                      unlike --json this stays small regardless of how many
                      sources the client has, since it never enumerates them
  --max-pages N       Bound this invocation to ~N pages of rendering work
                      (whole sources only, never split mid-source); sources
                      still needing work after the budget is exhausted are
                      reported as "deferred" and \`work_remains: true\` is set
                      in --json output so a caller can invoke again. Omit for
                      today's unbounded behaviour (default).
`);
	process.exit(2);
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		clientDir: "",
		dpi: DEFAULT_DPI,
		concurrency: DEFAULT_CONCURRENCY,
		force: false,
		dryRun: false,
		json: false,
		jsonSummary: false,
		maxPages: undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dpi") args.dpi = Number(argv[++i]);
		else if (arg === "--concurrency") args.concurrency = Number(argv[++i]);
		else if (arg === "--force") args.force = true;
		else if (arg === "--dry-run") args.dryRun = true;
		else if (arg === "--json") args.json = true;
		else if (arg === "--json-summary") args.jsonSummary = true;
		else if (arg === "--max-pages") args.maxPages = Number(argv[++i]);
		else if (arg === "--help" || arg === "-h") usage();
		else if (arg.startsWith("--")) usage();
		else if (!args.clientDir) args.clientDir = arg;
		else usage();
	}
	if (
		!args.clientDir ||
		!Number.isInteger(args.dpi) ||
		args.dpi < 1 ||
		!Number.isInteger(args.concurrency) ||
		args.concurrency < 1
	)
		usage();
	if (
		args.maxPages !== undefined &&
		(!Number.isInteger(args.maxPages) || args.maxPages < 1)
	)
		usage();
	return args;
}

// Pure chunk-selection logic (fix F), split out from processClientDir so it
// can be unit tested with plain numbers — no filesystem, no subprocess.
// `pageCosts` holds ONLY the sources that already need work this run (already
// skip-if-exists-filtered) in discovery order, each with its own page cost
// (a PDF's real page count, or 1 for a ready-file). Never splits a single
// source's cost across two chunks.
//
// Greedy, in-order selection with a "make progress" guarantee: the first
// needs-work item is always included even if its own cost alone exceeds
// maxPages (never emits an empty chunk while work remains — see fix F's
// no-progress requirement one layer up, in console/sequencer/spawn-stage.ts's
// loop). After that, keep including items while the running total is still
// under budget; stop as soon as it reaches/exceeds it.
export function selectChunk(
	pageCosts: number[],
	maxPages: number | undefined,
): { selected: number[]; total: number; workRemains: boolean } {
	if (maxPages === undefined) {
		const total = pageCosts.reduce((sum, cost) => sum + cost, 0);
		return { selected: pageCosts.map((_, i) => i), total, workRemains: false };
	}
	const selected: number[] = [];
	let total = 0;
	for (let i = 0; i < pageCosts.length; i++) {
		if (selected.length > 0 && total >= maxPages) break;
		selected.push(i);
		total += pageCosts[i];
		if (total >= maxPages) break;
	}
	return { selected, total, workRemains: selected.length < pageCosts.length };
}

function run(command: string, argv: string[]) {
	return new Promise<string>((resolve, reject) => {
		const proc = spawn(command, argv);
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (chunk: Uint8Array) => {
			stdout += String(chunk);
		});
		proc.stderr.on("data", (chunk: Uint8Array) => {
			stderr += String(chunk);
		});
		proc.on("error", reject);
		proc.on("close", (code: number | null) => {
			if (code !== 0)
				reject(new Error(`${command} failed: ${stderr || stdout}`.trim()));
			else resolve(stdout);
		});
	});
}

async function mapPool<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<R>,
) {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		async () => {
			while (true) {
				const index = next++;
				if (index >= items.length) break;
				results[index] = await fn(items[index]);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

function ensurePoppler() {
	// pdfimages and pdftotext are required by the per-page DPI classifier
	// (page-dpi.ts) — without them we can't even ATTEMPT the cheap path, so
	// fail the same way as a missing pdfinfo/pdftoppm rather than silently
	// falling back per-PDF (that fallback exists for classification failing
	// on one document, not for the tool being absent from the machine).
	for (const command of ["pdfinfo", "pdftoppm", "pdfimages", "pdftotext"]) {
		const found = spawnSync("which", [command], { encoding: "utf8" });
		if (found.status !== 0)
			throw new Error(
				`${command} not found — install poppler (brew install poppler)`,
			);
	}
}

function stem(path: string) {
	const name = basename(path);
	const ext = extname(name);
	return ext ? name.slice(0, -ext.length) : name;
}

function shouldSkip(clientDir: string, path: string) {
	const rel = relative(clientDir, path);
	const name = basename(path).toLowerCase();
	return (
		rel.split("/").includes("_pages") ||
		`${name} ${rel}`.includes("ผังบัญชี") ||
		name.startsWith("coa") ||
		name === "client.json"
	);
}

function discoverPdfs(clientDir: string) {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const child = join(dir, name);
			const st = statSync(child);
			if (st.isDirectory()) {
				if (name !== "_pages") walk(child);
			} else if (
				st.isFile() &&
				extname(child).toLowerCase() === ".pdf" &&
				!shouldSkip(clientDir, child)
			) {
				out.push(child);
			}
		}
	};
	walk(clientDir);
	return out;
}

function discoverReadyFiles(clientDir: string) {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const child = join(dir, name);
			const st = statSync(child);
			if (st.isDirectory()) {
				if (name !== "_pages") walk(child);
			} else if (
				st.isFile() &&
				READY_EXTS.has(extname(child).toLowerCase()) &&
				!shouldSkip(clientDir, child)
			) {
				out.push(child);
			}
		}
	};
	walk(clientDir);
	return out;
}

function sourceOutputDir(clientDir: string, sourcePath: string) {
	const rel = relative(clientDir, sourcePath);
	const parent = dirname(rel);
	return join(
		clientDir,
		"_pages",
		parent === "." ? "" : parent,
		stem(sourcePath),
	);
}

async function pdfPageCount(pdfPath: string) {
	const stdout = await run("pdfinfo", [pdfPath]);
	const line = stdout
		.split(/\r?\n/)
		.find((row: string) => row.startsWith("Pages:"));
	if (!line) throw new Error(`Could not read page count from ${pdfPath}`);
	return Number(line.split(":", 2)[1].trim());
}

function cleanupRenderFiles(outputDir: string) {
	for (const name of readdirSync(outputDir)) {
		if (name.startsWith("_render") && name.endsWith(".png"))
			rmSync(join(outputDir, name), { force: true });
	}
}

// Classify each page of pdfPath into a target render DPI (page-dpi.ts), or
// fall back to rendering every page at `requestedDpi` (today's behaviour)
// if the classification commands themselves fail to run. This is only the
// "tool couldn't run at all" fallback — page-dpi.ts already resolves any
// unparseable/ambiguous *output* to 300 internally (see D5 in its header
// comment), so a garbled-but-present pdfimages/pdftotext output still
// yields a valid per-page array here, not this catch branch.
async function classifyPdfDpis(pdfPath: string, pageCount: number, requestedDpi: number) {
	try {
		const [imagesOut, textOut, infoOut] = await Promise.all([
			run("pdfimages", ["-list", pdfPath]),
			run("pdftotext", [pdfPath, "-"]),
			// -f/-l is load-bearing, not decoration: WITHOUT it pdfinfo prints one
			// document-level "Page size:" line, which is page 1's MediaBox — and
			// classifying pages 2..N against page 1's dimensions downscales pages
			// nothing was ever proven about (a receipt-sized page 1 in front of an
			// A4 page 2 is enough to trigger it). WITH it, pdfinfo prints a "Page N
			// size:" line per page and each page is judged on its own size.
			run("pdfinfo", ["-f", "1", "-l", String(pageCount), pdfPath]),
		]);
		return classifyPageDpis({
			pageCount,
			pdfImagesListOutput: imagesOut,
			pdfTextOutput: textOut,
			pdfInfoOutput: infoOut,
			// `--dpi` is the ceiling, not merely the fallback. Passing it here
			// is what keeps the flag meaningful: page-dpi.ts may only choose a
			// DPI at or below it, so this script never renders a page at a
			// higher resolution than the caller asked for.
			maxDpi: requestedDpi,
		});
	} catch {
		return new Array(pageCount).fill(requestedDpi);
	}
}

// Render one DPI tier (a contiguous run of same-DPI pages, see
// page-dpi.ts#bucketIntoRuns) with a single pdftoppm -f/-l invocation, and
// map its output back to TRUE page numbers.
//
// CORRECTNESS INVARIANT: the TRUE page number is computed as
// `run.startPage + positional index within this run's own sorted output` —
// i.e. straight from the -f offset — and we never parse the number pdftoppm
// embeds in the output filename.
//
// MEASURED (poppler 25.03, `pdftoppm -f 4 -l 4` on a 12-page document emits
// `-04.png`): that embedded number's zero-padding width is derived from the
// DOCUMENT's page count, so it is in fact uniform across every invocation for
// a given PDF, and a lexicographic .sort() therefore equals numeric order
// within a run. An earlier version of this comment claimed the padding
// depended on the -f/-l range; that is FALSE, and it matters that it is
// recorded as false, because it was the stated justification for this whole
// scheme. The scheme is kept anyway, on a better justification: it does not
// depend on that padding rule holding in some other poppler build, and each
// run writing under its own `_render_t<runIndex>-` prefix means two runs'
// outputs can never collide or be interleaved by a shared sort. Do NOT
// "simplify" this back to parsing the embedded number.
async function renderTier(
	pdfPath: string,
	outputDir: string,
	runIndex: number,
	tierRun: DpiRun,
	width: number,
): Promise<Map<number, string>> {
	const prefix = join(outputDir, `_render_t${runIndex}`);
	await run("pdftoppm", [
		"-png",
		"-r",
		String(tierRun.dpi),
		"-f",
		String(tierRun.startPage),
		"-l",
		String(tierRun.endPage),
		pdfPath,
		prefix,
	]);
	const produced = readdirSync(outputDir)
		.filter((name) => name.startsWith(`_render_t${runIndex}-`))
		.sort();
	const expectedCount = tierRun.endPage - tierRun.startPage + 1;
	if (produced.length !== expectedCount)
		throw new Error(
			`Expected ${expectedCount} PNGs for pages ${tierRun.startPage}-${tierRun.endPage} of ${pdfPath}, got ${produced.length}`,
		);

	const artifactByPage = new Map<number, string>();
	produced.forEach((name, index) => {
		const truePage = tierRun.startPage + index;
		const artifact = `page-${String(truePage).padStart(width, "0")}.png`;
		renameSync(join(outputDir, name), join(outputDir, artifact));
		artifactByPage.set(truePage, artifact);
	});
	return artifactByPage;
}

async function renderAllPages(
	pdfPath: string,
	outputDir: string,
	pageCount: number,
	width: number,
	dpi: number,
) {
	cleanupRenderFiles(outputDir);
	const dpis = await classifyPdfDpis(pdfPath, pageCount, dpi);
	const runs = bucketIntoRuns(dpis);

	const artifactByPage = new Map<number, string>();
	for (let runIndex = 0; runIndex < runs.length; runIndex++) {
		const produced = await renderTier(pdfPath, outputDir, runIndex, runs[runIndex], width);
		for (const [page, artifact] of produced) artifactByPage.set(page, artifact);
	}

	if (artifactByPage.size !== pageCount)
		throw new Error(
			`Expected ${pageCount} PNGs, got ${artifactByPage.size} for ${pdfPath}`,
		);
	const pages: string[] = [];
	for (let page = 1; page <= pageCount; page++) {
		const artifact = artifactByPage.get(page);
		if (!artifact) throw new Error(`Missing rendered page ${page} for ${pdfPath}`);
		pages.push(artifact);
	}
	cleanupRenderFiles(outputDir);
	return pages;
}

function yamlQuote(text: string) {
	return `'${text.replace(/'/g, "''")}'`;
}

function sourceType(path: string) {
	const ext = extname(path).toLowerCase();
	if (ext === ".jpg") return "jpeg";
	return ext.slice(1);
}

function fileModality(path: string) {
	return IMAGE_EXTS.has(extname(path).toLowerCase()) ? "image" : "spreadsheet";
}

function writeManifest(
	sourcePath: string,
	clientDir: string,
	outputDir: string,
	artifacts: string[],
	modality: string,
	stype: string,
) {
	const relSource = relative(clientDir, sourcePath);
	const lines = [
		`source_path: ${yamlQuote(relSource)}`,
		`source_type: ${stype}`,
		`page_count: ${artifacts.length}`,
		"pages:",
	];
	artifacts.forEach((artifact, index) => {
		lines.push(`  - page: ${index + 1}`);
		lines.push(`    modality: ${yamlQuote(modality)}`);
		lines.push(`    artifact: ${yamlQuote(artifact)}`);
	});
	writeFileSync(join(outputDir, "manifest.yaml"), lines.join("\n") + "\n");
}

// A source is either already "done" for this run (skipped/dry-run — free,
// costs nothing, always reported) or "pending" (needs actual rendering work,
// carries its own page cost so the chunk selector above can budget it, and an
// `execute` closure that does the heavy lifting only if chosen). Splitting
// planning from execution is what lets processClientDir pick a bounded subset
// of sources to actually render without ever calling pdftoppm/pdfinfo on a
// source that's going to be skipped or deferred anyway.
type PlannedSource =
	| { status: "done"; result: PrepareResult }
	| {
			status: "pending";
			kind: "pdf" | "ready";
			relSource: string;
			relOut: string;
			pageCost: number;
			execute: () => Promise<PrepareResult>;
	  };

async function planPdf(
	clientDir: string,
	pdfPath: string,
	args: Args,
): Promise<PlannedSource> {
	const outputDir = sourceOutputDir(clientDir, pdfPath);
	const manifest = join(outputDir, "manifest.yaml");
	const relSource = relative(clientDir, pdfPath);
	const relOut = relative(clientDir, outputDir);
	if (args.dryRun)
		return {
			status: "done",
			result: { source: relSource, status: "dry_run", kind: "pdf", output_dir: relOut },
		};
	if (existsSync(manifest) && !args.force)
		return {
			status: "done",
			result: {
				source: relSource,
				status: "skipped",
				reason: "manifest exists",
				kind: "pdf",
				output_dir: relOut,
			},
		};

	// Cheap (single pdfinfo call) relative to rendering — needed up front so
	// the chunk selector can budget this source before committing to render it.
	const pageCount = await pdfPageCount(pdfPath);
	return {
		status: "pending",
		kind: "pdf",
		relSource,
		relOut,
		pageCost: pageCount,
		execute: async () => {
			rmSync(outputDir, { recursive: true, force: true });
			mkdirSync(outputDir, { recursive: true });
			const width = Math.max(3, String(pageCount).length);
			const pages = await renderAllPages(
				pdfPath,
				outputDir,
				pageCount,
				width,
				args.dpi,
			);
			writeManifest(pdfPath, clientDir, outputDir, pages, "image", "pdf");
			return {
				source: relSource,
				status: "prepared",
				kind: "pdf",
				page_count: pageCount,
				image_pages: pageCount,
				output_dir: relOut,
				pages,
				manifest: relative(clientDir, manifest),
			};
		},
	};
}

function resolveClientDir(input: string) {
	const path = resolve(input);
	if (existsSync(path)) return path;
	return resolve(PROJECT_ROOT, input);
}

function planReadyFile(
	clientDir: string,
	sourcePath: string,
	args: Args,
): PlannedSource {
	const outputDir = sourceOutputDir(clientDir, sourcePath);
	const manifest = join(outputDir, "manifest.yaml");
	const relSource = relative(clientDir, sourcePath);
	const relOut = relative(clientDir, outputDir);
	if (args.dryRun)
		return {
			status: "done",
			result: { source: relSource, status: "dry_run", kind: "ready", output_dir: relOut },
		};
	if (existsSync(manifest) && !args.force)
		return {
			status: "done",
			result: {
				source: relSource,
				status: "skipped",
				reason: "manifest exists",
				kind: "ready",
				output_dir: relOut,
			},
		};

	return {
		status: "pending",
		kind: "ready",
		relSource,
		relOut,
		// A ready file (image/spreadsheet) is always exactly one "page" worth of
		// work — cheap enough that it is never worth splitting across chunks.
		pageCost: 1,
		execute: async () => {
			rmSync(outputDir, { recursive: true, force: true });
			mkdirSync(outputDir, { recursive: true });
			const ext = extname(sourcePath).toLowerCase();
			const artifact = `page-001${ext}`;
			copyFileSync(sourcePath, join(outputDir, artifact));
			const stype = sourceType(sourcePath);
			writeManifest(
				sourcePath,
				clientDir,
				outputDir,
				[artifact],
				fileModality(sourcePath),
				stype,
			);
			return {
				source: relSource,
				status: "prepared",
				kind: "ready",
				page_count: 1,
				output_dir: relOut,
				pages: [artifact],
				manifest: relative(clientDir, manifest),
			};
		},
	};
}

export async function processClientDir(args: Args) {
	const clientDir = resolveClientDir(args.clientDir);
	if (!existsSync(clientDir) || !statSync(clientDir).isDirectory())
		throw new Error(`not a directory: ${clientDir}`);
	const pdfs = discoverPdfs(clientDir);
	const readyFiles = discoverReadyFiles(clientDir);
	if (pdfs.length && !args.dryRun) ensurePoppler();

	// Planning phase: cheap for every already-done source (a single existsSync
	// per source, no subprocess), and only one pdfinfo call per PDF that
	// actually needs work — never per skipped source.
	const pdfPlans = await mapPool(pdfs, args.concurrency, (pdf) =>
		planPdf(clientDir, pdf, args),
	);
	const readyPlans = readyFiles.map((file) => planReadyFile(clientDir, file, args));
	const plans = [...pdfPlans, ...readyPlans];

	// Chunk selection (fix F): only "pending" plans consume the --max-pages
	// budget; "done" plans are free and always reported regardless of it. With
	// no --max-pages this selects every pending plan, identical to the
	// pre-chunking behaviour.
	const pendingIndices: number[] = [];
	plans.forEach((plan, i) => {
		if (plan.status === "pending") pendingIndices.push(i);
	});
	const pendingCosts = pendingIndices.map(
		(i) => (plans[i] as Extract<PlannedSource, { status: "pending" }>).pageCost,
	);
	const { selected, total, workRemains } = selectChunk(pendingCosts, args.maxPages);
	const selectedPlanIndices = new Set(selected.map((i) => pendingIndices[i]));

	// Execution phase: render only the selected subset, in parallel up to
	// args.concurrency (matches the previous PDF-only mapPool concurrency, now
	// shared across PDFs and ready files since both are cheap to interleave).
	const executed = await mapPool(
		[...selectedPlanIndices],
		args.concurrency,
		async (i) => ({ i, result: await (plans[i] as Extract<PlannedSource, { status: "pending" }>).execute() }),
	);
	const executedByIndex = new Map(executed.map(({ i, result }) => [i, result]));

	const results: PrepareResult[] = plans.map((plan, i) => {
		if (plan.status === "done") return plan.result;
		const result = executedByIndex.get(i);
		if (result) return result;
		// Pending but not selected this invocation (--max-pages budget exhausted
		// before reaching it) — left untouched, to be picked up by a later
		// invocation via the same skip-if-exists check next time around.
		return {
			source: plan.relSource,
			status: "deferred",
			reason: "max-pages budget reached",
			kind: plan.kind,
			output_dir: plan.relOut,
			page_count: plan.kind === "pdf" ? plan.pageCost : undefined,
		};
	});

	return {
		ok: true,
		client_dir: clientDir,
		pdf_count: pdfs.length,
		ready_count: readyFiles.length,
		prepared: results.filter((row) => row.status === "prepared").length,
		skipped: results.filter((row) => row.status === "skipped").length,
		dry_run: results.filter((row) => row.status === "dry_run").length,
		deferred: results.filter((row) => row.status === "deferred").length,
		max_pages: args.maxPages,
		chunk_pages_rendered: args.maxPages === undefined ? undefined : total,
		work_remains: args.maxPages === undefined ? false : workRemains,
		results,
	};
}

async function main() {
	const args = parseArgs(Bun.argv.slice(2));
	const payload = await processClientDir(args);
	if (args.jsonSummary) {
		// Blocker fix: everything the counters block already had, minus the one
		// field (`results`) whose size is unbounded in source count — see this
		// flag's Args.jsonSummary comment.
		const { results: _results, ...summary } = payload;
		console.log(JSON.stringify(summary, null, 2));
	} else if (args.json) console.log(JSON.stringify(payload, null, 2));
	else {
		if (payload.pdf_count === 0 && payload.ready_count === 0)
			console.log(`No PDFs or ready files in ${payload.client_dir}`);
		else
			for (const item of payload.results) {
				if (item.status === "prepared") {
					const extra =
						item.kind === "pdf" && item.page_count
							? ` → ${item.page_count} pages`
							: "";
					console.log(
						`prepared (${item.kind}): ${item.source}${extra} in ${item.output_dir}`,
					);
				} else if (item.status === "skipped")
					console.log(`skip (exists): ${item.source} → ${item.output_dir}`);
				else if (item.status === "deferred")
					console.log(`deferred (max-pages budget): ${item.source} → ${item.output_dir}`);
				else console.log(`dry-run: ${item.source} → ${item.output_dir}`);
			}
		if (payload.max_pages !== undefined)
			console.log(
				`chunk: rendered ${payload.chunk_pages_rendered ?? 0} page(s) of budget ${payload.max_pages}` +
					`, deferred ${payload.deferred} source(s), work_remains=${payload.work_remains}`,
			);
	}
}

if (import.meta.main)
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
