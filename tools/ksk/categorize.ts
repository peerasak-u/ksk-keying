import { basename, dirname, extname, join, relative, resolve } from "node:path";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";

const TOOL_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(TOOL_DIR, "../..");
const DEFAULT_MODEL = "google/gemini-2.5-flash";
const EXTRACT_SUFFIX = ".extract.json";
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp"];

type OpenRouterMeta = {
	provider?: string | null;
	cache_status?: string | null;
	cached_tokens?: number | null;
	cache_write_tokens?: number | null;
	prompt_tokens?: number | null;
};

type GateResult = {
	gate: {
		usable: boolean;
		doc_kind: string;
		group: string;
		confidence: "low" | "medium" | "high";
		reason: string;
	};
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
	gate?: GateResult["gate"];
	extract: ExtractData;
};

type ClientContext = {
	business_name?: string;
	vat?: boolean;
	tax_id?: string;
	coa?: string;
	coa_csv?: string;
	coa_usage?: string;
};

type CoaRow = {
	account_code: string;
	sub_code: string;
	name_th: string;
	name_en: string;
};

type CategorizeLine = {
	line_index: number;
	account_code: string;
	sub_code: string;
	account_name_th: string;
	confidence: "low" | "medium" | "high";
	reason: string;
	needs_review: boolean;
};

type RawCategorizeResult = {
	meta?: OpenRouterMeta;
	categorize?: {
		lines?: Partial<CategorizeLine>[];
	};
};

type CategorizeResult = {
	meta?: OpenRouterMeta;
	categorize: { lines: CategorizeLine[] };
};

const CATEGORIZE_OUTPUT_EXAMPLE = {
	categorize: {
		lines: [
			{
				line_index: 0,
				account_code: "510110",
				sub_code: "",
				account_name_th: "ซื้อวัสดุอุปกรณ์ก่อสร้าง",
				confidence: "high",
				reason:
					"Line item matches construction material account meaning and prior tax-id usage.",
				needs_review: false,
			},
		],
	},
};

const CATEGORIZE_SCHEMA = {
	type: "object",
	properties: {
		categorize: {
			type: "object",
			properties: {
				lines: {
					type: "array",
					items: {
						type: "object",
						properties: {
							line_index: { type: "integer" },
							account_code: { type: "string" },
							sub_code: { type: "string" },
							account_name_th: { type: "string" },
							confidence: {
								type: "string",
								enum: ["low", "medium", "high"],
							},
							reason: { type: "string" },
							needs_review: { type: "boolean" },
						},
						required: [
							"line_index",
							"account_code",
							"sub_code",
							"account_name_th",
							"confidence",
							"reason",
							"needs_review",
						],
					},
				},
			},
			required: ["lines"],
		},
	},
	required: ["categorize"],
} as const;

function usage(): never {
	console.error(`Usage: bun run categorize -- [options] <extract-json-or-dir> [...]

Options:
  --out-dir DIR       Write *.categorize.json under DIR, preserving input paths
  --client PATH       Explicit client.json path
  --coa-csv PATH      Explicit COA CSV path
  --coa-usage PATH    Explicit coa_usage.json path
  --force             Overwrite existing categorize files
  --max-files N       Limit discovered extract sidecars
  --concurrency N     Process N pages concurrently (default: 1)
  --model MODEL       OpenRouter model (default: ${DEFAULT_MODEL})
  --no-cache          Do not send OpenRouter cache_control markers for bank images
  --dry-run           Print planned outputs without API calls\n`);
	process.exit(2);
}

