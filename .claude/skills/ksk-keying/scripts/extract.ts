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
const PROJECT_ROOT = resolve(TOOL_DIR, "../../../..");
const DEFAULT_MODEL = "google/gemini-2.5-flash";
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

type GateDocKind =
	| "handwritten_bill"
	| "pwa_bill"
	| "pea_bill"
	| "global_house_invoice"
	| "normal_bill_or_invoice"
	| "bank_statement"
	| "wht_certificate"
	| "credit_note"
	| "debit_note"
	| "purchase_order"
	| "quotation"
	| "delivery_note"
	| "unknown";

type UnusableKind =
	| "blank_or_separator"
	| "cover_or_index"
	| "non_accounting_document"
	| "payment_confirmation"
	| "unreadable_or_cutoff"
	| "duplicate_capture"
	| "unknown";

type OpenRouterMeta = {
	provider?: string | null;
	cache_status?: string | null;
	cached_tokens?: number | null;
	cache_write_tokens?: number | null;
	prompt_tokens?: number | null;
};

type GateResult = {
	meta?: OpenRouterMeta;
	gate: {
		usable: boolean;
		doc_kind: GateDocKind;
		completeness:
			| "standalone"
			| "first_page"
			| "middle_page"
			| "last_page"
			| "unknown";
		confidence: "low" | "medium" | "high";
		group:
			| "income_vat"
			| "income_nonvat"
			| "expense_vat"
			| "expense_nonvat"
			| "bank_statement"
			| "unknown";
		unusable_kind: UnusableKind;
		reason: string;
	};
};

type ExtractDocKind = Extract<
	GateDocKind,
	| "handwritten_bill"
	| "pwa_bill"
	| "pea_bill"
	| "global_house_invoice"
	| "normal_bill_or_invoice"
	| "bank_statement"
	| "wht_certificate"
	| "credit_note"
	| "debit_note"
	| "purchase_order"
	| "quotation"
	| "delivery_note"
	| "unknown"
>;

type ExtractData = {
	doc_kind: ExtractDocKind;
	confidence: "low" | "medium" | "high";
	document_date: string | null;
	document_no: string | null;
	reference_no: string | null;
	seller: { name: string | null; tax_id: string | null };
	buyer: { name: string | null; tax_id: string | null };
	vat_treatment: 7 | 0 | null;
	amounts: {
		pre_vat_total: number | null;
		vat: number | null;
		gross_total: number | null;
		wht: number | null;
		net_payable: number | null;
	};
	summary: string | null;
	lines: Array<{
		description: string | null;
		qty: number | null;
		unit: string | null;
		unit_price: number | null;
		amount: number | null;
		amount_includes_vat: boolean | null;
	}>;
};

type ExtractResult = {
	meta?: OpenRouterMeta;
	extract: ExtractData;
};

type RawExtractResult = {
	meta?: OpenRouterMeta;
	extract: ExtractData | { extract?: ExtractData };
};

const EXTRACT_OUTPUT_EXAMPLE = {
	extract: {
		doc_kind: "normal_bill_or_invoice",
		confidence: "medium",
		document_date: null,
		document_no: null,
		reference_no: null,
		seller: { name: null, tax_id: null },
		buyer: { name: null, tax_id: null },
		vat_treatment: null,
		amounts: {
			pre_vat_total: null,
			vat: null,
			gross_total: null,
			wht: null,
			net_payable: null,
		},
		summary: null,
		lines: [
			{
				description: null,
				qty: null,
				unit: null,
				unit_price: null,
				amount: null,
				amount_includes_vat: null,
			},
		],
	},
};

