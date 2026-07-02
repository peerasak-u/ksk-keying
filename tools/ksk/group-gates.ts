import { dirname, join, relative, resolve } from "node:path";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";

const TOOL_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(TOOL_DIR, "../..");

const GROUPS = new Set([
	"income_vat",
	"income_nonvat",
	"expense_vat",
	"expense_nonvat",
	"bank_statement",
	"unknown",
]);
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp"];

type Args = { pagesDir: string; outDir?: string; force: boolean };

function usage(): never {
	console.error(`Usage: bun run group-gates -- [options] <_pages-dir>

Options:
  --out-dir DIR  Grouped view dir (default: sibling _gate_groups)
  --force        Recreate output dir
`);
	process.exit(2);
}

function parseArgs(argv: string[]): Args {
	const args: Args = { pagesDir: "", force: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--out-dir") args.outDir = argv[++i];
		else if (arg === "--force") args.force = true;
		else if (arg === "--help" || arg === "-h") usage();
		else if (arg.startsWith("--")) usage();
		else if (!args.pagesDir) args.pagesDir = arg;
		else usage();
	}
	if (!args.pagesDir) usage();
	return args;
}

function discoverGates(dir: string) {
	const out: string[] = [];
	const stack = [dir];
	while (stack.length) {
		const current = stack.pop()!;
		for (const name of readdirSync(current).sort()) {
			const child = join(current, name);
			const st = statSync(child);
			if (st.isDirectory()) stack.push(child);
			else if (st.isFile() && name.endsWith(".gate.json")) out.push(child);
		}
	}
	return out.sort();
}

function stemForGate(gate: string) {
	return gate.slice(0, -".gate.json".length);
}

function imageForGate(gate: string) {
	return IMAGE_EXTS.map((ext) => stemForGate(gate) + ext).find(existsSync);
}

function link(src: string, dest: string) {
	mkdirSync(dirname(dest), { recursive: true });
	if (existsSync(dest)) rmSync(dest, { force: true });
	symlinkSync(relative(dirname(dest), src), dest);
}

function main() {
	const args = parseArgs(Bun.argv.slice(2));
	let clientDir = resolve(args.pagesDir);
	if (!existsSync(clientDir)) clientDir = resolve(PROJECT_ROOT, args.pagesDir);
	if (!existsSync(clientDir) || !statSync(clientDir).isDirectory())
		throw new Error(`not a directory: ${clientDir}`);
	// Use _pages/ as source base if present, so relative paths skip the _pages/ prefix
	const pagesDir = existsSync(join(clientDir, "_pages"))
		? join(clientDir, "_pages")
		: clientDir;
	const outDir = resolve(args.outDir || join(clientDir, "_gate_groups"));
	if (args.force) rmSync(outDir, { recursive: true, force: true });
	mkdirSync(outDir, { recursive: true });

	const counts = new Map<string, number>();
	for (const gate of discoverGates(pagesDir)) {
		const data = JSON.parse(readFileSync(gate, "utf8"));
		const group =
			data?.gate?.usable === true && GROUPS.has(data?.gate?.group)
				? data.gate.group
				: "unknown";
		const image = imageForGate(gate);
		if (image) {
			link(image, join(outDir, group, relative(pagesDir, image)));
			counts.set(group, (counts.get(group) || 0) + 1);
		}
	}

	console.log(
		JSON.stringify(
			{
				ok: true,
				out_dir: outDir,
				groups: Object.fromEntries([...counts].sort()),
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