function parseArgs(argv: string[]) {
	const args = {
		inputs: [] as string[],
		outDir: undefined as string | undefined,
		clientPath: undefined as string | undefined,
		coaCsvPath: undefined as string | undefined,
		coaUsagePath: undefined as string | undefined,
		force: false,
		maxFiles: undefined as number | undefined,
		concurrency: 1,
		model: DEFAULT_MODEL,
		noCache: false,
		dryRun: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--out-dir") args.outDir = argv[++i];
		else if (arg === "--client") args.clientPath = argv[++i];
		else if (arg === "--coa-csv") args.coaCsvPath = argv[++i];
		else if (arg === "--coa-usage") args.coaUsagePath = argv[++i];
		else if (arg === "--force") args.force = true;
		else if (arg === "--dry-run") args.dryRun = true;
		else if (arg === "--max-files") args.maxFiles = Number(argv[++i]);
		else if (arg === "--concurrency") args.concurrency = Number(argv[++i]);
		else if (arg === "--model") args.model = argv[++i];
		else if (arg === "--no-cache") args.noCache = true;
		else if (arg === "--help" || arg === "-h") usage();
		else if (arg.startsWith("--")) usage();
		else args.inputs.push(arg);
	}
	if (!args.inputs.length) usage();
	if (
		args.maxFiles !== undefined &&
		(!Number.isInteger(args.maxFiles) || args.maxFiles < 1)
	)
		usage();
	if (!Number.isInteger(args.concurrency) || args.concurrency < 1) usage();
	return args;
}

function resolveInput(input: string) {
	const path = resolve(input);
	if (existsSync(path)) return path;
	const fromRoot = resolve(PROJECT_ROOT, input);
	if (existsSync(fromRoot)) return fromRoot;
	return path;
}

function canonicalExtractPath(path: string) {
	const marker = "/_gate_groups/";
	const markerIndex = path.indexOf(marker);
	if (markerIndex === -1) return path;
	const clientDir = path.slice(0, markerIndex);
	const groupedRel = path.slice(markerIndex + marker.length);
	const firstSlash = groupedRel.indexOf("/");
	if (firstSlash === -1) return path;
	const pagesRel = groupedRel.slice(firstSlash + 1);
	const candidate = join(clientDir, "_pages", pagesRel);
	return existsSync(candidate) ? candidate : path;
}

function discover(input: string): string[] {
	const path = resolveInput(input);
	if (!existsSync(path)) throw new Error(`Missing input: ${input}`);
	const st = statSync(path);
	if (st.isFile())
		return path.endsWith(EXTRACT_SUFFIX) ? [canonicalExtractPath(path)] : [];
	const out: string[] = [];
	const stack = [path];
	while (stack.length) {
		const dir = stack.pop()!;
		for (const name of readdirSync(dir).sort()) {
			const child = join(dir, name);
			const childSt = statSync(child);
			if (childSt.isDirectory()) stack.push(child);
			else if (childSt.isFile() && name.endsWith(EXTRACT_SUFFIX))
				out.push(canonicalExtractPath(child));
		}
	}
	return [...new Set(out)].sort();
}

function relativeInputPath(input: string) {
	return input.startsWith(PROJECT_ROOT + "/")
		? relative(PROJECT_ROOT, input)
		: relative(process.cwd(), input);
}

function outputPath(input: string, outDir?: string) {
	const parsed = input.slice(0, -EXTRACT_SUFFIX.length) + ".categorize.json";
	if (!outDir) return parsed;
	return join(
		resolve(outDir),
		relativeInputPath(input).slice(0, -EXTRACT_SUFFIX.length) +
			".categorize.json",
	);
}

function siblingPath(input: string, suffix: string) {
	return input.slice(0, -EXTRACT_SUFFIX.length) + suffix;
}

function imageForExtract(input: string) {
	const stem = input.slice(0, -EXTRACT_SUFFIX.length);
	return IMAGE_EXTS.map((ext) => stem + ext).find(existsSync);
}

