// Splits one Dropbox client folder into the two halves samples/ expects:
//
//   samples/clients/<id>/      the client in its STARTING state — raw source
//                              documents only, structure preserved, exactly
//                              what /ksk-keying gets pointed at
//   samples/answer-keys/<id>/  the finished PEAK export, at the same relative
//                              paths, for grading a run AFTER it finishes
//
//   bun run prepare-sample.ts -- --source <dropbox client dir> --client <id>
//                                [--root <repo root>] [--force] [--dry-run]
//   bun run prepare-sample.ts -- --verify-only --client <id> [--root <repo root>]
//
// Why a script and not an rsync one-liner: the split is the whole point, and
// getting it wrong is silent. If a single export workbook lands in
// samples/clients/, every run against that client is contaminated from then
// on — the pipeline can read the answer while producing it, and the failure
// shows up as a suspiciously good score rather than an error (CLAUDE.md →
// "never peek at answer-keys/ mid-run"). So the copy is followed by a verify
// pass that re-walks the finished client folder and fails loudly if anything
// export-shaped survived, instead of trusting the copy logic that just ran.
//
// Dropbox folders are read-only source material: this script only ever reads
// from --source, never writes back.

import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	isAnswerKeyPath,
} from "../.claude/skills/ksk-keying/scripts/export-dir";

const SKIP_FILENAMES = new Set([".DS_Store", "Thumbs.db"]);

// Pipeline output, not source material. Some Dropbox client folders carry a
// stale ข้อมูลระบบ/ from an earlier run; copying it would hand the new run a
// half-finished state instead of the starting state samples/clients promises.
const PIPELINE_OUTPUT_DIR = "ข้อมูลระบบ";
const EXCEL_EXT = /\.(xlsx|xlsm|xls)$/i;

// Content matching only means something for files with real content. A .xlsx
// is a ZIP archive — the smallest one any tool writes is comfortably over a
// kilobyte — so anything under this is a stub, a placeholder, or an empty
// file. Two such files match each other trivially, which would sweep unrelated
// documents into the answer key on a coincidence rather than on evidence.
const MIN_CONTENT_MATCH_BYTES = 512;

function contentComparable(path: string): boolean {
	return EXCEL_EXT.test(path) && statSync(path).size >= MIN_CONTENT_MATCH_BYTES;
}

type Plan = {
	client: { from: string; to: string }[];
	key: { from: string; to: string }[];
	skipped: string[];
	/** Files the name rules called source, that turned out to be byte-identical
	 * copies of a known export. Reported so a human can see what the second
	 * pass caught — silently reclassifying files is how a wrong rule hides. */
	duplicates: string[];
};

function skipFile(name: string): boolean {
	return name.startsWith(".") || name.startsWith("~$") || SKIP_FILENAMES.has(name);
}

// Walks the source tree once, routing each file to one of the two targets by
// whether any ancestor folder is a PEAK export dir.
export function planSplit(source: string, clientRoot: string, keyRoot: string): Plan {
	const plan: Plan = { client: [], key: [], skipped: [], duplicates: [] };

	function walk(dir: string, rel: string) {
		for (const name of readdirSync(dir).sort()) {
			const from = join(dir, name);
			const relPath = rel ? `${rel}/${name}` : name;
			if (statSync(from).isDirectory()) {
				if (name === PIPELINE_OUTPUT_DIR) {
					plan.skipped.push(`${relPath}/ (pipeline output)`);
					continue;
				}
				if (name.startsWith(".")) {
					plan.skipped.push(`${relPath}/ (hidden)`);
					continue;
				}
				walk(from, relPath);
				continue;
			}
			if (skipFile(name)) continue;
			if (isAnswerKeyPath(relPath))
				plan.key.push({ from, to: join(keyRoot, relPath) });
			else plan.client.push({ from, to: join(clientRoot, relPath) });
		}
	}

	walk(source, "");
	return reclassifyExportCopies(plan, clientRoot, keyRoot);
}

// Second pass: content, not names.
//
// Client 339 keeps a byte-identical copy of every PEAK export beside the
// source document it was produced from — "รายได้/รายได้.xlsx" is the same file
// as "ไฟล์นำเข้า Peak/รายได้.xlsx", and "STM/03-69 ถอน.xlsx" the same as its
// twin. Nothing in those names says "export"; no name rule can ever catch
// them. But identical bytes are not a coincidence — if a workbook IS one of
// this client's exports, it is an answer key wherever it happens to be filed.
//
// Only the Excel family is compared: a scan can't be a PEAK export, and
// hashing every page image would cost far more than it could ever find.
function reclassifyExportCopies(plan: Plan, clientRoot: string, keyRoot: string): Plan {
	if (!plan.key.length) return plan;
	const keyHashes = new Set(
		plan.key.filter((p) => contentComparable(p.from)).map((p) => hashFile(p.from)),
	);
	const stillClient: typeof plan.client = [];
	for (const entry of plan.client) {
		const rel = entry.to.slice(clientRoot.length + 1);
		if (contentComparable(entry.from) && keyHashes.has(hashFile(entry.from))) {
			plan.duplicates.push(rel);
			plan.key.push({ from: entry.from, to: join(keyRoot, rel) });
			continue;
		}
		stillClient.push(entry);
	}
	plan.client = stillClient;
	return plan;
}

