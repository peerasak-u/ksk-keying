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

const TOOL_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(TOOL_DIR, "../../../..");
const DEFAULT_DPI = 200;
const DEFAULT_CONCURRENCY = 4;
const SPREADSHEET_EXTS = new Set([".xls", ".xlsx", ".csv"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const READY_EXTS = new Set([...SPREADSHEET_EXTS, ...IMAGE_EXTS]);

type Args = {
	clientDir: string;
	dpi: number;
	concurrency: number;
	force: boolean;
	dryRun: boolean;
	json: boolean;
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
  --json              Print machine-readable JSON
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
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dpi") args.dpi = Number(argv[++i]);
		else if (arg === "--concurrency") args.concurrency = Number(argv[++i]);
		else if (arg === "--force") args.force = true;
		else if (arg === "--dry-run") args.dryRun = true;
		else if (arg === "--json") args.json = true;
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
	return args;
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
	for (const command of ["pdfinfo", "pdftoppm"]) {
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

async function renderAllPages(
	pdfPath: string,
	outputDir: string,
	pageCount: number,
	width: number,
	dpi: number,
) {
	cleanupRenderFiles(outputDir);
	await run("pdftoppm", [
		"-png",
		"-r",
		String(dpi),
		pdfPath,
		join(outputDir, "_render"),
	]);
	const produced = readdirSync(outputDir)
		.filter((name) => name.startsWith("_render") && name.endsWith(".png"))
		.sort();
	if (produced.length !== pageCount)
		throw new Error(
			`Expected ${pageCount} PNGs, got ${produced.length} for ${pdfPath}`,
		);
	const pages = [] as string[];
	for (let page = 1; page <= produced.length; page++) {
		const artifact = `page-${String(page).padStart(width, "0")}.png`;
		renameSync(join(outputDir, produced[page - 1]), join(outputDir, artifact));
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

async function preparePdf(
	clientDir: string,
	pdfPath: string,
	args: Args,
): Promise<PrepareResult> {
	const outputDir = sourceOutputDir(clientDir, pdfPath);
	const manifest = join(outputDir, "manifest.yaml");
	const relSource = relative(clientDir, pdfPath);
	const relOut = relative(clientDir, outputDir);
	if (args.dryRun)
		return {
			source: relSource,
			status: "dry_run",
			kind: "pdf",
			output_dir: relOut,
		};
	if (existsSync(manifest) && !args.force)
		return {
			source: relSource,
			status: "skipped",
			reason: "manifest exists",
			kind: "pdf",
			output_dir: relOut,
		};

	rmSync(outputDir, { recursive: true, force: true });
	mkdirSync(outputDir, { recursive: true });
	const pageCount = await pdfPageCount(pdfPath);
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
}

function resolveClientDir(input: string) {
	const path = resolve(input);
	if (existsSync(path)) return path;
	return resolve(PROJECT_ROOT, input);
}

function prepareReadyFile(
	clientDir: string,
	sourcePath: string,
	args: Args,
): PrepareResult {
	const outputDir = sourceOutputDir(clientDir, sourcePath);
	const manifest = join(outputDir, "manifest.yaml");
	const relSource = relative(clientDir, sourcePath);
	const relOut = relative(clientDir, outputDir);
	if (args.dryRun)
		return {
			source: relSource,
			status: "dry_run",
			kind: "ready",
			output_dir: relOut,
		};
	if (existsSync(manifest) && !args.force)
		return {
			source: relSource,
			status: "skipped",
			reason: "manifest exists",
			kind: "ready",
			output_dir: relOut,
		};

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
}

async function processClientDir(args: Args) {
	const clientDir = resolveClientDir(args.clientDir);
	if (!existsSync(clientDir) || !statSync(clientDir).isDirectory())
		throw new Error(`not a directory: ${clientDir}`);
	const pdfs = discoverPdfs(clientDir);
	const readyFiles = discoverReadyFiles(clientDir);
	if (pdfs.length && !args.dryRun) ensurePoppler();
	const pdfResults = await mapPool(pdfs, args.concurrency, (pdf) =>
		preparePdf(clientDir, pdf, args),
	);
	const readyResults = readyFiles.map((file) =>
		prepareReadyFile(clientDir, file, args),
	);
	const results = [...pdfResults, ...readyResults];
	return {
		ok: true,
		client_dir: clientDir,
		pdf_count: pdfs.length,
		ready_count: readyFiles.length,
		prepared: results.filter((row) => row.status === "prepared").length,
		skipped: results.filter((row) => row.status === "skipped").length,
		dry_run: results.filter((row) => row.status === "dry_run").length,
		results,
	};
}

async function main() {
	const args = parseArgs(Bun.argv.slice(2));
	const payload = await processClientDir(args);
	if (args.json) console.log(JSON.stringify(payload, null, 2));
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
				else console.log(`dry-run: ${item.source} → ${item.output_dir}`);
			}
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