function findClientPath(input: string) {
	let dir = dirname(input);
	while (dir.startsWith(PROJECT_ROOT)) {
		const candidate = join(dir, "client.json");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function loadEnvFile(path: string) {
	if (!existsSync(path)) return;
	for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || !line.includes("=")) continue;
		const [key, ...rest] = line.split("=");
		if (process.env[key]) continue;
		let value = rest.join("=").trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		)
			value = value.slice(1, -1);
		process.env[key] = value;
	}
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function parseCsvLine(line: string) {
	const out: string[] = [];
	let value = "";
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') {
			if (quoted && line[i + 1] === '"') {
				value += '"';
				i++;
			} else quoted = !quoted;
		} else if (ch === "," && !quoted) {
			out.push(value);
			value = "";
		} else value += ch;
	}
	out.push(value);
	return out;
}

function loadCoaRows(path: string): CoaRow[] {
	const rows = readFileSync(path, "utf8").trim().split(/\r?\n/);
	const header = parseCsvLine(rows[0] || "");
	const idx = new Map(header.map((name, i) => [name, i]));
	for (const name of ["account_code", "sub_code", "name_th", "name_en"])
		if (!idx.has(name)) throw new Error(`missing COA column: ${name}`);
	return rows.slice(1).map((line) => {
		const values = parseCsvLine(line);
		return {
			account_code: values[idx.get("account_code")!] || "",
			sub_code: values[idx.get("sub_code")!] || "",
			name_th: values[idx.get("name_th")!] || "",
			name_en: values[idx.get("name_en")!] || "",
		};
	});
}

function accountKey(accountCode: string, subCode: string) {
	return subCode ? `${accountCode}:${subCode}` : accountCode;
}

function toCoaCsv(rows: CoaRow[]) {
	const escape = (value: string) =>
		/[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
	return [
		"account_code,sub_code,name_th,name_en",
		...rows.map((row) =>
			[row.account_code, row.sub_code, row.name_th, row.name_en]
				.map(escape)
				.join(","),
		),
	].join("\n");
}

function resolveClientFile(
	clientPath: string,
	path: string | undefined,
	fallback: string,
) {
	return resolve(dirname(clientPath), path || fallback);
}

function usageHintTaxIds(hint: unknown) {
	const taxIds = (hint as { tax_ids?: unknown[] }).tax_ids;
	if (!Array.isArray(taxIds)) return [];
	return taxIds
		.map((item) =>
			typeof item === "string" ? item : (item as { tax_id?: unknown })?.tax_id,
		)
		.filter((taxId): taxId is string => typeof taxId === "string" && !!taxId);
}

function relevantUsageHints(
	usage: unknown,
	extract: ExtractData,
	client: ClientContext,
) {
	if (!usage || typeof usage !== "object") return null;
	const data = usage as {
		expense_hints?: unknown[];
		bank_hints?: unknown[];
	};
	const taxIds = new Set(
		[extract.seller?.tax_id, extract.buyer?.tax_id].filter(
			(taxId): taxId is string => !!taxId && taxId !== client.tax_id,
		),
	);
	const lineText = extract.lines
		.map((line) => line.description || "")
		.join(" ")
		.toLowerCase();
	const expenseHints = (data.expense_hints || [])
		.filter((hint, index) => {
			const row = hint as { keywords?: unknown[]; evidence_rows?: number };
			const taxMatch = usageHintTaxIds(hint).some((taxId) => taxIds.has(taxId));
			const keywordMatch = (row.keywords || []).some(
				(keyword) =>
					typeof keyword === "string" &&
					lineText.includes(keyword.toLowerCase()),
			);
			return taxMatch || keywordMatch || index < 5;
		})
		.slice(0, 10);
	const bankHints =
		extract.doc_kind === "bank_statement" ? data.bank_hints || [] : [];
	return {
		expense_hints: expenseHints,
		bank_hints: bankHints,
	};
}

function extractJson<T>(text: string): T {
	const cleaned = text
		.trim()
		.replace(/^```(?:json)?\s*/, "")
		.replace(/\s*```$/, "");
	try {
		return JSON.parse(cleaned);
	} catch {
		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start < 0 || end <= start)
			throw new Error("OpenRouter returned non-JSON content");
		return JSON.parse(cleaned.slice(start, end + 1));
	}
}

