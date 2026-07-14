// link-stage — StageGrader for Stage 3 (ksk-stage-link).
//
// Grades each session's ข้อมูลระบบ/_doc_groups/links.yaml deterministically:
//   tier-A (per session): shape (transactions[] present, every transaction has
//     ≥1 member, bookable_docs[] present), bookable→interpretation traceability
//     (every bookable_doc names a document that actually exists in the Stage-2
//     interpretations, or a legitimate no-document-number placeholder), and the
//     Stage-4 completeness gate (group-skeleton exits non-zero when a bookable
//     document was dropped between Stage-2 and grouping — see groups-lib.ts's
//     findDroppedBookableUnits).
//   cross-session: the sessions are each other's reference — cluster MEMBER-SET
//     agreement (reusing sherlock.ts's normalizeLinks canonicalization + the
//     same multiset bucket-matching gradeLinks uses vs an answer key, applied
//     session-vs-session instead).
//   tier-B (when <fixture>.expected.yaml exists): each session's links.yaml vs
//     the verified reference, via sherlock.ts's own gradeLinks. No expected set
//     exists yet for any link fixture, so this is always null today; the wiring
//     is live so dropping in the file is enough to turn tier-B on.
//
// Never edits a session's output directly; group-skeleton is re-run as the
// production completeness gate (same "grader re-runs the production gates"
// pattern interpret-stage.ts uses for merge-dispositions/ledger) — it writes
// ข้อมูลระบบ/_doc_groups/manifest.yaml + group folders into the session's own
// clone, never into the fixture.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, loadJson, loadYaml, normText, normalizeInterp } from "../lib";
import { gradeLinks, normalizeLinks, type SherlockGrade } from "./sherlock";
import type {
	SessionGrade,
	StageGradeResult,
	StageGrader,
	StageRunContext,
} from "./stage-grader";

type Cluster = ReturnType<typeof normalizeLinks>[number];

// ---------------------------------------------------------------------------
// Structural validation (schema ksk_links.v1). There is no standalone
// ksk_links.v1 validator script (unlike validate-interpretation for Stage 2),
// so this mirrors exactly what groups-io.ts's loadLinks() + groups-lib.ts's
// planGroups() actually rely on: a top-level `transactions[]`, each with a
// non-empty `members[]` and a `bookable_docs[]` (empty is valid — e.g. a
// standalone bank statement carries bookable_docs: []).
// ---------------------------------------------------------------------------

interface LinkMember {
	segment?: unknown;
	document_no?: unknown;
	role?: unknown;
}
interface LinkTransaction {
	transaction_id?: unknown;
	segments?: unknown;
	members?: unknown;
	bookable_docs?: unknown;
	evidence?: unknown;
	confidence?: unknown;
}
interface LinksDoc {
	transactions?: LinkTransaction[];
}

export interface ShapeCheck {
	ok: boolean;
	transactionCount: number;
	emptyMemberTxns: string[]; // transaction_id (or "#index") of txns with 0 members
	malformedBookable: string[]; // txns whose bookable_docs isn't an array at all
	detail: string;
}

export function validateShape(doc: unknown): ShapeCheck {
	if (!doc || typeof doc !== "object" || !Array.isArray((doc as LinksDoc).transactions))
		return {
			ok: false,
			transactionCount: 0,
			emptyMemberTxns: [],
			malformedBookable: [],
			detail: "missing/malformed transactions[]",
		};
	const txns = (doc as LinksDoc).transactions!;
	const emptyMemberTxns: string[] = [];
	const malformedBookable: string[] = [];
	txns.forEach((t, i) => {
		const id = typeof t.transaction_id === "string" ? t.transaction_id : `#${i}`;
		const members = Array.isArray(t.members) ? t.members : null;
		if (!members || members.length === 0) emptyMemberTxns.push(id);
		if (!Array.isArray(t.bookable_docs)) malformedBookable.push(id);
	});
	const ok = emptyMemberTxns.length === 0 && malformedBookable.length === 0;
	const detail = ok
		? "ok"
		: [
				emptyMemberTxns.length ? `${emptyMemberTxns.length} txn(s) with 0 members` : null,
				malformedBookable.length ? `${malformedBookable.length} txn(s) missing bookable_docs[]` : null,
			]
				.filter((s): s is string => s != null)
				.join("; ");
	return { ok, transactionCount: txns.length, emptyMemberTxns, malformedBookable, detail };
}

