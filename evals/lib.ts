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

// ---------------------------------------------------------------------------
// Identity-first document matcher — shared by every "grade extracted output
// against a ground-truth doc set" flow (stage-grade.ts's cross-session tier-B,
// grade-vs-answer-key.ts's run-vs-PEAK-export grading). 3 tiers of decreasing
// strictness:
//   1) exact normalized doc_no
//   2) same Thai receipt-book เลขที่ tail (prefix dropped) + gross agrees
//      (guards "66/22" from colliding with "71/22")
//   3) gross + date agree (fallback for blank/garbled doc_no)
// Each candidate is consumed at most once; ties resolve in `expected` order.
// ---------------------------------------------------------------------------

export interface Identifiable {
	gross: number | null; // VAT-inclusive
	docNo: string; // normalized (normText) — "" when blank/unrecoverable
	docDate: string; // ISO yyyy-mm-dd, "" when blank
}

export interface KeyedDoc extends Identifiable {
	key: string; // stable id within its own set, for consumption bookkeeping
}

export interface MatchResult<A extends KeyedDoc, E extends Identifiable> {
	matched: Array<{ expected: E; actual: A }>;
	missed: E[]; // expected docs with no actual match
	invented: A[]; // actual docs matching no expected doc
	// Tier-3 (gross+date-only) matches made inside a (gross, date) collision
	// bucket — where ≥2 expected or ≥2 actual docs share that gross+date and no
	// usable doc_no disambiguates them. The pairing there is greedy/order-
	// dependent, so a duplicate/invented actual can satisfy the "wrong" expected
	// and silently mask a genuinely missing document. Surfaced (never dropped) so
	// a caller can flag the score as identity-ambiguous rather than trust it.
	ambiguous: Array<{ expected: E; actual: A }>;
}

// Thai receipt-book numbers are "เล่มที่/เลขที่" (e.g. "66/22"); a reader often
// records only the เลขที่ ("22"). Compare on the trailing segment so identity
// matching survives that.
export function tailNo(norm: string): string {
	const parts = norm.split("/");
	return parts[parts.length - 1].trim();
}

// Two doc_nos that differ only by separator style (slash vs dash vs space vs
// dot) or a leading zero (digits-only) are the SAME document — e.g.
// "690407/001" vs "690407-001", or "055071207398" vs "55071207398". `norm` is
// already normText output (lowercased/trimmed).
//
// Deliberately does NOT touch internal zero-runs (e.g.
// "BCUNS00066012604000124" vs "BCUNS000660012604000124") — collapsing those
// is unsafe over-merge risk; that pair is left for the gross+date fallback
// tier instead.
export function normalizeDocNo(norm: string): string {
	let s = norm.replace(/[\s./\\-]+/g, ""); // unify separators: space . / \ -
	if (!s) return norm; // pure-separator token — keep the original so distinct separator-only strings don't collapse to "" and match each other
	if (/^\d+$/.test(s)) s = s.replace(/^0+/, "") || "0"; // strip leading zeros ONLY when all-digit
	return s;
}

export function matchDocs<A extends KeyedDoc, E extends Identifiable>(
	actual: A[],
	expected: E[],
): MatchResult<A, E> {
	const consumed = new Set<string>();
	const matched: Array<{ expected: E; actual: A }> = [];
	const missed: E[] = [];
	const ambiguous: Array<{ expected: E; actual: A }> = [];
	// A (gross, date) bucket with >1 member on either side is exactly where the
	// doc_no-blind gross+date fallback can mis-pair; used only to tag those matches.
	const bucketKey = (d: Identifiable) =>
		`${d.gross == null ? "" : Math.round(d.gross * 100)}|${d.docDate}`;
	const tally = (docs: Identifiable[]) => {
		const counts = new Map<string, number>();
		for (const d of docs) counts.set(bucketKey(d), (counts.get(bucketKey(d)) ?? 0) + 1);
		return counts;
	};
	const expBucket = tally(expected);
	const actBucket = tally(actual);
	for (const exp of expected) {
		const free = (a: A) => !consumed.has(a.key);
		let hit: A | undefined;
		let viaFallback = false;
		hit = actual.find((a) => free(a) && !!a.docNo && a.docNo === exp.docNo); // tier 1: exact doc_no
		hit ??= actual.find(
			(a) =>
				free(a) &&
				!!a.docNo &&
				!!exp.docNo &&
				normalizeDocNo(a.docNo) === normalizeDocNo(exp.docNo) &&
				amountEq(a.gross, exp.gross),
		); // tier 2: separator/leading-zero-normalized doc_no + gross
		hit ??= actual.find(
			(a) =>
				free(a) &&
				!!a.docNo &&
				!!exp.docNo &&
				tailNo(a.docNo) === tailNo(exp.docNo) &&
				amountEq(a.gross, exp.gross),
		); // tier 3: Thai receipt-book เลขที่ tail + gross
		if (!hit) {
			hit = actual.find((a) => free(a) && amountEq(a.gross, exp.gross) && a.docDate === exp.docDate); // tier 4: gross + date only
			viaFallback = hit != null;
		}
		if (!hit) {
			missed.push(exp);
			continue;
		}
		consumed.add(hit.key);
		matched.push({ expected: exp, actual: hit });
		if (
			viaFallback &&
			((expBucket.get(bucketKey(exp)) ?? 0) > 1 || (actBucket.get(bucketKey(hit)) ?? 0) > 1)
		)
			ambiguous.push({ expected: exp, actual: hit });
	}
	const invented = actual.filter((a) => !consumed.has(a.key));
	return { matched, missed, invented, ambiguous };
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