function mime(path: string) {
	const ext = extname(path).toLowerCase();
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	return "image/jpeg";
}

function sessionIdForInput(input: string) {
	return `ksk-categorize:${relativeInputPath(input)}`.slice(0, 256);
}

function buildSellerTaxIdSummary(
	usage: unknown,
	extract: ExtractData,
	client: ClientContext,
) {
	const data = usage as {
		expense_hints?: Array<{
			account_code: string;
			sub_code: string;
			label: string;
			tax_ids?: Array<{ tax_id: string; count: number } | string>;
		}>;
	};
	const relevantTaxIds = [extract.seller?.tax_id, extract.buyer?.tax_id].filter(
		(taxId): taxId is string => !!taxId && taxId !== client.tax_id,
	);

	// Check if page is standalone service (no goods lines)
	const hasGoodsLines = extract.lines.some((line) => {
		const desc = (line.description || "").toLowerCase();
		return (
			desc &&
			!/^(ค่า)?(ขนส่ง|จัดส่ง|ส่ง|บริการ|ค่าบริการ|freight|delivery|shipping|service|fee)/i.test(
				desc,
			)
		);
	});
	const isStandaloneService = extract.lines.length > 0 && !hasGoodsLines;

	// Collect all hints where any relevant tax ID appears
	const matches: Array<{
		tax_id: string;
		account_code: string;
		label: string;
		count: number;
	}> = [];
	for (const hint of data.expense_hints || []) {
		for (const taxId of relevantTaxIds) {
			const entry = (hint.tax_ids || []).find(
				(item) => (typeof item === "string" ? item : item.tax_id) === taxId,
			);
			if (entry) {
				matches.push({
					tax_id: taxId,
					account_code: hint.account_code,
					label: hint.label,
					count: typeof entry === "string" ? 0 : entry.count,
				});
			}
		}
	}

	const lines = [
		"SELLER TAX ID SUMMARY (pre-computed — apply prompt rules to choose):",
	];
	if (matches.length === 0) {
		for (const taxId of relevantTaxIds) {
			lines.push(`Seller tax ID ${taxId} does NOT appear in any usage hints.`);
		}
		lines.push(
			"→ Fallback: categorize by keyword matching and economic substance.",
		);
	} else {
		matches.sort((a, b) => b.count - a.count);
		const grouped: Record<string, typeof matches> = {};
		for (const m of matches) {
			if (!grouped[m.tax_id]) grouped[m.tax_id] = [];
			grouped[m.tax_id].push(m);
		}
		for (const [taxId, entries] of Object.entries(grouped)) {
			if (entries.length === 1) {
				const e = entries[0];
				lines.push(
					`Seller tax ID ${taxId} → ${e.account_code} ${e.label} (used ${e.count} times) — only matching hint.`,
				);
			} else {
				lines.push(
					`Seller tax ID ${taxId} matches ${entries.length} hints (sorted by count):`,
				);
				for (const e of entries) {
					lines.push(`  ${e.account_code} ${e.label} — used ${e.count} times`);
				}
				const hasGoods = entries.some((e) =>
					/วัสดุ|สินค้า|ก่อสร้าง|ซื้อ/.test(e.label),
				);
				const hasDelivery = entries.some((e) =>
					/ขนส่ง|ไปรษณีย์|จัดส่ง|ส่ง/.test(e.label),
				);
				if (hasGoods && hasDelivery && isStandaloneService) {
					const deliveryEntry = entries.find((e) =>
						/ขนส่ง|ไปรษณีย์|จัดส่ง|ส่ง/.test(e.label),
					);
					if (deliveryEntry) {
						lines.push(
							`→ PAGE CHECK: This page has NO goods lines — only delivery/service. Rule 5a applies. Use ${deliveryEntry.account_code} (${deliveryEntry.label}) regardless of count.`,
						);
					}
				} else if (hasGoods && hasDelivery) {
					lines.push(
						`→ Page has goods lines → use highest-count goods account (Rule 5b: freight inherits goods).`,
					);
				} else {
					lines.push(
						`→ Per Rule 2b: use the highest-count account unless Rule 6 (vehicle electricity) applies.`,
					);
				}
			}
		}
	}
	return lines.join("\n");
}