const EXTRACT_SCHEMA = {
	type: "object",
	properties: {
		extract: {
			type: "object",
			properties: {
				doc_kind: {
					type: "string",
					enum: [
						"handwritten_bill",
						"pwa_bill",
						"pea_bill",
						"global_house_invoice",
						"normal_bill_or_invoice",
						"bank_statement",
						"wht_certificate",
						"credit_note",
						"debit_note",
						"purchase_order",
						"quotation",
						"delivery_note",
						"unknown",
					],
				},
				confidence: { type: "string", enum: ["low", "medium", "high"] },
				document_date: { type: ["string", "null"] },
				document_no: { type: ["string", "null"] },
				reference_no: { type: ["string", "null"] },
				seller: {
					type: "object",
					properties: {
						name: { type: ["string", "null"] },
						tax_id: { type: ["string", "null"] },
					},
					required: ["name", "tax_id"],
				},
				buyer: {
					type: "object",
					properties: {
						name: { type: ["string", "null"] },
						tax_id: { type: ["string", "null"] },
					},
					required: ["name", "tax_id"],
				},
				vat_treatment: { type: ["integer", "null"], enum: [7, 0, null] },
				amounts: {
					type: "object",
					properties: {
						pre_vat_total: { type: ["number", "string", "null"] },
						vat: { type: ["number", "string", "null"] },
						gross_total: { type: ["number", "string", "null"] },
						wht: { type: ["number", "string", "null"] },
						net_payable: { type: ["number", "string", "null"] },
					},
					required: [
						"pre_vat_total",
						"vat",
						"gross_total",
						"wht",
						"net_payable",
					],
				},
				summary: { type: ["string", "null"] },
				lines: {
					type: "array",
					items: {
						type: "object",
						properties: {
							description: { type: ["string", "null"] },
							qty: { type: ["number", "string", "null"] },
							unit: { type: ["string", "null"] },
							unit_price: { type: ["number", "string", "null"] },
							amount: { type: ["number", "string", "null"] },
							amount_includes_vat: { type: ["boolean", "null"] },
						},
						required: [
							"description",
							"qty",
							"unit",
							"unit_price",
							"amount",
							"amount_includes_vat",
						],
					},
				},
			},
			required: [
				"doc_kind",
				"confidence",
				"document_date",
				"document_no",
				"reference_no",
				"seller",
				"buyer",
				"vat_treatment",
				"amounts",
				"summary",
				"lines",
			],
		},
	},
	required: ["extract"],
} as const;

const PROMPT_BY_DOC_KIND: Record<ExtractData["doc_kind"], string> = {
	handwritten_bill: "extract-handwritten_bill.v1.txt",
	pwa_bill: "extract-pwa_bill.v1.txt",
	pea_bill: "extract-pea_bill.v1.txt",
	global_house_invoice: "extract-global_house_invoice.v1.txt",
	normal_bill_or_invoice: "extract-normal_bill_or_invoice.v1.txt",
	bank_statement: "extract-bank_statement.v1.txt",
	wht_certificate: "extract-wht_certificate.v1.txt",
	credit_note: "extract-generic_accounting_document.v1.txt",
	debit_note: "extract-generic_accounting_document.v1.txt",
	purchase_order: "extract-generic_accounting_document.v1.txt",
	quotation: "extract-generic_accounting_document.v1.txt",
	delivery_note: "extract-delivery_note.v1.txt",
	unknown: "extract-generic_accounting_document.v1.txt",
};

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

function usage(): never {
	console.error(`Usage: bun run extract -- [options] <image-or-dir> [...]

Options:
  --out-dir DIR       Write *.extract.json under DIR, preserving input paths
  --gate PATH         Read one existing *.gate.json for a single image input
  --gate-dir DIR      Read existing *.gate.json under DIR, preserving input paths
  --force             Overwrite existing extract files
  --max-images N      Limit discovered images
  --model MODEL       OpenRouter model (default: ${DEFAULT_MODEL})
  --no-cache          Do not send OpenRouter cache_control markers
  --dry-run           Print planned outputs without API calls\n`);
	process.exit(2);
}

function parseArgs(argv: string[]) {
	const args = {
		inputs: [] as string[],
		outDir: undefined as string | undefined,
		gatePath: undefined as string | undefined,
		gateDir: undefined as string | undefined,
		force: false,
		maxImages: undefined as number | undefined,
		model: DEFAULT_MODEL,
		noCache: false,
		dryRun: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--out-dir") args.outDir = argv[++i];
		else if (arg === "--gate") args.gatePath = argv[++i];
		else if (arg === "--gate-dir") args.gateDir = argv[++i];
		else if (arg === "--force") args.force = true;
		else if (arg === "--dry-run") args.dryRun = true;
		else if (arg === "--max-images") args.maxImages = Number(argv[++i]);
		else if (arg === "--model") args.model = argv[++i];
		else if (arg === "--no-cache") args.noCache = true;
		else if (arg === "--help" || arg === "-h") usage();
		else if (arg.startsWith("--")) usage();
		else args.inputs.push(arg);
	}
	if (!args.inputs.length) usage();
	if (
		args.maxImages !== undefined &&
		(!Number.isInteger(args.maxImages) || args.maxImages < 1)
	)
		usage();
	if (args.gatePath && args.gateDir) usage();
	return args;
}

function resolveInput(input: string) {
	const path = resolve(input);
	if (existsSync(path)) return path;
	const fromRoot = resolve(PROJECT_ROOT, input);
	if (existsSync(fromRoot)) return fromRoot;
	return path;
}

function discover(input: string): string[] {
	const path = resolveInput(input);
	if (!existsSync(path)) throw new Error(`Missing input: ${input}`);
	const st = statSync(path);
	if (st.isFile())
		return IMAGE_EXTS.has(extname(path).toLowerCase()) ? [path] : [];
	const out: string[] = [];
	const stack = [path];
	while (stack.length) {
		const dir = stack.pop()!;
		for (const name of readdirSync(dir).sort()) {
			const child = join(dir, name);
			const childSt = statSync(child);
			if (childSt.isDirectory()) stack.push(child);
			else if (childSt.isFile() && IMAGE_EXTS.has(extname(child).toLowerCase()))
				out.push(child);
		}
	}
	return out.sort();
}

