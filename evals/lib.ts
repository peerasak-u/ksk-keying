// Shared helpers for the agent-eval framework.
// Dev-repo tooling only — never shipped with the skill.

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";

export const REPO_ROOT = resolve(import.meta.dir, "..");
export const DATA_ROOT = join(REPO_ROOT, "samples", "evals");
export const RUNS_ROOT = join(DATA_ROOT, "_runs");

export interface CaseSpec {
	schema: string;
	agent: string;
	case_id: string;
	provisional?: boolean;
	dispatch: {
		segment_id: string;
		files: string[]; // relative to the case dir (input/…)
		pages?: string; // e.g. "1-4" when the dispatch covers a page range
	};
	// Each entry is a keyword that must appear (case-insensitive) in at least
	// one review flag / warning of the output. Counts as a critical field.
	expected_flags?: string[];
	provenance: {
		client: string;
		month: string;
		source: string;
		verified_by: string;
		harvested: string;
		note?: string;
	};
}

export function loadYaml<T = unknown>(path: string): T {
	return YAML.parse(readFileSync(path, "utf8")) as T;
}

export function loadJson<T = unknown>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

export function copyInto(src: string, destDir: string, name?: string): string {
	ensureDir(destDir);
	const dest = join(destDir, name ?? src.split("/").pop()!);
	copyFileSync(src, dest);
	return dest;
}

export function casesDir(agent: string): string {
	return join(DATA_ROOT, agent.replace(/^ksk-/, ""), "cases");
}

export function listCaseDirs(agent: string): string[] {
	const root = casesDir(agent);
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => join(root, e.name))
		.filter((d) => existsSync(join(d, "case.yaml")))
		.sort();
}

export function loadCase(caseDir: string): CaseSpec {
	return loadYaml<CaseSpec>(join(caseDir, "case.yaml"));
}

export function datasetVersion(agent: string): string {
	const p = join(DATA_ROOT, agent.replace(/^ksk-/, ""), "VERSION");
	return existsSync(p) ? readFileSync(p, "utf8").trim() : "0";
}

// ---------------------------------------------------------------------------
// Interpretation normalization (ksk_segment_interpretation.v1, shapes A + B)
// ---------------------------------------------------------------------------

export interface NormDoc {
	doc_kind: string | null;
	source_page: number | null;
	facts: Record<string, unknown>;
	line_items: unknown[];
	flags: string[]; // doc-level warnings
}

export interface NormInterp {
	docs: NormDoc[];
	flags: string[]; // top-level review_flags + questions
}

// Flags appear both as plain strings and as {type, note, ...} objects across
// watson outputs (the skill validator doesn't pin the shape). Flatten either
// to searchable text — String() on an object would yield "[object Object]"
// and silently hide the flag from keyword matching.
export function flagText(f: unknown): string {
	return typeof f === "string" ? f : JSON.stringify(f);
}

export function normalizeInterp(interp: any): NormInterp {
	const topFlags: string[] = [
		...(interp?.review_flags ?? []),
		...(interp?.questions_for_user ?? []),
	].map(flagText);

	const sameTx = interp?.relationship?.same_transaction === true;
	if (sameTx) {
		const primary = (interp.documents ?? [])[0] ?? {};
		return {
			docs: [
				{
					doc_kind: primary.doc_kind ?? null,
					source_page: primary.source_page ?? null,
					facts: interp.accounting_facts ?? {},
					line_items: interp.line_items ?? [],
					flags: (interp.documents ?? []).flatMap((d: any) =>
						(d.warnings ?? []).map(flagText),
					),
				},
			],
			flags: topFlags,
		};
	}

	const docs: NormDoc[] = (interp?.documents ?? [])
		.filter((d: any) => d.accounting_facts)
		.map((d: any) => ({
			doc_kind: d.doc_kind ?? null,
			source_page: d.source_page ?? null,
			facts: d.accounting_facts,
			line_items: d.line_items ?? [],
			flags: (d.warnings ?? []).map(flagText),
		}));
	return { docs, flags: topFlags };
}

export function amountEq(a: unknown, b: unknown, tol = 0.011): boolean {
	if (a == null && b == null) return true;
	if (typeof a !== "number" || typeof b !== "number") return false;
	return Math.abs(a - b) <= tol;
}

export function normText(v: unknown): string {
	return String(v ?? "")
		.replace(/\s+/g, " ")
		.replace(/บริษัท\s*/g, "บจก.")
		.replace(/\s*จำกัด\s*\(มหาชน\)/g, "")
		.replace(/\s*จำกัด/g, "")
		.trim()
		.toLowerCase();
}

export function nowIso(): string {
	return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

export function parseArgs(argv: string[]): {
	positional: string[];
	flags: Record<string, string | boolean>;
} {
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		} else {
			positional.push(a);
		}
	}
	return { positional, flags };
}