// ---------------------------------------------------------------------------
// Bookable → interpreted-document traceability. Built from the Stage-2
// interpretation files (normalizeInterp, shared with interpret-stage.ts) so a
// bookable_doc is only trusted when it names a document_no that really exists
// — catching a sherlock hallucination or a stale carry-over from a bad draft.
//
// One legitimate exception: a source document with NO printed document number
// (accounting_facts.document_no: null, watson flags document_no_not_found) is
// still a real bookable — sherlock invents a synthetic "NODOC-<seg>-..."
// placeholder id for it (see the 345 fixture's txn-172/txn-173). That's traced
// by structural consistency instead: the transaction must actually declare a
// null-document_no member, AND at least one interpretation in a referenced
// segment must genuinely have a blank document_no (so the placeholder isn't
// covering for a document that really does have a number sherlock ignored).
// ---------------------------------------------------------------------------

export interface SegDocIndex {
	docNos: Set<string>; // normText(document_no) for every named document in this segment
	hasBlankDocNo: boolean; // ≥1 document in this segment has no document_no at all
}

function docNoField(facts: any): string {
	return String(facts?.document_no ?? facts?.document_number ?? "").trim();
}

// Pure: build the per-segment document index from already-parsed interpretation
// JSON (one entry per file actually present for that segment). No disk I/O —
// callers that have real files use `buildSegmentDocIndex` below.
export function docIndexFromInterpretations(
	interpsBySeg: Map<string, unknown[]>,
): Map<string, SegDocIndex> {
	const idx = new Map<string, SegDocIndex>();
	for (const [segId, interps] of interpsBySeg) {
		const entry: SegDocIndex = { docNos: new Set(), hasBlankDocNo: false };
		for (const interp of interps) {
			const norm = normalizeInterp(interp);
			for (const doc of norm.docs) {
				const raw = docNoField(doc.facts);
				if (raw) entry.docNos.add(normText(raw));
				else entry.hasBlankDocNo = true;
			}
		}
		idx.set(segId, entry);
	}
	return idx;
}

function segDir(client: string, segId: string): string {
	return join(client, "ข้อมูลระบบ", "_segments", segId);
}

function interpFiles(client: string, segId: string): string[] {
	const d = segDir(client, segId);
	if (!existsSync(d)) return [];
	return readdirSync(d)
		.filter((f) => /^interpretation.*\.json$/.test(f))
		.map((f) => join(d, f));
}

// I/O wrapper: read every interpretation file for the given segments off disk,
// then defer to the pure docIndexFromInterpretations.
export function buildSegmentDocIndex(client: string, segIds: Iterable<string>): Map<string, SegDocIndex> {
	const interpsBySeg = new Map<string, unknown[]>();
	for (const segId of segIds) {
		const interps: unknown[] = [];
		for (const file of interpFiles(client, segId)) {
			try {
				interps.push(loadJson(file));
			} catch {
				// unparsable interpretation file — leave it out of the index; the
				// interpret-stage grader is the one that reports this as a shape bug.
			}
		}
		interpsBySeg.set(segId, interps);
	}
	return docIndexFromInterpretations(interpsBySeg);
}

// Pure: which of a transaction's bookable_docs fail to trace to a real
// interpreted document (see the module doc for the NODOC placeholder rule).
export function untracedBookables(
	txn: LinkTransaction,
	segIndex: Map<string, SegDocIndex>,
): string[] {
	const members: LinkMember[] = Array.isArray(txn.members) ? (txn.members as LinkMember[]) : [];
	const segs = new Set<string>();
	if (Array.isArray(txn.segments))
		for (const s of txn.segments) if (typeof s === "string") segs.add(s);
	for (const m of members) if (typeof m.segment === "string") segs.add(m.segment);

	const hasNullMember = members.some((m) => m.document_no == null);
	const anyBlankDocSeg = [...segs].some((s) => segIndex.get(s)?.hasBlankDocNo);

	const bookable = Array.isArray(txn.bookable_docs) ? (txn.bookable_docs as unknown[]) : [];
	const untraced: string[] = [];
	for (const b of bookable) {
		const raw = String(b ?? "").trim();
		if (!raw) continue;
		const norm = normText(raw);
		const foundDirect = [...segs].some((s) => segIndex.get(s)?.docNos.has(norm));
		if (foundDirect) continue;
		if (/^NODOC-/.test(raw) && hasNullMember && anyBlankDocSeg) continue; // legitimate no-doc-no placeholder
		untraced.push(raw);
	}
	return untraced;
}

