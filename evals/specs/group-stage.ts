// group-stage — StageGrader for Stage 4 (ksk-stage-group).
//
// Grades each session's ข้อมูลระบบ/_doc_groups tree deterministically:
//   tier-A (per session): manifest.yaml parses/validates as ksk_doc_groups.v1,
//     including the "one group per bookable_doc, never per transaction"
//     invariant; COMPLETENESS via the group-skeleton dropped-bookable gate;
//     populate coverage (every group has an interpretation.json with
//     line_items, whether populate:script or populate:agent).
//   cross-session: the sessions are each other's reference — agreement on
//     (category, vat_treatment, line-item count, line-item sum) per
//     BOOKABLE_DOC (the stable cross-session key; ordinal group ids and
//     transaction_ids are not — several bookable_docs legitimately share one
//     transaction_id, e.g. a shared-cluster invoice + its credit note).
//   tier-B: no expected category-assignment set exists yet (see the stub
//     header this replaced) — ground_truth is always null, but shaped so a
//     future `samples/evals/fixtures/group/<fixture>.expected.json` (a
//     per-bookable_doc {category, vat_treatment} answer set) drops in without
//     reshaping the summary envelope.
//
// Never edits a session's output; a malformed/missing artifact is a finding
// reported as a failing metric.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { amountEq, loadJson, loadYaml } from "../lib";
import type {
	SessionGrade,
	StageGradeResult,
	StageGrader,
	StageRunContext,
} from "./stage-grader";

const GROUP_MANIFEST_SCHEMA = "ksk_doc_groups.v1";
const GROUP_LAYOUT = "category_vat_tree.v1";
const KNOWN_CATEGORIES = new Set(["expense", "income", "bank_statement"]);
const KNOWN_VAT_TREATMENTS = new Set(["vat", "non_vat", "mixed"]);
const KNOWN_POPULATE = new Set(["script", "agent"]);

// ---------------------------------------------------------------------------
// manifest.yaml shape (ksk_doc_groups.v1 / category_vat_tree.v1) — see
// .claude/skills/ksk-keying/references/schemas/group-interpretation.md and the
// group-skeleton script (scripts/groups-lib.ts) that writes it.
// ---------------------------------------------------------------------------

export interface ManifestGroup {
	id: string;
	path: string;
	label?: string;
	category: string;
	vat_treatment: string | null;
	bookable_doc: string | null;
	transaction_id: string | null;
	populate: "script" | "agent";
	[k: string]: unknown;
}

export interface ManifestValidation {
	ok: boolean;
	detail: string; // "ok" or "; "-joined problems
	groups: ManifestGroup[];
}