function relativeInputPath(input: string) {
	return input.startsWith(PROJECT_ROOT + "/")
		? relative(PROJECT_ROOT, input)
		: relative(process.cwd(), input);
}

function outputPath(input: string, outDir?: string) {
	const parsed = input.replace(/\.[^.]+$/, ".extract.json");
	if (!outDir) return parsed;
	return join(
		resolve(outDir),
		relativeInputPath(input).replace(/\.[^.]+$/, ".extract.json"),
	);
}

function gatePathForInput(input: string, gateDir?: string) {
	const parsed = input.replace(/\.[^.]+$/, ".gate.json");
	if (!gateDir) return parsed;
	return join(
		resolve(gateDir),
		relativeInputPath(input).replace(/\.[^.]+$/, ".gate.json"),
	);
}

function loadGateResult(path: string) {
	return JSON.parse(readFileSync(resolveInput(path), "utf8")) as GateResult;
}

function loadGateForInput(input: string, gatePath?: string, gateDir?: string) {
	if (gatePath) return loadGateResult(gatePath);
	const path = gatePathForInput(input, gateDir);
	return existsSync(path) ? loadGateResult(path) : undefined;
}

function findClientContextPath(input: string) {
	let dir = statSync(input).isDirectory() ? input : dirname(input);
	while (dir.startsWith(PROJECT_ROOT)) {
		const candidate = join(dir, "client.json");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function readClientContextBlock(input: string) {
	const path = findClientContextPath(input);
	if (!path) return "";
	const raw = readFileSync(path, "utf8").trim();
	if (!raw) return "";
	return `Client context (routing hint only; visible document content wins):\n${raw}`;
}

function sessionIdForInput(input: string) {
	return `ksk:${relativeInputPath(input)}`.slice(0, 256);
}

function mime(path: string) {
	const ext = extname(path).toLowerCase();
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	return "image/jpeg";
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

function readPrompt(name: string) {
	return readFileSync(join(TOOL_DIR, "prompts", name), "utf8");
}

async function callOpenRouter<T>(
	input: string,
	prompt: string,
	model: string,
	useCache: boolean,
	schemaName?: string,
	schema?: object,
): Promise<T> {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey)
		throw new Error(
			"Set OPENROUTER_API_KEY, or copy skills/ksk-extract/.env to .claude/skills/ksk-keying/scripts/.env",
		);
	const imageUrl = `data:${mime(input)};base64,${readFileSync(input).toString("base64")}`;
	const clientContext = readClientContextBlock(input);
	const cacheControl = useCache ? { type: "ephemeral" as const } : undefined;
	const body = {
		model,
		provider: {
			only: ["google-ai-studio"],
			allow_fallbacks: false,
		},
		temperature: 0,
		reasoning: { effort: "none" },
		session_id: sessionIdForInput(input),
		messages: [
			{
				role: "system",
				content:
					"You are a Thai accounting document vision model. Reuse the shared image/context prefix across requests when possible. Return JSON only.",
			},
			{
				role: "user",
				content: [
					...(clientContext ? [{ type: "text", text: clientContext }] : []),
					{
						type: "text",
						text: `Source filename: ${basename(input)}`,
					},
					{
						type: "image_url",
						image_url: { url: imageUrl },
						...(cacheControl ? { cache_control: cacheControl } : {}),
					},
					{
						type: "text",
						text: `${prompt}\n\nReturn JSON only.`,
					},
				],
			},
		],
		response_format:
			schemaName && schema
				? {
						type: "json_schema",
						json_schema: { name: schemaName, strict: true, schema },
					}
				: { type: "json_object" },
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
					"X-OpenRouter-Title": "ksk-extract",
					"X-OpenRouter-Categories": "cli-agent",
				},
				body: JSON.stringify(body),
			});
			if (!res.ok)
				throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
			const data = await res.json();
			const content = data?.choices?.[0]?.message?.content;
			if (!content) throw new Error("OpenRouter returned empty content");
			const parsed = extractJson<T>(content) as T & {
				meta?: ExtractResult["meta"];
			};
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

function toNumberOrNull(value: unknown) {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string") {
		const n = Number(value.replace(/,/g, "").trim());
		return Number.isFinite(n) ? n : null;
	}
	return null;
}

function validateGate(result: GateResult) {
	const gate = result?.gate;
	if (
		!gate ||
		typeof gate.usable !== "boolean" ||
		typeof gate.reason !== "string" ||
		typeof gate.unusable_kind !== "string"
	)
		throw new Error("Invalid gate result");
}