function buildPrompt(args: {
	client: ClientContext;
	coaCsv: string;
	usageHints: unknown;
	gate: GateResult["gate"];
	extract: ExtractData;
	prompt: string;
}) {
	return [
		`Client context:\n${JSON.stringify(args.client, null, 2)}`,
		`COA CSV:\n${args.coaCsv}`,
		buildSellerTaxIdSummary(args.usageHints, args.extract, args.client),
		`Prior COA usage hints (background reference):\n${JSON.stringify(args.usageHints, null, 2)}`,
		`Gate result:\n${JSON.stringify(args.gate, null, 2)}`,
		`Extract result:\n${JSON.stringify(args.extract, null, 2)}`,
		args.prompt,
		"Return JSON only. Use exactly this top-level shape:",
		JSON.stringify(CATEGORIZE_OUTPUT_EXAMPLE, null, 2),
		"Return one categorize.lines item for every extract.lines item, using the original zero-based line_index.",
	].join("\n\n");
}

async function callOpenRouter<T>(args: {
	input: string;
	prompt: string;
	image?: string;
	model: string;
	useCache: boolean;
}): Promise<T> {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey)
		throw new Error(
			"Set OPENROUTER_API_KEY, or copy an env file to tools/ksk/.env",
		);
	const cacheControl = args.useCache
		? { type: "ephemeral" as const }
		: undefined;
	const content: Array<Record<string, unknown>> = [
		{ type: "text", text: `Source filename: ${basename(args.input)}` },
	];
	if (args.image) {
		content.push({
			type: "image_url",
			image_url: {
				url: `data:${mime(args.image)};base64,${readFileSync(args.image).toString("base64")}`,
			},
			...(cacheControl ? { cache_control: cacheControl } : {}),
		});
	}
	content.push({ type: "text", text: args.prompt });
	const body = {
		model: args.model,
		provider: {
			only: ["google-ai-studio"],
			allow_fallbacks: false,
		},
		temperature: 0,
		reasoning: { effort: "none" },
		session_id: sessionIdForInput(args.input),
		messages: [
			{
				role: "system",
				content:
					"You are a Thai accounting COA categorization model. Return JSON only.",
			},
			{ role: "user", content },
		],
		response_format: {
			type: "json_schema",
			json_schema: {
				name: "ksk_categorize_line_items",
				strict: true,
				schema: CATEGORIZE_SCHEMA,
			},
		},
		plugins: [{ id: "response-healing" }],
	};
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					"HTTP-Referer": "https://ksk-tools.local",
					"X-OpenRouter-Title": "ksk-categorize",
					"X-OpenRouter-Categories": "cli-agent",
				},
				body: JSON.stringify(body),
			});
			if (!res.ok)
				throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
			const data = await res.json();
			const content = data?.choices?.[0]?.message?.content;
			if (!content) throw new Error("OpenRouter returned empty content");
			const parsed = extractJson<T>(content) as T & { meta?: OpenRouterMeta };
			parsed.meta = {
				provider: data?.provider || null,
				cache_status: res.headers.get("x-openrouter-cache-status"),
				cached_tokens:
					data?.usage?.prompt_tokens_details?.cached_tokens ?? null,
				cache_write_tokens:
					data?.usage?.prompt_tokens_details?.cache_write_tokens ?? null,
				prompt_tokens: data?.usage?.prompt_tokens ?? null,
			};
			return parsed;
		} catch (error) {
			lastError = error;
			if (attempt < 2) await Bun.sleep(1000 * 2 ** attempt);
		}
	}
	throw lastError;
}