// Pure — validates a parsed manifest.yaml against the ksk_doc_groups.v1 shape
// plus the "one group per bookable_doc, never per transaction" invariant.
// group-skeleton's own construction already guarantees this on a clean run
// (bookable_doc is a single-string field, one per group); this check catches
// a hand-edited/legacy/malformed manifest that violated it, e.g. two groups
// claiming the same bookable_doc (a transaction-shaped merge that silently
// dropped one document's identity — the completeness gate catches the
// opposite failure, a bookable_doc that appears in NO group).
export function validateManifest(manifest: unknown): ManifestValidation {
	if (!manifest || typeof manifest !== "object")
		return { ok: false, detail: "manifest.yaml missing or not an object", groups: [] };
	const m = manifest as Record<string, unknown>;
	if (m.schema !== GROUP_MANIFEST_SCHEMA)
		return { ok: false, detail: `schema "${String(m.schema)}" != ${GROUP_MANIFEST_SCHEMA}`, groups: [] };
	if (m.layout !== GROUP_LAYOUT)
		return { ok: false, detail: `layout "${String(m.layout)}" != ${GROUP_LAYOUT}`, groups: [] };
	if (!Array.isArray(m.groups) || m.groups.length === 0)
		return { ok: false, detail: "groups[] missing or empty", groups: [] };

	const problems: string[] = [];
	const bookableCount = new Map<string, number>();
	const groups: ManifestGroup[] = [];
	m.groups.forEach((raw, i) => {
		const g = raw as Record<string, unknown>;
		const label = typeof g?.id === "string" ? g.id : `#${i}`;
		if (!g || typeof g !== "object") {
			problems.push(`groups[${i}] is not an object`);
			return;
		}
		for (const field of ["id", "path", "category", "populate"] as const) {
			if (typeof g[field] !== "string" || !g[field]) problems.push(`group ${label}: missing "${field}"`);
		}
		if (!("bookable_doc" in g)) problems.push(`group ${label}: missing "bookable_doc"`);
		if (!("transaction_id" in g)) problems.push(`group ${label}: missing "transaction_id"`);
		if (typeof g.category === "string" && !KNOWN_CATEGORIES.has(g.category))
			problems.push(`group ${label}: unknown category "${g.category}"`);
		if (g.vat_treatment != null && typeof g.vat_treatment === "string" && !KNOWN_VAT_TREATMENTS.has(g.vat_treatment))
			problems.push(`group ${label}: unknown vat_treatment "${g.vat_treatment}"`);
		if (typeof g.populate === "string" && !KNOWN_POPULATE.has(g.populate))
			problems.push(`group ${label}: unknown populate "${g.populate}"`);
		if (typeof g.bookable_doc === "string" && g.bookable_doc)
			bookableCount.set(g.bookable_doc, (bookableCount.get(g.bookable_doc) ?? 0) + 1);
		groups.push(g as ManifestGroup);
	});

	for (const [doc, n] of bookableCount)
		if (n > 1)
			problems.push(
				`bookable_doc "${doc}" appears in ${n} groups — must be exactly 1 (one group per bookable_doc, never per transaction)`,
			);

	return { ok: problems.length === 0, detail: problems.length ? problems.join("; ") : "ok", groups };
}

// ---------------------------------------------------------------------------
// populate coverage — every group folder has interpretation.json with
// line_items, whether populate:script (group-populate's 1:1 copy) or
// populate:agent (ksk-marple's line selection).
// ---------------------------------------------------------------------------

function groupInterpPath(client: string, group: ManifestGroup): string {
	return join(client, "ข้อมูลระบบ", "_doc_groups", group.path, "interpretation.json");
}

export interface PopulateCoverage {
	covered: number;
	total: number;
	missing: string[]; // group ids lacking a valid interpretation.json (line_items[])
}

export function checkPopulateCoverage(client: string, groups: ManifestGroup[]): PopulateCoverage {
	const missing: string[] = [];
	for (const g of groups) {
		const p = groupInterpPath(client, g);
		if (!existsSync(p)) {
			missing.push(g.id);
			continue;
		}
		try {
			const interp = loadJson<any>(p);
			if (!Array.isArray(interp?.line_items)) missing.push(g.id);
		} catch {
			missing.push(g.id);
		}
	}
	return { covered: groups.length - missing.length, total: groups.length, missing };
}

// ---------------------------------------------------------------------------
// per-bookable_doc cross-session comparator
// ---------------------------------------------------------------------------

export interface BookableKey {
	key: string; // bookable_doc, verbatim
	category: string | null;
	vatTreatment: string | null;
	liCount: number;
	liSum: number | null;
}