function validateExtract(result: RawExtractResult): ExtractResult {
	const outer = result?.extract;
	const raw =
		outer && "extract" in outer
			? outer.extract
			: (outer as Partial<ExtractData> | undefined);
	if (
		!raw ||
		typeof raw.doc_kind !== "string" ||
		typeof raw.confidence !== "string"
	)
		throw new Error("Invalid extract result");
	const amounts = (raw.amounts ?? {}) as Partial<ExtractData["amounts"]>;
	const lines = Array.isArray(raw.lines) ? raw.lines : [];
	return {
		meta: result.meta,
		extract: {
			doc_kind: raw.doc_kind as ExtractData["doc_kind"],
			confidence: raw.confidence as ExtractData["confidence"],
			document_date: raw.document_date ?? null,
			document_no: raw.document_no ?? null,
			reference_no: raw.reference_no ?? null,
			seller: {
				name: raw.seller?.name ?? null,
				tax_id: raw.seller?.tax_id ?? null,
			},
			buyer: {
				name: raw.buyer?.name ?? null,
				tax_id: raw.buyer?.tax_id ?? null,
			},
			vat_treatment: raw.vat_treatment ?? null,
			amounts: {
				pre_vat_total: toNumberOrNull(amounts.pre_vat_total),
				vat: toNumberOrNull(amounts.vat),
				gross_total: toNumberOrNull(amounts.gross_total),
				wht: toNumberOrNull(amounts.wht),
				net_payable: toNumberOrNull(amounts.net_payable),
			},
			summary: raw.summary ?? null,
			lines: lines.map((line: Partial<ExtractData["lines"][number]>) => ({
				description: line.description ?? null,
				qty: toNumberOrNull(line.qty),
				unit: line.unit ?? null,
				unit_price: toNumberOrNull(line.unit_price),
				amount: toNumberOrNull(line.amount),
				amount_includes_vat: line.amount_includes_vat ?? null,
			})),
		},
	};
}

async function extractOne(
	input: string,
	model: string,
	gate: GateResult,
	useCache: boolean,
): Promise<{ gate: GateResult; extract?: ExtractResult }> {
	validateGate(gate);
	if (!gate.gate.usable || !(gate.gate.doc_kind in PROMPT_BY_DOC_KIND))
		return { gate };
	const promptName = PROMPT_BY_DOC_KIND[gate.gate.doc_kind as ExtractDocKind];
	const extractPrompt = `${readPrompt(promptName)}\n\nReturn JSON only. Use exactly this top-level shape, filling missing values with null instead of omitting keys:\n${JSON.stringify(EXTRACT_OUTPUT_EXAMPLE, null, 2)}\n\nGate result:\n${JSON.stringify(gate.gate, null, 2)}\n\nUse gate.doc_kind exactly. Do not re-extract into another doc kind.`;
	const extract = validateExtract(
		await callOpenRouter<RawExtractResult>(
			input,
			extractPrompt,
			model,
			useCache,
		),
	);
	return { gate, extract };
}

async function main() {
	loadEnvFile(join(TOOL_DIR, ".env"));
	loadEnvFile(join(PROJECT_ROOT, "skills/ksk-extract/.env"));
	loadEnvFile(join(process.cwd(), ".env"));
	const args = parseArgs(Bun.argv.slice(2));
	const inputs = args.inputs.flatMap(discover).slice(0, args.maxImages);
	const results: Array<{
		input: string;
		output: string;
		status: string;
		error?: string;
		skipped_reason?: string;
	}> = [];
	for (const input of inputs) {
		const output = outputPath(input, args.outDir);
		const gate = loadGateForInput(input, args.gatePath, args.gateDir);
		if (existsSync(output) && !args.force && !args.dryRun) {
			results.push({ input, output, status: "skipped" });
			continue;
		}
		if (args.dryRun) {
			results.push({ input, output, status: "dry_run" });
			continue;
		}
		if (!gate) {
			results.push({
				input,
				output,
				status: "skipped",
				skipped_reason: "missing_gate",
			});
			continue;
		}
		try {
			const result = await extractOne(input, args.model, gate, !args.noCache);
			if (!result.extract) {
				results.push({
					input,
					output,
					status: "skipped",
					skipped_reason: `${result.gate.gate.doc_kind}:${String(result.gate.gate.usable)}`,
				});
				continue;
			}
			mkdirSync(dirname(output), { recursive: true });
			writeFileSync(
				output,
				JSON.stringify(
					{
						gate: result.gate.gate,
						gate_meta: result.gate.meta ?? null,
						extract: result.extract.extract,
						extract_meta: result.extract.meta ?? null,
					},
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
	}
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