function validateCategorize(
	result: RawCategorizeResult,
	extract: ExtractData,
	coaByKey: Map<string, CoaRow>,
): CategorizeResult {
	const lines = result?.categorize?.lines;
	if (!Array.isArray(lines)) throw new Error("Invalid categorize result");
	// Allow model to return fewer lines than extract (e.g. skip balance-forward)
	if (lines.length > extract.lines.length)
		throw new Error(
			`Too many categorized lines: ${lines.length} > ${extract.lines.length}`,
		);
	const seen = new Set<number>();
	return {
		meta: result.meta,
		categorize: {
			lines: lines.map((line) => {
				const lineIndex = Number(line.line_index);
				if (
					!Number.isInteger(lineIndex) ||
					lineIndex < 0 ||
					lineIndex >= extract.lines.length
				)
					throw new Error(`Invalid line_index: ${line.line_index}`);
				if (seen.has(lineIndex))
					throw new Error(`Duplicate line_index: ${lineIndex}`);
				seen.add(lineIndex);
				const accountCode = String(line.account_code || "");
				const subCode = String(line.sub_code || "");
				const coa = coaByKey.get(accountKey(accountCode, subCode));
				if (!coa)
					throw new Error(
						`Unknown COA account: ${accountKey(accountCode, subCode)}`,
					);
				return {
					line_index: lineIndex,
					account_code: accountCode,
					sub_code: subCode,
					account_name_th: String(line.account_name_th || coa.name_th),
					confidence: (line.confidence ||
						"low") as CategorizeLine["confidence"],
					reason: String(line.reason || ""),
					needs_review: Boolean(line.needs_review),
				};
			}),
		},
	};
}

function outputSidecar(args: {
	input: string;
	gatePath: string;
	extractPath: string;
	gate: GateResult["gate"];
	extract: ExtractData;
	categorize: CategorizeResult;
}) {
	const linesByIndex = new Map(
		args.categorize.categorize.lines.map((line) => [line.line_index, line]),
	);
	return {
		source: {
			gate: basename(args.gatePath),
			extract: basename(args.extractPath),
		},
		page: {
			doc_kind: args.extract.doc_kind,
			group: args.gate.group,
			document_date: args.extract.document_date,
			document_no: args.extract.document_no,
			reference_no: args.extract.reference_no,
			seller: args.extract.seller,
			buyer: args.extract.buyer,
			vat_treatment: args.extract.vat_treatment,
			amounts: args.extract.amounts,
			summary: args.extract.summary,
		},
		categorize: {
			version: 1,
			doc_kind: args.extract.doc_kind,
			group: args.gate.group,
			lines: args.extract.lines.map((line, index) => ({
				line_index: index,
				description: line.description,
				qty: line.qty,
				unit: line.unit,
				unit_price: line.unit_price,
				amount: line.amount,
				amount_includes_vat: line.amount_includes_vat,
				...linesByIndex.get(index),
			})),
		},
		categorize_meta: args.categorize.meta ?? null,
	};
}

async function runPool<T>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<void>,
) {
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		async () => {
			while (next < items.length) {
				const item = items[next++];
				await worker(item);
			}
		},
	);
	await Promise.all(workers);
}