function lineItemSum(items: any[]): number | null {
	const nums = items
		.map((it) => (typeof it?.amount === "number" ? it.amount : Number(it?.amount)))
		.filter((n) => Number.isFinite(n));
	return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

// bank_statement groups (and any group whose bookable doc never resolved —
// group-skeleton's ID_NOT_FOUND_<n> placeholder) carry bookable_doc: null and
// are not a bookable-identity comparison unit; skipped here, same as they're
// excluded from the manifest's bookable_doc-uniqueness check above.
export function collectBookables(client: string, groups: ManifestGroup[]): Map<string, BookableKey> {
	const out = new Map<string, BookableKey>();
	for (const g of groups) {
		if (typeof g.bookable_doc !== "string" || !g.bookable_doc) continue;
		const p = groupInterpPath(client, g);
		let category: string | null = typeof g.category === "string" ? g.category : null;
		let vatTreatment: string | null = typeof g.vat_treatment === "string" ? g.vat_treatment : null;
		let liCount = 0;
		let sum: number | null = null;
		if (existsSync(p)) {
			try {
				const interp = loadJson<any>(p);
				if (typeof interp?.category === "string") category = interp.category;
				if (typeof interp?.vat_treatment === "string") vatTreatment = interp.vat_treatment;
				const items = Array.isArray(interp?.line_items) ? interp.line_items : [];
				liCount = items.length;
				sum = lineItemSum(items);
			} catch {
				// unreadable/invalid interpretation.json — checkPopulateCoverage already
				// flags this group; leave the manifest-derived category/vat_treatment
				// and zero line items so it still participates in agreement (and fails it).
			}
		}
		out.set(g.bookable_doc, { key: g.bookable_doc, category, vatTreatment, liCount, liSum: sum });
	}
	return out;
}

export interface BookableAgreement {
	keysInAll: string[]; // bookable_docs present in every session
	droppedKeys: string[]; // bookable_docs missing from ≥1 session
	agreeing: string[]; // of keysInAll, sessions agree on category/vat/line count/line sum
}

// Pure — compares each session's bookable_doc map against the others. Two
// sessions "agree" on a bookable_doc when its category, vat_treatment,
// line-item count, and line-item sum (amountEq tolerance) all match.
export function bookableAgreement(bySession: Map<string, BookableKey>[]): BookableAgreement {
	const allKeys = new Set<string>();
	bySession.forEach((m) => m.forEach((_, k) => allKeys.add(k)));
	const keysInAll = [...allKeys].filter((k) => bySession.every((m) => m.has(k)));
	const droppedKeys = [...allKeys].filter((k) => !bySession.every((m) => m.has(k)));

	function agrees(k: string): boolean {
		const vs = bySession.map((m) => m.get(k)!);
		const a = vs[0];
		return vs.every(
			(v) => v.category === a.category && v.vatTreatment === a.vatTreatment && v.liCount === a.liCount && amountEq(v.liSum, a.liSum),
		);
	}
	const agreeing = keysInAll.filter(agrees);
	return { keysInAll, droppedKeys, agreeing };
}

function formatFraction(n: number, d: number): string {
	return d ? `${n}/${d} (${((n / d) * 100).toFixed(1)}%)` : "n/a";
}

// ---------------------------------------------------------------------------
// per-session grading
// ---------------------------------------------------------------------------

interface GroupSessionGrade extends SessionGrade {
	manifestOk: boolean;
	manifestDetail: string;
	groupCount: number;
	completenessOk: boolean;
	dropped: string[]; // (segment_id / document_no) pairs the completeness gate flagged
	populateCoverage: string; // "covered/total"
	populateCoverageOk: boolean;
	missingPopulate: string[]; // group ids lacking a populated interpretation.json
}

const DROPPED_RE =
	/bookable documents dropped between Stage-2 and grouping \(segment_id \/ document_no\): (.+?) —/;

function gradeSession(ctx: StageRunContext, s: number): { grade: GroupSessionGrade; bookables: Map<string, BookableKey> } {
	const client = ctx.clientDir(s);
	const manifestPath = join(client, "ข้อมูลระบบ", "_doc_groups", "manifest.yaml");

	let manifest: unknown = null;
	let readError: string | null = null;
	if (existsSync(manifestPath)) {
		try {
			manifest = loadYaml<unknown>(manifestPath);
		} catch (e) {
			readError = e instanceof Error ? e.message : String(e);
		}
	} else {
		readError = "manifest.yaml missing";
	}
	const validation = readError ? { ok: false, detail: readError, groups: [] as ManifestGroup[] } : validateManifest(manifest);

	// COMPLETENESS: re-run the deterministic skeleton build. It re-derives the
	// group plan from links.yaml + the Stage-2 interpretations (not from the
	// manifest already on disk) and throws — non-zero exit — the moment a
	// bookable document present at Stage 2/3 has no group. Exit 0 = no drop.
	const skeleton = ctx.script("group-skeleton", client);
	const completenessOk = skeleton.code === 0;
	const droppedMatch = skeleton.out.match(DROPPED_RE);
	const dropped = droppedMatch
		? droppedMatch[1]
				.split(";")
				.map((x) => x.trim())
				.filter(Boolean)
		: [];

	const groups = validation.groups;
	const coverage = checkPopulateCoverage(client, groups);
	const populateCoverageOk = coverage.total > 0 && coverage.missing.length === 0;

	const pass = validation.ok && completenessOk && populateCoverageOk;

	return {
		grade: {
			session: s,
			manifestOk: validation.ok,
			manifestDetail: validation.detail,
			groupCount: groups.length,
			completenessOk,
			dropped,
			populateCoverage: `${coverage.covered}/${coverage.total}`,
			populateCoverageOk,
			missingPopulate: coverage.missing,
			pass,
		},
		bookables: collectBookables(client, groups),
	};
}

export const groupStageGrader: StageGrader = {
	stage: "group",
	grade(ctx: StageRunContext): StageGradeResult {
		const { run, runId } = ctx;
		const graded: GroupSessionGrade[] = [];
		const bookablesBySession: Array<Map<string, BookableKey>> = [];
		for (let s = 1; s <= run.sessions; s++) {
			const { grade, bookables } = gradeSession(ctx, s);
			graded.push(grade);
			bookablesBySession.push(bookables);
		}

		const { keysInAll, droppedKeys, agreeing } = bookableAgreement(bookablesBySession);
		const reliability = graded.filter((g) => g.pass).length;
		const treeAgreement = formatFraction(agreeing.length, keysInAll.length);

		// tier-B: no expected per-bookable category/vat_treatment set exists yet
		// (see samples/evals/fixtures/group/<fixture>.expected.json, not
		// produced by any stage yet) — always null until one is authored.
		const groundTruth = null;

		const summary = {
			reliability: `${reliability}/${run.sessions}`,
			tree_agreement: treeAgreement,
			bookables_compared: keysInAll.length,
			bookables_dropped: droppedKeys.length,
			dropped_bookables: droppedKeys,
			ground_truth: groundTruth,
			per_session: graded.map((g) => ({
				session: g.session,
				pass: g.pass,
				manifest: g.manifestOk ? "ok" : g.manifestDetail,
				groups: g.groupCount,
				completeness: g.completenessOk ? "PASS" : "BLOCK",
				dropped: g.dropped,
				populate: g.populateCoverage,
			})),
		};

		const scoreboard: string[] = [];
		scoreboard.push(`\nstage-${ctx.stage} · ${run.fixture} · ${run.sessions} sessions · run ${runId}`);
		scoreboard.push(
			`  reliability ${summary.reliability} · tree-agreement ${treeAgreement} · ` +
				`bookables compared ${keysInAll.length} · dropped ${droppedKeys.length}`,
		);
		graded.forEach((g) =>
			scoreboard.push(
				`  s${g.session}: ${g.pass ? "PASS" : "FAIL"} · manifest ${g.manifestOk ? "ok" : g.manifestDetail} · ` +
					`groups ${g.groupCount} · completeness ${g.completenessOk ? "PASS" : "BLOCK"} · populate ${g.populateCoverage}`,
			),
		);
		if (droppedKeys.length) scoreboard.push(`  ⚠ dropped (not in all sessions): ${droppedKeys.join(", ")}`);
		graded.forEach((g) => {
			if (g.dropped.length) scoreboard.push(`  s${g.session} completeness gate: ${g.dropped.join("; ")}`);
			if (g.missingPopulate.length) scoreboard.push(`  s${g.session} unpopulated: ${g.missingPopulate.join(", ")}`);
		});

		scoreboard.push("\n  ground truth: no expected set (skipped tier-B)");

		return { sessionGrades: graded, summary, scoreboard };
	},
};
