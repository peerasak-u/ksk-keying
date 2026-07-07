// Merge Page Disposition fragments into ข้อมูลระบบ/_pages/dispositions.yaml.
//
// Stage-2 children (ksk-watson / ksk-marple) write their Page Disposition to a
// fragment file under ข้อมูลระบบ/_pages/fragments/ instead of carrying it in
// their reply digest — that keeps the parent's context free of per-page lists.
// The parent runs this script once after the Stage-2 wave; it is the only
// writer of dispositions.yaml (children never touch ledger files, and this
// script is parent-run, so that invariant holds).
//
// Fragment schema (ksk_disposition_fragment.v1), one file per Stage-2 child:
//
//   schema: ksk_disposition_fragment.v1
//   segment_id: seg-001            # or "seg-001 p5-9" — provenance only
//   entries:
//     - {file: "บิลซื้อ.pdf", page: 5, disposition: used}
//     - {file: "บิลซื้อ.pdf", page: 6, disposition: excluded, reason: duplicate}
//     - {file: "report.xlsx", sheet: "Sheet1", disposition: used}
//
// Merge semantics — additive upsert keyed by (file, page, sheet):
//   - existing entries with declared_by human or agent_policy are protected:
//     they are kept as-is; a fragment that disagrees only warns
//   - everything else is replaced by the fragment entry, stamped
//     declared_by: agent + note: fragment:<name> (re-running is idempotent)
//   - two fragments claiming the same unit warn; the last one in sorted
//     filename order wins (deterministic)
//
// The gate semantics do not change: this script only changes HOW dispositions
// get to disk. Run `ledger -- --gate interpret` after it, same as before.
//
// Exit codes: 0 merged, 2 usage/malformed input.

import { basename, dirname, join, relative, resolve } from "node:path";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { pagesDir as machineryPagesDir } from "./paths";

const TOOL_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(TOOL_DIR, "../../../..");

export const FRAGMENT_SCHEMA = "ksk_disposition_fragment.v1";
export const DISPOSITIONS_SCHEMA = "ksk_dispositions.v1";
export const FRAGMENTS_DIRNAME = "fragments";
const PROTECTED_DECLARERS = new Set(["human", "agent_policy"]);

export type DispositionEntry = {
	file: string;
	page: number | null;
	sheet: string | null;
	disposition: "used" | "excluded";
	reason?: string;
	declared_by?: string;
	note?: string;
};

export type MergeResult = {
	entries: DispositionEntry[];
	added: number;
	replaced: number;
	protectedKept: number;
	warnings: string[];
};

function usage(): never {
	console.error(`Usage: bun run merge-dispositions -- <client-dir>

Merges every ข้อมูลระบบ/_pages/fragments/*.yaml Page Disposition fragment into
ข้อมูลระบบ/_pages/dispositions.yaml. Existing entries declared_by human or
agent_policy are never overwritten. Idempotent — safe to re-run.

Exit codes: 0 merged, 2 usage/malformed input.
`);
	process.exit(2);
}

// NFC-normalize for matching only, same rule as ledger.ts — never mangle the
// stored Thai filenames.
function norm(text: string) {
	return text.normalize("NFC");
}

function unitKey(entry: DispositionEntry): string {
	if (entry.page != null) return `${norm(entry.file)}#p${entry.page}`;
	if (entry.sheet != null) return `${norm(entry.file)}#s${norm(entry.sheet)}`;
	return norm(entry.file);
}

// Same strictness as ledger.ts loadDispositions: file required, page XOR
// sheet (or neither), disposition used|excluded, reason required on excluded.
function parseEntries(raw: unknown, label: string): DispositionEntry[] | string[] {
	if (!Array.isArray(raw)) return [`${label}: missing entries[] list`];
	const malformed: string[] = [];
	const entries: DispositionEntry[] = [];
	raw.forEach((item, index) => {
		const d = item as Partial<DispositionEntry>;
		const bad =
			typeof d.file !== "string" ||
			(d.page != null && !Number.isInteger(d.page)) ||
			(d.sheet != null && typeof d.sheet !== "string") ||
			(d.page != null && d.sheet != null) ||
			(d.disposition !== "used" && d.disposition !== "excluded") ||
			(d.disposition === "excluded" && !d.reason);
		if (bad) {
			malformed.push(`${label} entries[${index}]: ${JSON.stringify(item)}`);
			return;
		}
		entries.push({
			file: d.file as string,
			page: d.page ?? null,
			sheet: d.sheet ?? null,
			disposition: d.disposition as "used" | "excluded",
			reason: d.reason,
			declared_by: d.declared_by,
			note: d.note,
		});
	});
	return malformed.length ? malformed : entries;
}

export type Fragment = { name: string; entries: DispositionEntry[] };

