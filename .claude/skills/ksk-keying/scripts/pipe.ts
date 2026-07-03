import { dirname, extname, join, resolve } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";

const TOOL_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(TOOL_DIR, "../../../..");
const DEFAULT_MODEL = "google/gemini-2.5-flash";
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function usage(): never {
	console.error(`Usage: bun run pipe -- [options] <image-or-dir> [...]

Options:
  --out-dir DIR       Write *.gate.json and *.extract.json under DIR
  --force             Overwrite existing outputs
  --max-images N      Limit discovered images
  --concurrency N     Process N pages concurrently (default: 1; higher may reduce cache hits)
  --model MODEL       OpenRouter model (default: ${DEFAULT_MODEL})
  --no-cache          Do not send OpenRouter cache_control markers
  --dry-run           Print planned outputs without API calls\n`);
	process.exit(2);
}

function parseArgs(argv: string[]) {
	const args = {
		inputs: [] as string[],
		outDir: undefined as string | undefined,
		force: false,
		maxImages: undefined as number | undefined,
		concurrency: 1,
		model: DEFAULT_MODEL,
		noCache: false,
		dryRun: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--out-dir") args.outDir = argv[++i];
		else if (arg === "--force") args.force = true;
		else if (arg === "--dry-run") args.dryRun = true;
		else if (arg === "--max-images") args.maxImages = Number(argv[++i]);
		else if (arg === "--concurrency") args.concurrency = Number(argv[++i]);
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

function sharedArgs(args: ReturnType<typeof parseArgs>) {
	const out = [] as string[];
	if (args.outDir) out.push("--out-dir", args.outDir);
	if (args.force) out.push("--force");
	if (args.dryRun) out.push("--dry-run");
	if (args.model !== DEFAULT_MODEL) out.push("--model", args.model);
	if (args.noCache) out.push("--no-cache");
	return out;
}

async function runStep(name: string, script: string, argv: string[]) {
	const BunRuntime = Bun as typeof Bun & {
		spawn(
			args: string[],
			options: { stdin: "inherit"; stdout: "inherit"; stderr: "inherit" },
		): { exited: Promise<number> };
	};
	const proc = BunRuntime.spawn(
		["bun", "run", join(TOOL_DIR, script), "--", ...argv],
		{
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		},
	);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`${name} failed with exit code ${code}`);
}

async function runImage(input: string, shared: string[], outDir?: string) {
	await runStep("gate", "gate.ts", [...shared, input]);
	const extractArgs = outDir
		? [...shared, "--gate-dir", outDir, input]
		: [...shared, input];
	await runStep("extract", "extract.ts", extractArgs);
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
	const args = parseArgs(Bun.argv.slice(2));
	const shared = sharedArgs(args);
	const images = args.inputs
		.flatMap(discover)
		.slice(0, args.maxImages);

	await runPool(images, args.concurrency, (input) =>
		runImage(input, shared, args.outDir),
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