async function main() {
	loadEnvFile(join(TOOL_DIR, ".env"));
	loadEnvFile(join(process.cwd(), ".env"));
	const args = parseArgs(Bun.argv.slice(2));
	const inputs = args.inputs.flatMap(discover).slice(0, args.maxFiles);
	const prompt = readFileSync(
		join(TOOL_DIR, "prompts", "categorize-line_items.v1.txt"),
		"utf8",
	).trim();
	const results: Array<{
		input: string;
		output: string;
		status: string;
		error?: string;
		skipped_reason?: string;
	}> = [];
	await runPool(inputs, args.concurrency, async (input) => {
		const output = outputPath(input, args.outDir);
		if (existsSync(output) && !args.force && !args.dryRun) {
			results.push({ input, output, status: "skipped" });
			return;
		}
		const gatePath = siblingPath(input, ".gate.json");
		if (!existsSync(gatePath)) {
			results.push({
				input,
				output,
				status: "skipped",
				skipped_reason: "missing_gate",
			});
			return;
		}
		const sidecar = readJson<ExtractSidecar>(input);
		const gate = readJson<GateResult>(gatePath).gate || sidecar.gate;
		const extract = sidecar.extract;
		if (!gate?.usable || gate.group === "unknown") {
			results.push({
				input,
				output,
				status: "skipped",
				skipped_reason: "unknown_or_unusable",
			});
			return;
		}
		if (!extract?.lines?.length) {
			results.push({
				input,
				output,
				status: "skipped",
				skipped_reason: "no_extract_lines",
			});
			return;
		}
		if (args.dryRun) {
			results.push({ input, output, status: "dry_run" });
			return;
		}
		try {
			const clientPath = args.clientPath
				? resolveInput(args.clientPath)
				: findClientPath(input);
			if (!clientPath || !existsSync(clientPath))
				throw new Error(`missing client.json for ${input}`);
			const client = readJson<ClientContext>(clientPath);
			const coaCsvPath = resolveInput(
				args.coaCsvPath ||
					resolveClientFile(clientPath, client.coa_csv, "coa.csv"),
			);
			const coaUsagePath = resolveInput(
				args.coaUsagePath ||
					resolveClientFile(clientPath, client.coa_usage, "coa_usage.json"),
			);
			if (!existsSync(coaCsvPath))
				throw new Error(`missing COA CSV: ${coaCsvPath}`);
			const coaRows = loadCoaRows(coaCsvPath);
			const coaByKey = new Map(
				coaRows.map((row) => [accountKey(row.account_code, row.sub_code), row]),
			);
			const coaUsage = existsSync(coaUsagePath)
				? readJson<unknown>(coaUsagePath)
				: null;
			const pagePrompt = buildPrompt({
				client,
				coaCsv: toCoaCsv(coaRows),
				usageHints: relevantUsageHints(coaUsage, extract, client),
				gate,
				extract,
				prompt,
			});
			let categorize: CategorizeResult | null = null;
			let lastCategorizeError: Error | null = null;
			for (let attempt = 0; attempt < 3 && !categorize; attempt++) {
				try {
					const raw = await callOpenRouter<RawCategorizeResult>({
						input,
						prompt: pagePrompt,
						image:
							extract.doc_kind === "bank_statement"
								? imageForExtract(input)
								: undefined,
						model: args.model,
						useCache: !args.noCache,
					});
					categorize = validateCategorize(raw, extract, coaByKey);
				} catch (error) {
					lastCategorizeError = error as Error;
					if (attempt < 2) await Bun.sleep(1000 * 2 ** attempt);
				}
			}
			if (!categorize) throw lastCategorizeError;
			mkdirSync(dirname(output), { recursive: true });
			writeFileSync(
				output,
				JSON.stringify(
					outputSidecar({
						input,
						gatePath,
						extractPath: input,
						gate,
						extract,
						categorize,
					}),
					null,
					2,
				) + "\n",
			);
			results.push({ input, output, status: "written" });
		} catch (error) {
			results.push({
				input,
				output,
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
	const summary = {
		total: results.length,
		written: results.filter((r) => r.status === "written").length,
		skipped: results.filter((r) => r.status === "skipped").length,
		failed: results.filter((r) => r.status === "failed").length,
		dry_run: results.filter((r) => r.status === "dry_run").length,
		results,
	};
	console.log(JSON.stringify(summary, null, 2));
	process.exit(summary.failed ? 1 : 0);
}

main();