function hashFile(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Re-walks the finished client folder from disk. This must not consult the
// plan — it exists precisely to catch a planner that got it wrong.
// Pass keyRoot to also catch content copies — an export workbook re-filed
// under a source folder with an innocent name (339's "รายได้/รายได้.xlsx").
// Without it only the name rules apply, which is still a useful standalone
// check but cannot see a disguised copy.
export function findLeaks(clientRoot: string, keyRoot?: string): string[] {
	const leaks: string[] = [];
	const keyHashes = keyRoot ? hashTree(keyRoot) : null;

	function walk(dir: string, rel: string) {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			const relPath = rel ? `${rel}/${name}` : name;
			if (statSync(full).isDirectory()) {
				walk(full, relPath);
				continue;
			}
			// Name says export — but only a workbook can be one. 281 files its
			// source statement PDFs inside a folder called "STM ไฟล์นำเข้า".
			if (isAnswerKeyPath(relPath)) {
				leaks.push(relPath);
				continue;
			}
			// Bytes say export, whatever the name claims.
			if (keyHashes && contentComparable(full) && keyHashes.has(hashFile(full)))
				leaks.push(`${relPath} (byte-identical to an answer-key workbook)`);
		}
	}
	walk(clientRoot, "");
	return leaks;
}

function hashTree(root: string): Set<string> {
	const out = new Set<string>();
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop()!;
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) stack.push(full);
			else if (contentComparable(full)) out.add(hashFile(full));
		}
	}
	return out;
}

function copyAll(pairs: { from: string; to: string }[]): number {
	for (const { from, to } of pairs) {
		mkdirSync(dirname(to), { recursive: true });
		copyFileSync(from, to);
	}
	return pairs.length;
}

function usage(): never {
	console.error(`Usage: bun run prepare-sample.ts -- --source <dir> --client <id> [options]
       bun run prepare-sample.ts -- --verify-only --client <id>

Options:
  --source        Dropbox client folder to split (read-only)
  --client        Sample client id, e.g. 218
  --root          Repo root holding samples/ (default: this repo)
  --force         Overwrite existing samples/clients/<id>
  --dry-run       Print the plan, copy nothing
  --verify-only   Skip the copy; just check samples/clients/<id> for leaks
`);
	process.exit(2);
}

function main() {
	const argv = Bun.argv.slice(2);
	let source = "";
	let client = "";
	let root = resolve(import.meta.dir, "..");
	let force = false;
	let dryRun = false;
	let verifyOnly = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--source") source = argv[++i];
		else if (arg === "--client") client = argv[++i];
		else if (arg === "--root") root = resolve(argv[++i]);
		else if (arg === "--force") force = true;
		else if (arg === "--dry-run") dryRun = true;
		else if (arg === "--verify-only") verifyOnly = true;
		else usage();
	}
	if (!client) usage();

	const clientRoot = join(root, "samples/clients", client);
	const keyRoot = join(root, "samples/answer-keys", client);

	if (verifyOnly) {
		const leaks = findLeaks(clientRoot, keyRoot);
		if (leaks.length) {
			console.error(`LEAK: answer-key folders found under ${clientRoot}`);
			for (const l of leaks) console.error(`  ${l}`);
			process.exit(1);
		}
		console.log(`clean: no export folders under ${clientRoot}`);
		return;
	}

	if (!source) usage();
	const src = resolve(source);
	if (!existsSync(src) || !statSync(src).isDirectory()) {
		console.error(`source not found: ${src}`);
		process.exit(1);
	}
	if (existsSync(clientRoot) && !force) {
		console.error(`${clientRoot} already exists — pass --force to overwrite`);
		process.exit(1);
	}

	const plan = planSplit(src, clientRoot, keyRoot);
	if (!plan.key.length) {
		// Not fatal — a client-month can genuinely have no export yet — but it
		// is far more often a misspelled export folder the predicate missed,
		// which is exactly the case that contaminates the sample.
		console.warn(
			`warning: no PEAK export folder found in ${basename(src)} — ` +
				`check the folder names before trusting samples/clients/${client}`,
		);
	}

	if (dryRun) {
		console.log(`source: ${src}`);
		console.log(`  → client:     ${plan.client.length} files`);
		console.log(`  → answer-key: ${plan.key.length} files`);
		for (const d of plan.duplicates)
			console.log(`  export copy hiding in a source folder: ${d}`);
		for (const s of plan.skipped) console.log(`  skipped ${s}`);
		for (const { to } of plan.key.slice(0, 5))
			console.log(`  key e.g. ${to.slice(keyRoot.length + 1)}`);
		return;
	}

	const clientFiles = copyAll(plan.client);
	const keyFiles = copyAll(plan.key);

	const leaks = findLeaks(clientRoot, keyRoot);
	if (leaks.length) {
		console.error(`LEAK: answer-key folders survived into ${clientRoot}`);
		for (const l of leaks) console.error(`  ${l}`);
		process.exit(1);
	}

	console.log(`Prepared samples/clients/${client}`);
	console.log(`  source files: ${clientFiles}`);
	console.log(`  answer key:   ${keyFiles} files → samples/answer-keys/${client}`);
	for (const d of plan.duplicates)
		console.log(`  export copy hiding in a source folder: ${d}`);
	for (const s of plan.skipped) console.log(`  skipped ${s}`);
	console.log(`  verify: clean`);
}

if (import.meta.main) main();
