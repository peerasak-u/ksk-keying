import { dirname, extname, join, relative, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

const TOOL_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(TOOL_DIR, "../../../..");
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const EXTRACTABLE_DOC_KINDS = new Set([
	"handwritten_bill",
	"pwa_bill",
	"pea_bill",
	"global_house_invoice",
	"normal_bill_or_invoice",
	"bank_statement",
	"wht_certificate",
]);

type Stage = "gate" | "extract" | "pipe";

type StemRow = {
	stem: string;
	images: number;
	done: number;
	remaining: number;
	remaining_seconds: number;
	remaining_human: string;
	percent_done: number;
	status: "done" | "partial" | "pending";
};

type GateInfo = { exists: boolean; usable: boolean; classifiable: boolean };

function usage(): never {
	console.error(`Usage: bun run estimate -- [options] <_pages-dir>

Estimate pipeline progress and wall-clock time from image and sidecar counts.

Options:
  --stage STAGE           gate | extract | pipe (default: gate)
  --seconds-per-image N   Seconds per API call (default: 10)
  --concurrency N         Parallel pages in flight (default: 1)
  --gate-dir DIR          Read *.gate.json from DIR instead of beside images
  --extract-dir DIR       Read *.extract.json from DIR instead of beside images
`);
	process.exit(2);
}

function parseArgs(argv: string[]) {
	const args = {
		pagesDir: "",
		stage: "gate" as Stage,
		secondsPerImage: 10,
		concurrency: 1,
		gateDir: undefined as string | undefined,
		extractDir: undefined as string | undefined,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--stage") {
			const stage = argv[++i] as Stage;
			if (!["gate", "extract", "pipe"].includes(stage)) usage();
			args.stage = stage;
		} else if (arg === "--seconds-per-image") {
			args.secondsPerImage = Number(argv[++i]);
		} else if (arg === "--concurrency") {
			args.concurrency = Number(argv[++i]);
		} else if (arg === "--gate-dir") args.gateDir = argv[++i];
		else if (arg === "--extract-dir") args.extractDir = argv[++i];
		else if (arg === "--help" || arg === "-h") usage();
		else if (arg.startsWith("--")) usage();
		else if (!args.pagesDir) args.pagesDir = arg;
		else usage();
	}
	if (!args.pagesDir) usage();
	if (!Number.isFinite(args.secondsPerImage) || args.secondsPerImage <= 0)
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

function discoverImages(dir: string): string[] {
	const out: string[] = [];
	const stack = [dir];
	while (stack.length) {
		const current = stack.pop()!;
		for (const name of readdirSync(current).sort()) {
			const child = join(current, name);
			const st = statSync(child);
			if (st.isDirectory()) stack.push(child);
			else if (st.isFile() && IMAGE_EXTS.has(extname(child).toLowerCase()))
				out.push(child);
		}
	}
	return out.sort();
}

function artifactPath(
	image: string,
	pagesDir: string,
	suffix: ".gate.json" | ".extract.json",
	overrideDir?: string,
) {
	const base = image.replace(/\.[^.]+$/, suffix);
	if (!overrideDir) return base;
	const rel = relative(pagesDir, image).replace(/\.[^.]+$/, suffix);
	return join(resolve(overrideDir), rel);
}

function stemName(pagesDir: string, image: string) {
	const rel = relative(pagesDir, image);
	const slash = rel.indexOf("/");
	return slash === -1 ? "." : rel.slice(0, slash);
}

function percent(done: number, total: number) {
	if (!total) return 0;
	return Math.round((done / total) * 1000) / 10;
}

function formatDuration(seconds: number) {
	const total = Math.max(0, Math.round(seconds));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const secs = total % 60;
	if (minutes < 60) return secs ? `${minutes}m ${secs}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

function wallSeconds(
	calls: number,
	secondsPerImage: number,
	concurrency: number,
) {
	if (!calls) return 0;
	return Math.ceil(calls / concurrency) * secondsPerImage;
}

function estimateBlock(
	remainingCalls: number,
	secondsPerImage: number,
	concurrency: number,
) {
	const sequentialSeconds = remainingCalls * secondsPerImage;
	const concurrentSeconds = wallSeconds(
		remainingCalls,
		secondsPerImage,
		concurrency,
	);
	return {
		remaining_calls: remainingCalls,
		concurrency,
		remaining_seconds_sequential: sequentialSeconds,
		remaining_seconds: concurrentSeconds,
		remaining_human_sequential: formatDuration(sequentialSeconds),
		remaining_human: formatDuration(concurrentSeconds),
	};
}

function readGateInfo(
	image: string,
	pagesDir: string,
	gateDir?: string,
): GateInfo {
	const gatePath = artifactPath(image, pagesDir, ".gate.json", gateDir);
	if (!existsSync(gatePath)) {
		return { exists: false, usable: false, classifiable: false };
	}
	try {
		const data = JSON.parse(readFileSync(gatePath, "utf8"));
		const usable = data?.gate?.usable === true;
		const docKind = data?.gate?.doc_kind;
		return {
			exists: true,
			usable,
			classifiable: usable && EXTRACTABLE_DOC_KINDS.has(docKind),
		};
	} catch {
		return { exists: true, usable: false, classifiable: false };
	}
}

function stemStatus(done: number, images: number): StemRow["status"] {
	if (!images || done >= images) return "done";
	if (done > 0) return "partial";
	return "pending";
}

function main() {
	const args = parseArgs(Bun.argv.slice(2));
	let pagesDir = resolveInput(args.pagesDir);
	if (!existsSync(pagesDir) || !statSync(pagesDir).isDirectory())
		throw new Error(`not a directory: ${pagesDir}`);

	const images = discoverImages(pagesDir);
	const stemMap = new Map<
		string,
		{
			images: number;
			gateDone: number;
			extractDone: number;
			gateRemaining: number;
			extractRemaining: number;
			extractSkipped: number;
		}
	>();

	let gateDone = 0;
	let extractDone = 0;
	let gateRemaining = 0;
	let extractRemaining = 0;
	let extractSkipped = 0;

	for (const image of images) {
		const stem = stemName(pagesDir, image);
		const row = stemMap.get(stem) || {
			images: 0,
			gateDone: 0,
			extractDone: 0,
			gateRemaining: 0,
			extractRemaining: 0,
			extractSkipped: 0,
		};
		row.images += 1;

		const gatePath = artifactPath(image, pagesDir, ".gate.json", args.gateDir);
		const extractPath = artifactPath(
			image,
			pagesDir,
			".extract.json",
			args.extractDir,
		);
		const hasGate = existsSync(gatePath);
		const hasExtract = existsSync(extractPath);
		const gate = readGateInfo(image, pagesDir, args.gateDir);

		if (hasGate) {
			gateDone += 1;
			row.gateDone += 1;
		} else {
			gateRemaining += 1;
			row.gateRemaining += 1;
		}

		if (hasExtract) {
			extractDone += 1;
			row.extractDone += 1;
		} else if (gate.classifiable) {
			extractRemaining += 1;
			row.extractRemaining += 1;
		} else if (gate.exists) {
			extractSkipped += 1;
			row.extractSkipped += 1;
		}

		stemMap.set(stem, row);
	}

	const stems: StemRow[] = [...stemMap.entries()]
		.sort(([a], [b]) => a.localeCompare(b, "th"))
		.map(([stem, row]) => {
			const done =
				args.stage === "extract" ? row.extractDone : row.gateDone;
			const remaining =
				args.stage === "extract"
					? row.extractRemaining
					: args.stage === "pipe"
						? row.gateRemaining + row.extractRemaining
						: row.gateRemaining;
			const progressBase =
				args.stage === "extract"
					? row.extractDone + row.extractRemaining
					: row.images;
			return {
				stem,
				images: row.images,
				done,
				remaining,
				remaining_seconds: wallSeconds(
					remaining,
					args.secondsPerImage,
					args.concurrency,
				),
				remaining_human: formatDuration(
					wallSeconds(remaining, args.secondsPerImage, args.concurrency),
				),
				percent_done: percent(done, progressBase),
				status: stemStatus(
					args.stage === "extract" ? row.extractDone : row.gateDone,
					row.images,
				),
				...(args.stage === "pipe"
					? {
							gate_done: row.gateDone,
							gate_remaining: row.gateRemaining,
							extract_remaining: row.extractRemaining,
						}
					: {}),
			};
		});

	const totals =
		args.stage === "gate"
			? {
					images: images.length,
					done: gateDone,
					remaining: gateRemaining,
					percent_done: percent(gateDone, images.length),
					percent_remaining: percent(gateRemaining, images.length),
				}
			: args.stage === "extract"
				? {
						images: images.length,
						done: extractDone,
						remaining: extractRemaining,
						skipped_no_extract: extractSkipped,
						missing_gate: gateRemaining,
						percent_done: percent(extractDone, images.length),
						percent_remaining: percent(extractRemaining, images.length),
					}
				: {
						images: images.length,
						gate_done: gateDone,
						gate_remaining: gateRemaining,
						extract_done: extractDone,
						extract_remaining: extractRemaining,
						extract_skipped: extractSkipped,
						percent_gate_done: percent(gateDone, images.length),
						percent_extract_done: percent(extractDone, images.length),
					};

	const remainingCalls =
		args.stage === "gate"
			? gateRemaining
			: args.stage === "extract"
				? extractRemaining
				: gateRemaining + extractRemaining;

	const fullCalls = images.length * (args.stage === "pipe" ? 2 : 1);
	const estimate = {
		seconds_per_image: args.secondsPerImage,
		concurrency: args.concurrency,
		...estimateBlock(
			remainingCalls,
			args.secondsPerImage,
			args.concurrency,
		),
		full_calls: fullCalls,
		full_seconds_sequential: fullCalls * args.secondsPerImage,
		full_seconds: wallSeconds(
			fullCalls,
			args.secondsPerImage,
			args.concurrency,
		),
		full_human_sequential: formatDuration(fullCalls * args.secondsPerImage),
		full_human: formatDuration(
			wallSeconds(fullCalls, args.secondsPerImage, args.concurrency),
		),
	};

	if (args.stage === "pipe") {
		Object.assign(estimate, {
			gate: estimateBlock(
				gateRemaining,
				args.secondsPerImage,
				args.concurrency,
			),
			extract: estimateBlock(
				extractRemaining,
				args.secondsPerImage,
				args.concurrency,
			),
		});
	}

	console.log(
		JSON.stringify(
			{
				ok: true,
				pages_dir: pagesDir,
				stage: args.stage,
				totals,
				estimate,
				stems,
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