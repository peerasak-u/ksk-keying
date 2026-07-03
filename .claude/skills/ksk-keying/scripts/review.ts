import { basename, dirname, join, relative, resolve } from "node:path";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {
	hashString,
	loadCoaRows,
	renderReviewHtml,
	type CoaRow,
	type ReviewData,
	type ReviewLine,
	type ReviewPage,
} from "./review-template";

const TOOL_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(TOOL_DIR, "../../../..");
const GATE_SUFFIX = ".gate.json";
const EXTRACT_SUFFIX = ".extract.json";
const CATEGORIZE_SUFFIX = ".categorize.json";
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp"];


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

type ExtractLine = {
	description: string | null;
	qty: number | null;
	unit: string | null;
	unit_price: number | null;
	amount: number | null;
	amount_includes_vat: boolean | null;
};

type ExtractData = {
	doc_kind: string;
	confidence: "low" | "medium" | "high";
	document_date: string | null;
	document_no: string | null;
	reference_no: string | null;
	seller: { name: string | null; tax_id: string | null };
	buyer: { name: string | null; tax_id: string | null };
	vat_treatment: 7 | 0 | null;
	amounts: Record<string, number | null>;
	summary: string | null;
	lines: ExtractLine[];
};

type ExtractSidecar = {
	gate?: { group?: string; usable?: boolean };
	extract?: ExtractData;
};

type CategorizeLine = Partial<ExtractLine> & {
	line_index?: number;
	account_code?: string;
	sub_code?: string;
	account_name_th?: string;
	confidence?: "low" | "medium" | "high";
	reason?: string;
	needs_review?: boolean;
};

type CategorizeSidecar = {
	categorize?: {
		lines?: CategorizeLine[];
	};
};

type ReviewContext = {
	clientDir: string;
	pagesDir: string;
	gateGroupsDir: string;
	coaCsvPath: string;
	coaRows: CoaRow[];
	groupDirs: string[];
};