// Pure merge: existing dispositions + fragments (already in deterministic
// order) -> new entry list. Exported for tests.
export function mergeDispositions(
	existing: DispositionEntry[],
	fragments: Fragment[],
): MergeResult {
	const warnings: string[] = [];
	const byKey = new Map<string, DispositionEntry>();
	for (const entry of existing) {
		const key = unitKey(entry);
		if (byKey.has(key))
			warnings.push(`dispositions.yaml has duplicate entries for "${key}" — keeping the last`);
		byKey.set(key, entry);
	}
	let added = 0;
	let replaced = 0;
	const protectedTouched = new Set<string>();
	const fragmentOwner = new Map<string, string>();
	for (const fragment of fragments) {
		for (const raw of fragment.entries) {
			if (raw.declared_by && PROTECTED_DECLARERS.has(raw.declared_by))
				warnings.push(
					`${fragment.name}: entry for "${unitKey(raw)}" claims declared_by: ${raw.declared_by} — fragments are agent output, forced to "agent"`,
				);
			const entry: DispositionEntry = {
				...raw,
				declared_by: "agent",
				note: `fragment:${fragment.name}`,
			};
			const key = unitKey(entry);
			const current = byKey.get(key);
			const owner = fragmentOwner.get(key);
			if (owner && owner !== fragment.name) {
				const prev = byKey.get(key);
				if (prev && prev.disposition !== entry.disposition)
					warnings.push(
						`"${key}" claimed by both ${owner} (${prev.disposition}) and ${fragment.name} (${entry.disposition}) — keeping ${fragment.name}`,
					);
			}
			if (current && current.declared_by && PROTECTED_DECLARERS.has(current.declared_by)) {
				protectedTouched.add(key);
				if (current.disposition !== entry.disposition)
					warnings.push(
						`"${key}" is ${current.disposition} by ${current.declared_by} but fragment ${fragment.name} says ${entry.disposition} — keeping the ${current.declared_by} entry`,
					);
				continue;
			}
			if (current) replaced++;
			else added++;
			byKey.set(key, entry);
			fragmentOwner.set(key, fragment.name);
		}
	}
	// Stable output order: file, then page, then sheet — so re-runs and hand
	// inspection diff cleanly.
	const entries = [...byKey.values()].sort((a, b) => {
		const byFile = norm(a.file).localeCompare(norm(b.file));
		if (byFile !== 0) return byFile;
		const byPage = (a.page ?? 0) - (b.page ?? 0);
		if (byPage !== 0) return byPage;
		return norm(a.sheet ?? "").localeCompare(norm(b.sheet ?? ""));
	});
	return {
		entries,
		added,
		replaced,
		protectedKept: protectedTouched.size,
		warnings,
	};
}

function resolveClientDir(input: string) {
	const path = resolve(input);
	if (existsSync(path) && statSync(path).isDirectory()) return path;
	const fromRoot = resolve(PROJECT_ROOT, input);
	if (existsSync(fromRoot) && statSync(fromRoot).isDirectory()) return fromRoot;
	console.error(`not a client directory: ${input}`);
	process.exit(2);
}

function loadYaml(path: string, label: string): unknown {
	try {
		return yamlParse(readFileSync(path, "utf8"));
	} catch (error) {
		console.error(
			`failed to parse ${label} (${path}): ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(2);
	}
}

function main() {
	const argv = Bun.argv.slice(2);
	if (argv.length !== 1 || argv[0].startsWith("--")) usage();
	const clientDir = resolveClientDir(argv[0]);
	const pagesDir = machineryPagesDir(clientDir);
	const fragmentsDir = join(pagesDir, FRAGMENTS_DIRNAME);

	// Existing dispositions (policy/human entries the parent recorded directly).
	const dispositionsPath = join(pagesDir, "dispositions.yaml");
	let existing: DispositionEntry[] = [];
	if (existsSync(dispositionsPath)) {
		const doc = loadYaml(dispositionsPath, "dispositions") as { entries?: unknown };
		const parsed = parseEntries(doc?.entries ?? [], "dispositions.yaml");
		if (parsed.length && typeof parsed[0] === "string") {
			console.error("malformed dispositions.yaml entries:");
			for (const line of parsed as string[]) console.error(`  ${line}`);
			process.exit(2);
		}
		existing = parsed as DispositionEntry[];
	}

	// Fragments in sorted filename order — deterministic winner on conflict.
	const fragments: Fragment[] = [];
	if (existsSync(fragmentsDir)) {
		const names = readdirSync(fragmentsDir)
			.filter((n) => n.endsWith(".yaml") || n.endsWith(".yml"))
			.sort();
		for (const name of names) {
			const path = join(fragmentsDir, name);
			const doc = loadYaml(path, "fragment") as { schema?: unknown; entries?: unknown };
			if (doc?.schema !== FRAGMENT_SCHEMA) {
				console.error(
					`unexpected fragment schema in ${relative(clientDir, path)} (expected ${FRAGMENT_SCHEMA})`,
				);
				process.exit(2);
			}
			const parsed = parseEntries(doc.entries ?? [], name);
			if (parsed.length && typeof parsed[0] === "string") {
				console.error(`malformed fragment entries (need file, page|sheet|neither, disposition used|excluded, reason when excluded):`);
				for (const line of parsed as string[]) console.error(`  ${line}`);
				process.exit(2);
			}
			fragments.push({ name, entries: parsed as DispositionEntry[] });
		}
	}
	if (!fragments.length)
		console.error(
			`note: no fragments in ${relative(clientDir, fragmentsDir)} — dispositions.yaml left with its existing entries only`,
		);

	const result = mergeDispositions(existing, fragments);
	mkdirSync(pagesDir, { recursive: true });
	writeFileSync(
		dispositionsPath,
		yamlStringify({ schema: DISPOSITIONS_SCHEMA, entries: result.entries }),
	);

	console.log(
		`merged ${fragments.length} fragment(s) into ${relative(clientDir, dispositionsPath)}: ` +
			`${result.added} added, ${result.replaced} replaced, ${result.protectedKept} protected kept, ${result.entries.length} total`,
	);
	for (const warning of result.warnings) console.log(`warning: ${warning}`);
	console.log(`next: bun run --cwd .claude/skills/ksk-keying/scripts ledger -- --gate interpret "${basename(clientDir)}"`);
}

if (import.meta.main) main();