// ---------------------------------------------------------------------------
// Stage-4 completeness gate: group-skeleton's planGroups (groups-lib.ts)
// throws when a bookable document was dropped between Stage-2 and grouping,
// and the script exits non-zero with a message listing the (segment_id /
// document_no) pairs. A malformed-input usage error also exits non-zero with
// a different message, so only trust the dropped-pairs list when the marker
// text is present; the raw output is kept either way as completenessDetail.
// ---------------------------------------------------------------------------

const DROPPED_RE =
	/dropped between Stage-2 and grouping \(segment_id \/ document_no\): (.+?) — links\.yaml/;

export function extractDroppedPairs(out: string): string[] {
	const m = out.match(DROPPED_RE);
	if (!m) return [];
	return m[1]
		.split(";")
		.map((s) => s.trim())
		.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Cross-session cluster agreement. A "cluster" here IS its content (the
// member-set + bookable_docs), so agreement is multiset intersection/union
// over sessions' canonicalized cluster keys — not a per-field comparison like
// interpret-stage's doc agreement. Reuses sherlock.ts's normalizeLinks for the
// canonical member-set key; extends it with the sorted bookable_docs so a
// cluster only counts as "identical" when both membership AND booking agree.
// ---------------------------------------------------------------------------

// A control char no real segment id / document_no / bookable_doc can
// contain, so `key + SEP + bookable` never collides across different
// (key, bookable) pairs.
const EXT_KEY_SEP = "\x01";

function extKey(c: Cluster): string {
	return `${c.key}${EXT_KEY_SEP}${c.bookable.join(",")}`;
}

interface MultisetEntry {
	count: number;
	multi: boolean;
}

export function toClusterMultiset(clusters: Cluster[]): Map<string, MultisetEntry> {
	const m = new Map<string, MultisetEntry>();
	for (const c of clusters) {
		const k = extKey(c);
		const e = m.get(k);
		if (e) e.count++;
		else m.set(k, { count: 1, multi: c.multi });
	}
	return m;
}

export interface ClusterAgreement {
	agreement: string; // "identical/total (pct%)"
	identical: number;
	total: number;
	multi: { agreement: string; identical: number; total: number };
}

function pctLine(n: number, d: number): string {
	return d ? `${n}/${d} (${((n / d) * 100).toFixed(1)}%)` : "n/a";
}

// Multiset intersection (min count per key, summed) over union (max count per
// key, summed) across ALL sessions — "identical" = reproduced with the same
// multiplicity in every session; "total" = every distinct cluster instance any
// session produced. multi-doc clusters (≥2 members) are reported separately —
// the hard case where cross-segment evidence has to agree, not just a lone doc.
export function crossSessionClusterAgreement(sessionsClusters: Cluster[][]): ClusterAgreement {
	const multisets = sessionsClusters.map(toClusterMultiset);
	const allKeys = new Set<string>();
	multisets.forEach((m) => m.forEach((_, k) => allKeys.add(k)));

	let identical = 0;
	let total = 0;
	let multiIdentical = 0;
	let multiTotal = 0;
	for (const key of allKeys) {
		const counts = multisets.map((m) => m.get(key)?.count ?? 0);
		const isMulti = multisets.find((m) => m.has(key))!.get(key)!.multi;
		const minC = Math.min(...counts);
		const maxC = Math.max(...counts);
		identical += minC;
		total += maxC;
		if (isMulti) {
			multiIdentical += minC;
			multiTotal += maxC;
		}
	}
	return {
		agreement: pctLine(identical, total),
		identical,
		total,
		multi: { agreement: pctLine(multiIdentical, multiTotal), identical: multiIdentical, total: multiTotal },
	};
}

// ---------------------------------------------------------------------------
// Tier-B: each session's links.yaml vs the verified expected set, when one
// exists. No fixtures/link/<fixture>.expected.yaml has been curated yet, so
// this is always null in practice — but the drop-in is live: adding that file
// is enough to turn tier-B on for every future run.
// ---------------------------------------------------------------------------

function expectedLinksPath(fixture: string): string | null {
	const p = join(DATA_ROOT, "fixtures", "link", `${fixture}.expected.yaml`);
	return existsSync(p) ? p : null;
}

const EMPTY_SHERLOCK_GRADE: SherlockGrade = {
	clusters_expected: 0,
	clusters_exact: 0,
	bookable_correct: 0,
	multi_expected: 0,
	multi_exact: 0,
	missing_clusters: [],
	spurious_clusters: [],
	bookable_mismatches: [],
};

function gradeSessionsVsExpected(
	expectedPath: string,
	sessionLinksPaths: (string | null)[],
): SherlockGrade[] {
	return sessionLinksPaths.map((p) => (p ? gradeLinks(expectedPath, p) : EMPTY_SHERLOCK_GRADE));
}

// ---------------------------------------------------------------------------
// Per-session grading
// ---------------------------------------------------------------------------

interface LinkSessionGrade extends SessionGrade {
	transactions: number;
	shapeOk: boolean;
	shapeDetail: string;
	untraced: string[]; // "<txn-id>: <bookable, bookable, …>" entries
	completenessOk: boolean;
	droppedPairs: string[]; // "seg-004 / 12345" — only when group-skeleton names them
	completenessDetail: string;
}

function gradeSession(
	ctx: StageRunContext,
	s: number,
): { grade: LinkSessionGrade; clusters: Cluster[]; linksPath: string | null } {
	const client = ctx.clientDir(s);
	const linksPath = join(client, "ข้อมูลระบบ/_doc_groups/links.yaml");
	const linksExists = existsSync(linksPath);

	let doc: LinksDoc | null = null;
	let loadError: string | null = null;
	if (!linksExists) loadError = "links.yaml missing";
	else {
		try {
			doc = loadYaml<LinksDoc>(linksPath);
		} catch (e) {
			loadError = `parse error: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	const shape = loadError
		? { ok: false, transactionCount: 0, emptyMemberTxns: [], malformedBookable: [], detail: loadError }
		: validateShape(doc);

	const segIds = new Set<string>();
	for (const t of doc?.transactions ?? []) {
		if (Array.isArray(t.segments)) for (const sg of t.segments) if (typeof sg === "string") segIds.add(sg);
		if (Array.isArray(t.members))
			for (const m of t.members as LinkMember[]) if (typeof m.segment === "string") segIds.add(m.segment);
	}
	const segIndex = buildSegmentDocIndex(client, segIds);
	const untraced: string[] = [];
	for (const t of doc?.transactions ?? []) {
		const u = untracedBookables(t, segIndex);
		if (u.length) {
			const id = typeof t.transaction_id === "string" ? t.transaction_id : "?";
			untraced.push(`${id}: ${u.join(", ")}`);
		}
	}

	// completeness gate — group-skeleton must exit 0 (writes into this session's
	// own clone; never touches the fixture).
	const gs = ctx.script("group-skeleton", client);
	const completenessOk = gs.code === 0;
	const droppedPairs = completenessOk ? [] : extractDroppedPairs(gs.out);
	const completenessDetail = completenessOk
		? "ok"
		: droppedPairs.length
			? `${droppedPairs.length} dropped`
			: `exit ${gs.code}: ${gs.out.trim().slice(0, 200)}`;

	const pass = shape.ok && untraced.length === 0 && completenessOk;

	const clusters = linksExists && !loadError ? normalizeLinks(linksPath) : [];

	return {
		grade: {
			session: s,
			transactions: shape.transactionCount,
			shapeOk: shape.ok,
			shapeDetail: shape.detail,
			untraced,
			completenessOk,
			droppedPairs,
			completenessDetail,
			pass,
		},
		clusters,
		linksPath: linksExists && !loadError ? linksPath : null,
	};
}

export const linkStageGrader: StageGrader = {
	stage: "link",
	grade(ctx: StageRunContext): StageGradeResult {
		const { run, runId } = ctx;
		const graded: LinkSessionGrade[] = [];
		const clustersBySession: Cluster[][] = [];
		const linksPaths: (string | null)[] = [];

		for (let s = 1; s <= run.sessions; s++) {
			const { grade, clusters, linksPath } = gradeSession(ctx, s);
			graded.push(grade);
			clustersBySession.push(clusters);
			linksPaths.push(linksPath);
		}

		const agreement = crossSessionClusterAgreement(clustersBySession);
		const reliability = graded.filter((g) => g.pass).length;

		const expectedPath = expectedLinksPath(run.fixture);
		const tierB = expectedPath ? gradeSessionsVsExpected(expectedPath, linksPaths) : null;
		const groundTruth = tierB
			? {
					expected_clusters: tierB[0]?.clusters_expected ?? 0,
					min_clusters_exact: tierB.reduce((m, t) => Math.min(m, t.clusters_exact), Number.POSITIVE_INFINITY),
					min_bookable_correct: tierB.reduce((m, t) => Math.min(m, t.bookable_correct), Number.POSITIVE_INFINITY),
					per_session: tierB.map((t, i) => ({
						session: i + 1,
						clusters_exact: `${t.clusters_exact}/${t.clusters_expected}`,
						bookable_correct: `${t.bookable_correct}/${t.clusters_exact}`,
						multi_exact: `${t.multi_exact}/${t.multi_expected}`,
						missing: t.missing_clusters,
						spurious: t.spurious_clusters,
					})),
				}
			: null;

		const summary = {
			reliability: `${reliability}/${run.sessions}`,
			cluster_agreement: agreement.agreement,
			multi_cluster_agreement: agreement.multi.agreement,
			clusters_compared: agreement.total,
			ground_truth: groundTruth,
			per_session: graded.map((g) => ({
				session: g.session,
				pass: g.pass,
				transactions: g.transactions,
				shape: g.shapeOk ? "ok" : g.shapeDetail,
				untraced: g.untraced.length,
				completeness: g.completenessOk ? "ok" : g.completenessDetail,
			})),
		};

		const scoreboard: string[] = [];
		scoreboard.push(`\nstage-${ctx.stage} · ${run.fixture} · ${run.sessions} sessions · run ${runId}`);
		scoreboard.push(
			`  reliability ${summary.reliability} · cluster-agreement ${agreement.agreement} · ` +
				`multi-cluster ${agreement.multi.agreement} · clusters compared ${agreement.total}`,
		);
		graded.forEach((g) =>
			scoreboard.push(
				`  s${g.session}: ${g.pass ? "PASS" : "FAIL"} · txns ${g.transactions} · ` +
					`shape ${g.shapeOk ? "ok" : g.shapeDetail} · untraced ${g.untraced.length} · ` +
					`completeness ${g.completenessOk ? "PASS" : "BLOCK"}`,
			),
		);
		graded.forEach((g) => {
			if (g.untraced.length) scoreboard.push(`  ⚠ s${g.session} untraced bookables: ${g.untraced.join(" | ")}`);
			if (!g.completenessOk)
				scoreboard.push(
					`  ⚠ s${g.session} completeness BLOCK: ${g.droppedPairs.length ? g.droppedPairs.join(", ") : g.completenessDetail}`,
				);
		});

		if (groundTruth) {
			scoreboard.push(`\n  ground truth (${groundTruth.expected_clusters} expected clusters)`);
			groundTruth.per_session.forEach((t) =>
				scoreboard.push(
					`  s${t.session}: clusters ${t.clusters_exact} · bookable ${t.bookable_correct} · multi ${t.multi_exact}`,
				),
			);
		} else {
			scoreboard.push("\n  ground truth: no expected set (skipped tier-B)");
		}

		return { sessionGrades: graded, summary, scoreboard };
	},
};
