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

type GateResult = {
	meta?: {
		provider?: string | null;
		cache_status?: string | null;
		cached_tokens?: number | null;
		cache_write_tokens?: number | null;
		prompt_tokens?: number | null;
	};
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
		unusable_kind?: UnusableKind;
		reason: string;
	};
};

const GATE_SCHEMA = {
	type: "object",
	properties: {
		gate: {
			type: "object",
			properties: {
				usable: { type: "boolean" },
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
				completeness: {
					type: "string",
					enum: [
						"standalone",
						"first_page",
						"middle_page",
						"last_page",
						"unknown",
					],
				},
				confidence: { type: "string", enum: ["low", "medium", "high"] },
				group: {
					type: "string",
					enum: [
						"income_vat",
						"income_nonvat",
						"expense_vat",
						"expense_nonvat",
						"bank_statement",
						"unknown",
					],
				},
				unusable_kind: {
					type: "string",
					enum: [
						"blank_or_separator",
						"cover_or_index",
						"non_accounting_document",
						"payment_confirmation",
						"unreadable_or_cutoff",
						"duplicate_capture",
						"unknown",
					],
				},
				reason: { type: "string" },
			},
			required: [
				"usable",
				"doc_kind",
				"completeness",
				"confidence",
				"group",
				"unusable_kind",
				"reason",
			],
		},
	},
	required: ["gate"],
} as const;

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
		) {
			value = value.slice(1, -1);
		}
		process.env[key] = value;
	}
}

function usage(): never {
	console.error(`Usage: bun run gate -- [options] <image-or-dir> [...]

Options:
  --out-dir DIR       Write *.gate.json under DIR, preserving input paths
  --force             Overwrite existing gate files
  --max-images N      Limit discovered images
  --model MODEL       OpenRouter model (default: ${DEFAULT_MODEL})
  --no-cache          Do not send OpenRouter cache_control markers
  --dry-run           Print planned outputs without API calls
  --majority N        Run N times and take modal result (default: 1)
`);
	process.exit(2);
}