function usage(): never {
	console.error(`Usage: bun run review -- [options] <client-dir>

Options:
  --coa-csv PATH  Explicit COA CSV path
  --force         Overwrite existing _gate_groups/<group>/review.html
  --skip-missing  Skip groups with missing .categorize.json instead of failing
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

function resolveClientFile(
	clientPath: string,
	path: string | undefined,
	fallback: string,
) {
	return resolve(dirname(clientPath), path || fallback);
}

function discoverFiles(dir: string, suffix: string) {
	const out: string[] = [];
	const stack = [dir];
	while (stack.length) {
		const current = stack.pop()!;
		for (const name of readdirSync(current).sort()) {
			const child = join(current, name);
			const st = statSync(child);
			if (st.isDirectory()) stack.push(child);
			else if (st.isFile() && name.endsWith(suffix)) out.push(child);
		}
	}
	return out.sort();
}

function discoverGates(dir: string) {
	return discoverFiles(dir, GATE_SUFFIX);
}

function stemForGate(path: string) {
	return path.slice(0, -GATE_SUFFIX.length);
}

function groupDirs(gateGroupsDir: string) {
	return readdirSync(gateGroupsDir)
		.map((name) => join(gateGroupsDir, name))
		.filter((path) => statSync(path).isDirectory())
		.sort();
}

function stemForExtract(path: string) {
	return path.slice(0, -EXTRACT_SUFFIX.length);
}

function categorizeForExtract(path: string) {
	return stemForExtract(path) + CATEGORIZE_SUFFIX;
}

function imageForExtract(path: string) {
	return IMAGE_EXTS.map((ext) => stemForExtract(path) + ext).find(existsSync);
}

function toPosix(path: string) {
	return path.split("/").join("/");
}

function getAmount(extract: ExtractData, key: string) {
	const value = extract.amounts?.[key];
	return value === undefined ? null : value;
}

function vatTreatment(value: 7 | 0 | null) {
	if (value === 7) return "vat_7";
	if (value === 0) return "non_vat";
	return "";
}

function pageFacts(
	extract: ExtractData,
): Record<string, string | number | null> {
	return {
		date: extract.document_date,
		document_no: extract.document_no,
		reference: extract.reference_no,
		seller: extract.seller?.name || null,
		seller_tax_id: extract.seller?.tax_id || null,
		buyer: extract.buyer?.name || null,
		buyer_tax_id: extract.buyer?.tax_id || null,
		subtotal: getAmount(extract, "pre_vat_total"),
		vat: getAmount(extract, "vat"),
		total: getAmount(extract, "gross_total"),
		paid: getAmount(extract, "net_payable"),
		summary: extract.summary,
		vat_treatment: vatTreatment(extract.vat_treatment),
	};
}

function reviewLines(
	extract: ExtractData,
	categorize: CategorizeSidecar,
	path: string,
) {
	const lines = categorize.categorize?.lines;
	if (!Array.isArray(lines))
		throw new Error(`invalid categorize lines: ${path}`);
	const byIndex = new Map<number, CategorizeLine>();
	for (const line of lines) {
		const index = Number(line.line_index);
		if (Number.isInteger(index)) byIndex.set(index, line);
	}
	return extract.lines.map((line, index): ReviewLine => {
		const categorized = byIndex.get(index);
		if (!categorized)
			throw new Error(`missing categorize line_index ${index}: ${path}`);
		return {
			line_index: index,
			description: line.description,
			qty: line.qty,
			unit: line.unit,
			unit_price: line.unit_price,
			amount: line.amount,
			amount_includes_vat: line.amount_includes_vat,
			account_code: String(categorized.account_code || ""),
			sub_code: String(categorized.sub_code || ""),
			account_name_th: String(categorized.account_name_th || ""),
			confidence: categorized.confidence || "low",
			reason: String(categorized.reason || ""),
			needs_review: Boolean(categorized.needs_review),
		};
	});
}

function pageFromExtract(
	pagesDir: string,
	groupDir: string,
	extractPath: string,
): ReviewPage {
	const categorizePath = categorizeForExtract(extractPath);
	const extractSidecar = readJson<ExtractSidecar>(extractPath);
	const categorizeSidecar = readJson<CategorizeSidecar>(categorizePath);
	if (!extractSidecar.extract)
		throw new Error(`missing extract payload: ${extractPath}`);
	const lines = reviewLines(
		extractSidecar.extract,
		categorizeSidecar,
		categorizePath,
	);
	const image = imageForExtract(extractPath);
	const relStem = toPosix(relative(pagesDir, stemForExtract(extractPath)));
	const needsAttention = lines.some(
		(line) => line.needs_review || line.confidence !== "high",
	);
	return {
		ref: relStem,
		short_ref: basename(relStem),
		image_src: image ? toPosix(relative(pagesDir, image)) : null,
		extract_path: relStem,
		categorize_path: relStem,
		facts: pageFacts(extractSidecar.extract),
		lines,
		initial_status: needsAttention ? "needs_attention" : "reviewed",
	};
}

function buildReviewData(args: {
	clientDir: string;
	pagesDir: string;
	groupDir: string;
	coaCsvPath: string;
	coaRows: CoaRow[];
	skipMissing: boolean;
}): ReviewData {
	const group = basename(args.groupDir);
	const gates = discoverGates(args.pagesDir).filter((gate) => {
		const data = readJson<ExtractSidecar>(gate);
		return data?.gate?.group === group;
	});
	let extractPaths = gates
		.map((gate) => stemForGate(gate) + EXTRACT_SUFFIX)
		.filter(existsSync);
	if (args.skipMissing)
		extractPaths = extractPaths.filter((path) =>
			existsSync(categorizeForExtract(path)),
		);
	const pages = extractPaths.map((path) =>
		pageFromExtract(args.pagesDir, args.groupDir, path),
	);
	const payload = { group, pages, coa: args.coaRows };
	return {
		schema: "ksk_review_group_html_data.v1",
		client_dir: args.clientDir,
		client_key: basename(args.clientDir),
		group,
		group_dir: args.groupDir,
		generated_at: new Date().toISOString(),
		content_fingerprint: hashString(JSON.stringify(payload)),
		coa_csv: args.coaCsvPath,
		coa_rows: args.coaRows,
		pages,
	};
}

function validateCategorize(pagesDir: string, group: string) {
	const gates = discoverGates(pagesDir).filter((gate) => {
		const data = readJson<ExtractSidecar>(gate);
		return data?.gate?.group === group;
	});
	return gates
		.map((gate) => stemForGate(gate) + EXTRACT_SUFFIX)
		.filter(existsSync)
		.filter((extract) => !existsSync(categorizeForExtract(extract)));
}

function missingCategorizeMessage(
	clientDir: string,
	pagesDir: string,
	missingByGroup: Map<string, string[]>,
) {
	const lines = [
		"missing .categorize.json files; run categorize before review:",
		`  bun run --cwd .claude/skills/ksk-keying/scripts categorize -- "${join(clientDir, "_pages")}"`,
		`  bun run --cwd .claude/skills/ksk-keying/scripts group-gates -- --force "${join(clientDir, "_pages")}"`,
		"",
		`checked: ${pagesDir}`,
	];
	for (const [group, missing] of missingByGroup) {
		lines.push(`- ${group}: ${missing.length} missing`);
		for (const path of missing.slice(0, 5))
			lines.push(`  - ${relative(pagesDir, path)}`);
		if (missing.length > 5) lines.push(`  - ... ${missing.length - 5} more`);
	}
	return lines.join("\n");
}

function resolveClientDir(input: string) {
	const clientDir = resolveInput(input);
	if (!existsSync(clientDir) || !statSync(clientDir).isDirectory())
		throw new Error(`not a client directory: ${clientDir}`);
	return clientDir;
}

function resolveGateGroupsDir(clientDir: string) {
	const gateGroupsDir = join(clientDir, "_gate_groups");
	if (!existsSync(gateGroupsDir) || !statSync(gateGroupsDir).isDirectory())
		throw new Error(
			`missing _gate_groups under ${clientDir}\nrun: bun run --cwd .claude/skills/ksk-keying/scripts group-gates -- "${join(clientDir, "_pages")}"`,
		);
	return gateGroupsDir;
}

function resolveCoaCsv(args: Args, clientDir: string) {
	const clientPath = join(clientDir, "client.json");
	const client = existsSync(clientPath)
		? readJson<ClientContext>(clientPath)
		: ({} as ClientContext);
	return resolveInput(
		args.coaCsvPath || resolveClientFile(clientPath, client.coa_csv, "coa.csv"),
	);
}

function loadReviewContext(args: Args): ReviewContext {
	const clientDir = resolveClientDir(args.clientDir);
	const pagesDir = join(clientDir, "_pages");
	if (!existsSync(pagesDir) || !statSync(pagesDir).isDirectory())
		throw new Error(`missing _pages under ${clientDir}`);
	const gateGroupsDir = resolveGateGroupsDir(clientDir);
	const coaCsvPath = resolveCoaCsv(args, clientDir);
	if (!existsSync(coaCsvPath))
		throw new Error(`missing COA CSV: ${coaCsvPath}`);
	const dirs = groupDirs(gateGroupsDir);
	if (!dirs.length)
		throw new Error(
			`no groups under ${gateGroupsDir}\nrun: bun run --cwd .claude/skills/ksk-keying/scripts group-gates -- "${join(clientDir, "_pages")}"`,
		);
	return {
		clientDir,
		pagesDir,
		gateGroupsDir,
		coaCsvPath,
		coaRows: loadCoaRows(coaCsvPath),
		groupDirs: dirs,
	};
}

function assertCategorized(
	context: ReviewContext,
	skipMissing: boolean,
): Map<string, string[]> {
	const missingByGroup = new Map<string, string[]>();
	for (const groupDir of context.groupDirs) {
		const missing = validateCategorize(context.pagesDir, basename(groupDir));
		if (missing.length) missingByGroup.set(basename(groupDir), missing);
	}
	if (missingByGroup.size && !skipMissing)
		throw new Error(
			missingCategorizeMessage(
				context.clientDir,
				context.pagesDir,
				missingByGroup,
			),
		);
	return missingByGroup;
}

function writeReviewHtml(path: string, data: ReviewData, force: boolean) {
	if (existsSync(path) && !force)
		throw new Error(`exists: ${path} (pass --force)`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, renderReviewHtml(data));
}

function generateReviews(
	context: ReviewContext,
	force: boolean,
	skipMissing: boolean,
) {
	return context.groupDirs.map((groupDir) => {
		const data = buildReviewData({
			clientDir: context.clientDir,
			pagesDir: context.pagesDir,
			groupDir,
			coaCsvPath: context.coaCsvPath,
			coaRows: context.coaRows,
			skipMissing,
		});
		const out = join(groupDir, "review.html");
		writeReviewHtml(out, data, force);
		return { group: data.group, review_html: out, pages: data.pages.length };
	});
}

function printSummary(
	context: ReviewContext,
	outputs: ReturnType<typeof generateReviews>,
) {
	console.log(
		JSON.stringify(
			{
				ok: true,
				client_dir: context.clientDir,
				gate_groups: context.gateGroupsDir,
				groups: outputs,
			},
			null,
			2,
		),
	);
}

function main() {
	const args = parseArgs(Bun.argv.slice(2));
	const context = loadReviewContext(args);
	const missingByGroup = assertCategorized(context, args.skipMissing);
	if (missingByGroup.size && args.skipMissing) {
		console.error(
			"warn: skipping pages with missing .categorize.json:\n" +
				Array.from(missingByGroup.entries())
					.map(
						([group, paths]) =>
							`- ${group}: ${paths.length} page(s) skipped`,
					)
					.join("\n"),
		);
	}
	printSummary(context, generateReviews(context, args.force, args.skipMissing));
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