function parseArgs(argv: string[]) {
	const args = {
		inputs: [] as string[],
		outDir: undefined as string | undefined,
		force: false,
		maxImages: undefined as number | undefined,
		model: DEFAULT_MODEL,
		noCache: false,
		dryRun: false,
		majority: 1,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--out-dir") args.outDir = argv[++i];
		else if (arg === "--force") args.force = true;
		else if (arg === "--dry-run") args.dryRun = true;
		else if (arg === "--max-images") args.maxImages = Number(argv[++i]);
		else if (arg === "--model") args.model = argv[++i];
		else if (arg === "--no-cache") args.noCache = true;
		else if (arg === "--majority") args.majority = Number(argv[++i]);
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

function outputPath(input: string, outDir?: string) {
	const parsed = input.replace(/\.[^.]+$/, ".gate.json");
	if (!outDir) return parsed;
	const rel = input.startsWith(PROJECT_ROOT + "/")
		? relative(PROJECT_ROOT, input)
		: relative(process.cwd(), input);
	return join(resolve(outDir), rel.replace(/\.[^.]+$/, ".gate.json"));
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
	const rel = input.startsWith(PROJECT_ROOT + "/")
		? relative(PROJECT_ROOT, input)
		: relative(process.cwd(), input);
	return `ksk:${rel}`.slice(0, 256);
}

function mime(path: string) {
	const ext = extname(path).toLowerCase();
	if (ext === ".png") return "image/png";
	if (ext === ".webp") return "image/webp";
	return "image/jpeg";
}

function extractJson(text: string): GateResult {
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

function validate(result: GateResult) {
	const gate = result?.gate;
	if (
		!gate ||
		typeof gate.usable !== "boolean" ||
		typeof gate.reason !== "string" ||
		typeof gate.unusable_kind !== "string"
	)
		throw new Error("Invalid gate result");
}

function normalizeGate(result: GateResult) {
	const gate = result.gate;
	if (gate.usable !== true) {
		gate.group = "unknown";
		return result;
	}
	if (gate.doc_kind === "bank_statement") {
		gate.group = "bank_statement";
	}
	return result;
}

// ponytail: modal vote stabilizes non-deterministic vision results
function modal<T>(values: T[]): T {
	const counts = new Map<string, { value: T; count: number }>();
	for (const v of values) {
		const key = JSON.stringify(v);
		const entry = counts.get(key);
		if (entry) entry.count++;
		else counts.set(key, { value: v, count: 1 });
	}
	let best = values[0];
	let bestCount = 0;
	for (const entry of counts.values()) {
		if (entry.count > bestCount) {
			best = entry.value;
			bestCount = entry.count;
		}
	}
	return best;
}

function majorityVote(results: GateResult[]): GateResult {
	if (results.length === 1) return results[0];
	const gates = results.map((r) => r.gate);
	const voted: GateResult["gate"] = {
		usable: modal(gates.map((g) => g.usable)),
		doc_kind: modal(gates.map((g) => g.doc_kind)),
		completeness: modal(gates.map((g) => g.completeness)),
		confidence: modal(gates.map((g) => g.confidence)),
		group: modal(gates.map((g) => g.group)),
		unusable_kind: modal(gates.map((g) => g.unusable_kind)),
		reason: gates[0].reason,
	};
	// Pick reason from a run that matches the voted result
	for (const r of results) {
		const g = r.gate;
		if (
			g.usable === voted.usable &&
			g.doc_kind === voted.doc_kind &&
			g.group === voted.group
		) {
			voted.reason = g.reason;
			break;
		}
	}
	return { gate: voted };
}

async function callOpenRouter(
	input: string,
	prompt: string,
	model: string,
	useCache: boolean,
): Promise<GateResult> {
	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey)
		throw new Error(
			"Set OPENROUTER_API_KEY, or copy skills/ksk-extract/.env to tools/ksk/.env",
		);

	const imageUrl = `data:${mime(input)};base64,${readFileSync(input).toString("base64")}`;
	const clientContext = readClientContextBlock(input);
	const cacheControl = useCache ? { type: "ephemeral" as const } : undefined;
	const promptText = [clientContext, prompt, `Source filename: ${basename(input)}`, "Return JSON only."]
		.filter(Boolean)
		.join("\n\n");
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
				role: "user",
				content: [
					{
						type: "text",
						text: promptText,
					},
					{
						type: "image_url",
						image_url: { url: imageUrl },
						...(cacheControl ? { cache_control: cacheControl } : {}),
					},
				],
			},
		],
		response_format: {
			type: "json_schema",
			json_schema: { name: "ksk_gate", strict: true, schema: GATE_SCHEMA },
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
					"X-OpenRouter-Title": "ksk-gate",
					"X-OpenRouter-Categories": "cli-agent",
				},
				body: JSON.stringify(body),
			});
			if (!res.ok)
				throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
			const data = await res.json();
			const content = data?.choices?.[0]?.message?.content;
			if (!content) throw new Error("OpenRouter returned empty content");
			const parsed = normalizeGate(extractJson(content));
			validate(parsed);
			parsed.meta = {
				provider: data?.provider || null,
				cache_status: res.headers.get("x-openrouter-cache-status"),
				cached_tokens: data?.usage?.prompt_tokens_details?.cached_tokens ?? null,
				cache_write_tokens: data?.usage?.prompt_tokens_details?.cache_write_tokens ?? null,
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

async function main() {
  loadEnvFile(join(TOOL_DIR, ".env"));
  loadEnvFile(join(PROJECT_ROOT, "skills/ksk-extract/.env"));
  loadEnvFile(join(process.cwd(), ".env"));
	const args = parseArgs(Bun.argv.slice(2));
	const prompt = readFileSync(join(TOOL_DIR, "prompts/gate.v4.txt"), "utf8");
	const inputs = args.inputs.flatMap(discover).slice(0, args.maxImages);

	const results = [] as Array<{
		input: string;
		output: string;
		status: string;
		error?: string;
	}>;
	for (const input of inputs) {
		const output = outputPath(input, args.outDir);
		if (existsSync(output) && !args.force && !args.dryRun) {
			results.push({ input, output, status: "skipped" });
			continue;
		}
		if (args.dryRun) {
			results.push({ input, output, status: "dry_run" });
			continue;
		}
		try {
			const n = Math.max(1, args.majority);
			const calls: Promise<GateResult>[] = [];
			for (let i = 0; i < n; i++) {
				calls.push(callOpenRouter(input, prompt, args.model, !args.noCache));
			}
			const allResults = await Promise.all(calls);
			const result = majorityVote(allResults);
			if (n > 1) {
				(result as Record<string, unknown>).meta = {
					majority_runs: n,
					individual_results: allResults.map((r) => ({
						usable: r.gate.usable,
						doc_kind: r.gate.doc_kind,
						group: r.gate.group,
					})),
				};
			}
			mkdirSync(dirname(output), { recursive: true });
			writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
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
