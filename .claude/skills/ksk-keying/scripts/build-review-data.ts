// Stage 5b — build every group's review-data.json deterministically
// ("agents judge, scripts copy"; formerly one ksk-lestrade call per group).
//
// For each manifest group whose folder holds interpretation.json +
// categorize.json, merges them (plus CLIENT.md's default_buyer for missing
// buyer fields) into review-data.json — schema ksk_review_group_data.v1 for
// document buckets, ksk_review_statement_data.v1 for bank_statement
// (references/review-data-schema.md). Run after the poirot categorize wave;
// then the parent runs review-groups once.
//
// Always rebuild, merge on the way in (wayfinder #35/#41/#43): every group
// with both inputs present is rebuilt on every run — a Stage-3 "repair"
// re-run restarts the whole client-month at Stage 1, so this is the only way
// a re-run's improved AI output ever reaches the reviewer. A human's saved
// review edits (the console review app writes value/account corrections
// straight into review-data.json) are preserved instead by a three-way merge
// against `review-data.ai.json` — a pristine sidecar of the AI's own output,
// written alongside review-data.json on every build, that review-data-merge.ts
// uses as the "what did the AI say last time" baseline. See
// review-data-merge.ts and references/review-data-schema.md for the full
// merge contract (what carries forward, what a genuine AI change overrides,
// and what gets recorded as a dropped edit).
//
// Exit codes: 0 groups built (even when some human edits were dropped or a
// merge ran degraded/bailed — those are recorded, not fatal), 1 some groups
// skipped (missing inputs — re-dispatch those stages), 2 usage/malformed
// input, 3 preflight failed (the pipeline's OWN output is inconsistent — a
// page double-claimed or a document dropped; see preflightBuiltGroups). Exit
// 3 is NOT a usage error and must never be treated like one: the input the
// operator gave this script was fine, but writing review-data.json from it
// would let a real client document silently vanish behind the final Ledger
// Gate. Nothing is written to any group on exit 3, and this run also writes
// a stale-build sentinel (ข้อมูลระบบ/_pages/build-review-data-stale.yaml, see
// paths.ts's buildReviewDataStalePath) so that a *previous* run's
// review-data.json files left on disk cannot be silently evaluated as
// current by anything downstream (ledger.ts's final gate refuses to pass
// while the sentinel is present, regardless of who invokes it or in what
// order — see ledger.ts). The correct response to exit 3 is always: fix the
// underlying inconsistency (dropped document, misrouted group, …) and
// re-dispatch this script, never to proceed past it or retry blindly hoping
// it clears itself.

import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { stringify as yamlStringify } from "yaml";
import { docGroupsDir, buildReviewDataStalePath, pagesDir } from "./paths";
import {
	buildDocumentReviewData,
	buildStatementReviewData,
	evidenceClaimedPageCounts,
	stage2DocumentCountByPage,
	withEvidenceClaims,
	type CategorizeFile,
	type DefaultBuyer,
	type DocumentUnit,
	type GroupInterpretation,
	type GroupPlan,
	type InterpFile,
} from "./groups-lib";
import {
	loadClientProfile,
	loadGroupManifest,
	loadInterpretations,
	loadInventoryFileSet,
	readJson,
	resolveClientDir,
} from "./groups-io";
import { inventorySourceError, norm } from "./unit-key";
import {
	appendDroppedEdits,
	mergeReviewData,
	DROPPED_EDITS_FILE,
	FLAG_BAILED,
	FLAG_NO_BASELINE,
	REVIEW_DATA_AI_FILE,
	REVIEW_DATA_FILE,
	REVIEW_DATA_SUPERSEDED_FILE,
	flagLostEdits,
	flagLostSkips,
	type BaselineState,
	type CurrentState,
	type DroppedEditsRebuild,
	type MergeOutcome,
} from "./review-data-merge";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Reconstructs the flags a PAST rebuild would have injected, from its
// dropped-edits.json entry — used to re-inject a sticky warning (see
// stickyFlagsFor below) when a later, clean rebuild would otherwise erase the
// only console-visible trace that an earlier rebuild dropped a human edit.
function reconstructFlags(entry: DroppedEditsRebuild): string[] {
	const flags: string[] = [];
	const skipCount = entry.dropped.filter((d) => d.field === "skipped").length;
	const otherCount = entry.dropped.length - skipCount;
	if (skipCount > 0) flags.push(flagLostSkips(skipCount));
	if (otherCount > 0) flags.push(flagLostEdits(otherCount));
	if (entry.outcome === "degraded") flags.push(FLAG_NO_BASELINE);
	if (entry.outcome === "bailed") flags.push(FLAG_BAILED);
	return flags;
}

// Sticky-warning check (adversarial review finding #1): review_flags is taken
// fresh from `fresh` on every run and only gets flag-injected when THAT run
// itself drops something. Left alone, any later, otherwise-harmless rebuild
// over unchanged sources (a sequencer retry, a repair aimed at a different
// group in the same client-month) silently erases the review_flags entry and
// the forced needs_attention that a lossy/degraded rebuild injected — while
// the lost edit stays lost and invisible, because no console page reads
// dropped-edits.json or review-data.superseded.json. So: if this run injected
// no flags of its own, but the last dropped-edits.json entry pertains to
// EXACTLY this hash (same interpretation.json + categorize.json — the loss
// has not been superseded by newer AI output that might have re-supplied the
// value), re-inject the same flags and re-force needs_attention. Cleared
// automatically the moment the source hash changes (a real re-read either
// fixes the field, in which case nothing is dropped and no entry is written
// this run, or drops it again under the new hash, in which case this run's
// own flags cover it).
function stickyFlagsFor(existingDroppedRaw: unknown, hash: string): string[] {
	const rebuilds = isRecord(existingDroppedRaw) && Array.isArray(existingDroppedRaw.rebuilds)
		? (existingDroppedRaw.rebuilds as DroppedEditsRebuild[])
		: [];
	const last = rebuilds[rebuilds.length - 1];
	if (!last || last.source_content_hash !== hash) return [];
	return reconstructFlags(last);
}

function usage(): never {
	console.error(`Usage: bun run build-review-data -- <client-dir>

Merges each group's interpretation.json + categorize.json (+ CLIENT.md
default_buyer) into review-data.json. Run group-populate / ksk-marple populate
and the poirot categorize wave first; run review-groups after.

Every group with both inputs present is rebuilt on every run — a saved
reviewer edit is carried forward by merging against review-data.ai.json (a
pristine AI-output baseline written alongside review-data.json); a genuine AI
change on a rebuild wins over a stale human edit, and every dropped edit is
recorded in dropped-edits.json and flagged in review_flags for the reviewer.
See source_content_hash / review-data.ai.json in the written files.

Exit codes: 0 built (some human edits may have been dropped/flagged — see
stdout), 1 groups skipped for missing inputs, 2 usage/malformed input.
`);
	process.exit(2);
}

function defaultBuyerOf(profile: Record<string, unknown> | null): DefaultBuyer | null {
	const raw = profile?.default_buyer;
	if (!raw || typeof raw !== "object") return null;
	const buyer = raw as { name?: unknown; tax_id?: unknown };
	return {
		name: typeof buyer.name === "string" ? buyer.name : null,
		tax_id: typeof buyer.tax_id === "string" ? buyer.tax_id : null,
	};
}

// Content hash stamped into (and compared against) a group's review-data.json
// as source_content_hash — the join separator is arbitrary, it just has to be
// stable and never appear naturally at a text/text boundary in a way that
// would make two different (interp, categorize) pairs collide. Deliberately
// does NOT fold in CLIENT.md's default_buyer: changing the formula would
// invalidate the stamp on every group already on disk and push the entire
// installed base through a degraded merge on the first run after this ships
// (see review-data-merge.ts's baseline-selection comment for the rationale).
function contentHash(...parts: string[]): string {
	return createHash("sha256").update(parts.join(" ")).digest("hex");
}

// Reads a JSON file for merge input purposes: distinguishes "does not exist"
// from "exists but is not parseable JSON" from "parsed fine" so the merge can
// never silently collapse an unreadable human document to "absent" (that
// would discard a human's edits instead of recording them as unmergeable).
function loadState(path: string): BaselineState & CurrentState {
	if (!existsSync(path)) return { kind: "absent" };
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return { kind: "unreadable", detail: error instanceof Error ? error.message : String(error) };
	}
	try {
		const data = JSON.parse(text) as Record<string, unknown>;
		if (data === null || typeof data !== "object" || Array.isArray(data))
			return { kind: "unreadable", detail: "parsed JSON is not an object" };
		return { kind: "present", data };
	} catch (error) {
		return { kind: "unreadable", detail: error instanceof Error ? error.message : String(error) };
	}
}

// Same temp-file-then-rename pattern as console/app/review-edit.ts's
// writeReviewDataFile / dispositions-writer.ts — a console reviewer can have
// a review page open on this same folder while a rebuild runs, and a
// half-written review-data.json would 500 that live page. A monotonic
// per-process counter (rather than process.pid, undeclared in this project's
// node:process ambient types) keeps concurrent writes within one run from
// colliding on the same tmp name.
let tmpSeq = 0;
function tmpSuffix(): string {
	tmpSeq += 1;
	return `${Date.now()}-${tmpSeq}`;
}

function writeJsonAtomic(path: string, data: unknown): void {
	const tmpPath = `${path}.tmp-${tmpSuffix()}`;
	writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
	renameSync(tmpPath, path);
}

function writeTextAtomic(path: string, text: string): void {
	const tmpPath = `${path}.tmp-${tmpSuffix()}`;
	writeFileSync(tmpPath, text);
	renameSync(tmpPath, path);
}

export type GroupEditLoss = {
	groupId: string;
	path: string; // manifest group path, e.g. "expense/vat/seg-001-INV-001"
	outcome: MergeOutcome;
	dropped: number;
	lostSkips: number;
	/** A console save landed on review-data.json between our read and our
	 *  write; the merge was redone once against the newer bytes so the
	 *  in-flight save wasn't silently discarded (see the race guard below). */
	raceDetected?: boolean;
};

export type BuildResult = {
	built: number;
	carried: number;
	/** groups NOT built because interpretation.json/categorize.json are missing
	 *  — unrelated to a reviewer's per-row `skipped` flag. */
	skipped: string[];
	lostEdits: GroupEditLoss[];
	/** group ids whose manifest.yaml entry predates the `evidence_units` field
	 *  — see the comment where this is collected in runBuildReviewData. */
	preMigrationEvidenceGroups: string[];
};

// One resolved page claim out of a group's freshly built review-data (both
// document `pages[]` entries and a statement's single `source` block, the two
// shapes buildDocumentReviewData/buildStatementReviewData produce).
// `linesOwner` is true only for a claim carrying the group's OWN booking
// facts/lines (GroupDocument.lines_owner) — a shared supporting document cited
// as EVIDENCE by several groups (a receipt behind two different invoices) is
// legitimate and deliberately excluded from the reciprocal-claim check below;
// only two groups both claiming to OWN the identical physical page as their
// own transaction is the client-345 failure signature.
type ResolvedClaim = { file: string; page: number; linesOwner: boolean };

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function claimPages(entry: Record<string, unknown>): number[] {
	const pages = new Set<number>();
	if (Array.isArray(entry.source_pages))
		for (const p of entry.source_pages) if (typeof p === "number") pages.add(p);
	if (typeof entry.source_page === "number") pages.add(entry.source_page);
	return [...pages];
}

// Reads the page claims out of one group's freshly built review-data — the
// SAME shape written to disk (source_src/source_page/source_pages on document
// pages[] entries; a single top-level source block for a statement) — so
// preflight validation sees exactly what would be persisted, not a
// reconstruction from the group interpretation.
function claimsFromFresh(fresh: Record<string, unknown>): { file: string; page: number }[] {
	const out: { file: string; page: number }[] = [];
	if (Array.isArray(fresh.pages)) {
		for (const raw of fresh.pages) {
			if (!isPlainObject(raw)) continue;
			const file = typeof raw.source_src === "string" ? raw.source_src : null;
			if (!file) continue;
			for (const page of claimPages(raw)) out.push({ file, page });
		}
	}
	if (isPlainObject(fresh.source)) {
		const file = typeof fresh.source.source_src === "string" ? fresh.source.source_src : null;
		if (file) for (const page of claimPages(fresh.source)) out.push({ file, page });
	}
	return out;
}

// lines_owner-only claims, read from the GROUP INTERPRETATION (not the built
// review-data — buildDocumentReviewData already collapses per-file, losing
// which physical pages were lines_owner vs evidence-only). Statement groups
// have no lines_owner concept (single source block, no per-document split) —
// their claims never enter the reciprocal check, same as the inventory
// omission is harmless there (a statement's own file is always real).
function ownedPagesOf(interp: GroupInterpretation): { file: string; page: number }[] {
	const out: { file: string; page: number }[] = [];
	for (const doc of interp.documents ?? []) {
		if (!doc.lines_owner) continue;
		const file = doc.source_file ?? doc.artifact ?? null;
		if (!file) continue;
		const pages = doc.source_pages?.length ? doc.source_pages : doc.source_page != null ? [doc.source_page] : [];
		for (const page of pages) out.push({ file, page });
	}
	return out;
}

export type PreflightIssue = { groupId: string; groupPath: string; message: string };

// Structural validation that must run BEFORE anything is written this pass —
// two independent client-345 defects, both proven on disk:
//   (1) a claim's source_src names a pipeline artifact path (under ข้อมูลระบบ/)
//       or a file absent from the Inventory — it can never reach Reviewed at
//       the Page Ledger no matter how "clean" the run looks (unit-key.ts's
//       inventorySourceError).
//   (2) a page's number of lines_owner claimants doesn't match how many
//       DISTINCT approved-bookable Stage-2 documents actually cover that
//       physical page. Two readings of the same client-345 signature:
//       TOO MANY owners is the original bug — seg-012's page 77 (ONE Stage-2
//       document) claimed as primary by three separate agent-populated
//       groups. TOO FEW owners is the mirror case Fix 1 (groups-lib.ts's
//       isApprovedBookable / findDroppedBookableUnits) can only bound at the
//       SEGMENT level (a count, because no page is known at plan time) — once
//       Fix 1 lets the linker give unnumbered documents their own groups,
//       page 77 legitimately holds THREE distinct documents, and a run where
//       only one or two of them ended up owned by a group would pass Fix 1's
//       segment-level count (3 slots created) while still silently dropping
//       a document at the page level (two groups pointed at the same slot,
//       one physical page left with no owner at all). This is the exact
//       "reciprocal, page-level check" Fix 1's own comment names as
//       deliberately deferred to here — it is not double-reporting Fix 1's
//       segment shortfall, it is the finer-grained check Fix 1 cannot do.
//       EQUAL counts (however many, even >1) is not an issue at all — that is
//       the correct, once-broken-now-fixed shape for a genuinely-shared page.
//       NOTE this is a Stage-4/5-vs-Stage-2 CONSISTENCY check, not
//       independent ground truth about the physical page — the doc count
//       comes from Stage-2's OWN documents[] entries (see groups-lib.ts's
//       stage2DocumentCountByPage), so a Stage-2 undercount (ksk-watson
//       reading several physical documents on a page as one) would still
//       satisfy this preflight while a real document goes unclaimed. That
//       residual gap is exactly why the final Ledger Gate's independent
//       unaccounted-unit check must never be weakened on the strength of
//       this preflight passing.
// Exits the whole run non-zero, naming every offending group, rather than
// writing an unmatchable or double-claimed review-data.json and letting the
// final Ledger Gate discover it three stages later (or, worse, not discover
// it at all when a page happens to go unclaimed by luck).
export function preflightBuiltGroups(
	entries: {
		groupId: string;
		groupPath: string;
		category: string;
		interp: GroupInterpretation;
		fresh: Record<string, unknown>;
		// Optional so existing call sites/tests built before this check existed
		// don't have to name an empty array explicitly — absent is exactly
		// equivalent to "no evidence_units", never treated as a failure to report.
		evidenceUnits?: DocumentUnit[];
	}[],
	inventoryFiles: Set<string> | null,
	stage2DocCountByPage: Map<string, number>,
	// Same shared helper (groups-lib.ts's evidenceClaimedPageCounts) that
	// findDroppedBookableUnits's segment-level check reads — see that
	// function's own comment for the full defect history. Optional/defaulted
	// so existing call sites that never exercise the evidence exemption don't
	// have to name an empty map explicitly.
	evidenceClaimedCounts: Map<string, number> = new Map(),
): PreflightIssue[] {
	const issues: PreflightIssue[] = [];
	if (inventoryFiles) {
		for (const entry of entries) {
			for (const claim of claimsFromFresh(entry.fresh)) {
				const error = inventorySourceError(claim.file, inventoryFiles);
				if (error) issues.push({ groupId: entry.groupId, groupPath: entry.groupPath, message: error });
			}
		}
	}
	const owners = new Map<string, { groupId: string; groupPath: string }[]>();
	for (const entry of entries) {
		if (entry.category === "bank_statement") continue;
		for (const { file, page } of ownedPagesOf(entry.interp)) {
			const key = `${norm(file)}#p${page}`;
			const list = owners.get(key) ?? [];
			list.push({ groupId: entry.groupId, groupPath: entry.groupPath });
			owners.set(key, list);
		}
	}
	// BUG-2/BUG-4 FIX (client _345, pages 62/63/80): iterating only
	// `owners.keys()` made a page with ZERO owning groups structurally
	// invisible to this check — the very case the block comment above claims
	// to catch ("one physical page left with no owner at all"). A Stage-2
	// document that no group claims at all never becomes a key in `owners`,
	// so the `ownerCount < docCount` branch below could only ever fire for
	// PARTIAL under-ownership (some owners, too few), never total loss.
	// Iterate the union of both maps' keys instead, so a page Stage-2 recorded
	// with zero owning groups is reported rather than silently skipped.
	// `stage2DocCountByPage` is already restricted by the caller to segments
	// this run actually built groups for (see runBuildReviewData), so this
	// union does not flag pages of segments not yet grouped.
	const allKeys = new Set([...owners.keys(), ...stage2DocCountByPage.keys()]);
	for (const key of allKeys) {
		// No Stage-2 record at all for this exact (file, page) key means there is
		// nothing honest to compare the owner count against — NOT the same as a
		// confirmed zero. Skip rather than invent a proxy (mirrors the
		// inventoryFiles-null precedent above); in a real run this never happens,
		// since populate only ever copies a page a Stage-2 interpretation already
		// named.
		if (!stage2DocCountByPage.has(key)) continue;
		const claimants = owners.get(key) ?? [];
		const distinctGroups = new Set(claimants.map((c) => c.groupId));
		const ownerCount = distinctGroups.size;
		const docCount = stage2DocCountByPage.get(key) as number;
		if (ownerCount === docCount) continue;
		// EXEMPTION (evidence-page-claims fix): a document Stage-2 recorded on
		// this page that no group claims as PRIMARY may still be legitimately
		// accounted for — claimed as SUPPORTING EVIDENCE by some cluster
		// instead. withEvidenceClaims is what turns an evidence_units member
		// into an actual lines_owner:false page claim in review-data, and such
		// a claim correctly has no owning group — that is the shape of a
		// once-broken-now-fixed shared page, not a dropped document.
		// evidenceClaimedCounts is groups-lib.ts's evidenceClaimedPageCounts,
		// the SAME shared helper findDroppedBookableUnits's segment-level check
		// reads — see that function's comment for why the two must never
		// compute this independently again. Only ever covers a SHORTFALL
		// (ownerCount < docCount); a page with MORE owners than Stage-2
		// documents is a distinct bug (two groups both claiming the same page
		// as primary) that no evidence claim can explain away, so it is never
		// exempted here.
		if (ownerCount < docCount) {
			const evidenceCount = evidenceClaimedCounts.get(key) ?? 0;
			if (ownerCount + evidenceCount >= docCount) continue;
		}
		const groupList = claimants.map((c) => c.groupPath).join(", ") || "(none)";
		const message =
			ownerCount > docCount
				? `page "${key}" is claimed as the PRIMARY booking document by ${ownerCount} different group(s) (${groupList}), but Stage-2 recorded only ${docCount} distinct document(s) on that page — at most ${docCount} of these groups can be the document actually on that page; the rest were populated against the wrong page (populate must re-open the source and cite each group's own distinct page)`
				: `page "${key}" holds ${docCount} distinct Stage-2 document(s) but only ${ownerCount} group(s) claim ownership of it as PRIMARY (${groupList}) — ${docCount - ownerCount} document(s) actually on this page have no owning group (the page-level counterpart of findDroppedBookableUnits's segment-level shortfall — a group was populated against the wrong page, or the linker dropped a document Fix 1's segment count happened to net out to zero)`;
		issues.push({ groupId: [...distinctGroups].join(", ") || "(none)", groupPath: groupList, message });
	}

	// (3) The RECIPROCAL of the client-345 "evidence pages vanish on luck"
	// defect this whole file was extended for: every evidence_unit a group's
	// OWN links.yaml transaction cluster names (GroupPlan.evidence_units,
	// carried on the manifest) must be a claim in that group's freshly built
	// review-data. runBuildReviewData already calls withEvidenceClaims before
	// this preflight runs specifically to make that true by construction — so
	// under normal operation this loop should never fire. It stays as an
	// independent check anyway (the same "verify, don't just trust the one fix"
	// posture as the owners loop above): a future code path that builds `fresh`
	// without going through withEvidenceClaims, or an evidence_unit whose page
	// genuinely can't be resolved, would otherwise silently reproduce the exact
	// defect this file exists to catch. Bank-statement groups have no
	// evidence_units concept (see withEvidenceClaims) and are skipped, same as
	// the owners check above.
	for (const entry of entries) {
		if (entry.category === "bank_statement") continue;
		const claimedPages = new Set(claimsFromFresh(entry.fresh).map((c) => `${norm(c.file)}#p${c.page}`));
		const freshPages = Array.isArray(entry.fresh.pages) ? (entry.fresh.pages as unknown[]) : [];
		for (const unit of entry.evidenceUnits ?? []) {
			if (unit.source_sheet != null) {
				const claimed = freshPages.some(
					(p) =>
						isPlainObject(p) &&
						p.source_src === unit.source_file &&
						p.source_sheet === unit.source_sheet,
				);
				if (!claimed)
					issues.push({
						groupId: entry.groupId,
						groupPath: entry.groupPath,
						message: `evidence unit "${unit.unit_key}" (${unit.source_file} [${unit.source_sheet}]) is named by this group's own transaction cluster but is not claimed by any page in its built review-data — populate (script or ksk-marple) must copy this document into the group's interpretation.json documents[], or build-review-data's evidence-claim injection failed to add it`,
					});
				continue;
			}
			if (unit.source_page == null) continue; // no page/sheet identity at all — nothing to verify
			const key = `${norm(unit.source_file)}#p${unit.source_page}`;
			if (!claimedPages.has(key))
				issues.push({
					groupId: entry.groupId,
					groupPath: entry.groupPath,
					message: `evidence unit "${unit.unit_key}" (${unit.source_file} p.${unit.source_page}) is named by this group's own transaction cluster but is not claimed by any page in its built review-data — populate (script or ksk-marple) must copy this document into the group's interpretation.json documents[], or build-review-data's evidence-claim injection failed to add it`,
				});
		}
	}
	return issues;
}

// Thrown instead of a bare process.exit(2) when preflightBuiltGroups finds a
// cross-group inconsistency — distinguishes "the pipeline's own output
// doesn't add up" from a genuine usage/malformed-input error, and keeps
// runBuildReviewData callable from tests (a process.exit here would kill the
// test runner itself). main() is the only place this becomes exit code 3.
export class PreflightFailedError extends Error {
	issues: PreflightIssue[];
	constructor(issues: PreflightIssue[]) {
		super(
			`${issues.length} group(s) failed preflight validation — nothing written this run:\n` +
				issues.map((issue) => `  - ${issue.groupPath} (${issue.groupId}): ${issue.message}`).join("\n"),
		);
		this.name = "PreflightFailedError";
		this.issues = issues;
	}
}

const STALE_SENTINEL_SCHEMA = "ksk_build_review_data_stale.v1";

// Writes/refreshes the stale-build sentinel (see paths.ts's
// buildReviewDataStalePath and this file's top-of-file exit-code comment).
// Called whenever a run ends WITHOUT completing pass 2 for every group, so
// whatever review-data.json a PREVIOUS successful run left behind can never
// be mistaken for current by ledger.ts's final gate. `reason` is a short,
// stable tag (not full prose) so a maintainer can grep for it.
function writeStaleSentinel(clientDir: string, reason: string, detail: string): void {
	const dir = pagesDir(clientDir);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		buildReviewDataStalePath(clientDir),
		yamlStringify({
			schema: STALE_SENTINEL_SCHEMA,
			written_at: new Date().toISOString(),
			reason,
			detail,
		}),
	);
}

// Clears the sentinel — only ever called after EVERY MANIFEST group has gone
// through pass 2 this run (end of runBuildReviewData, success path), i.e.
// `skipped.length === 0`. BUG-3 FIX (client _345): this used to clear
// unconditionally as long as pass 2 didn't throw, even when some groups were
// `skipped` for missing populate/categorize input. That is NOT the same as
// "the on-disk review-data set is trustworthy" — a group can carry a
// review-data.json from an EARLIER successful build and become `skipped`
// later (e.g. its categorize.json is removed by a re-dispatched stage), and
// ledger.ts's claim loader walks the client directory for any file named
// review-data.json regardless of manifest state (ledger.ts's claims are
// manifest-independent) — so that stale file's claims would still be counted
// with no sentinel left to block them. Only clearing when nothing was
// skipped re-establishes what the sentinel actually asserts: every group's
// review-data.json on disk came from THIS run's inputs.
function clearStaleSentinel(clientDir: string): void {
	const path = buildReviewDataStalePath(clientDir);
	if (existsSync(path)) rmSync(path);
}

// Core logic, no process.exit for the normal paths — safe to call from tests
// (same shape as category-account-check.ts's runCategoryAccountCheck /
// stage-shape-check.ts's runStageShapeCheck). Still exits the process on a
// malformed manifest/interpretation/categorize file, matching this script's
// existing all-or-nothing contract for genuinely broken input — a corrupt
// review-data.json (the human-writable file) is instead handled by the merge
// as a "bailed" outcome, never a process exit, because it is retried on every
// re-run and must not deadlock the whole client-month behind it. A preflight
// failure instead THROWS PreflightFailedError (see above) rather than
// exiting, for the same test-safety reason.
export function runBuildReviewData(clientDir: string): BuildResult {
	const manifest = loadGroupManifest(clientDir);
	const defaultBuyer = defaultBuyerOf(loadClientProfile(clientDir));
	const groupsRoot = docGroupsDir(clientDir);
	// Loaded up-front (not just for the Stage-2 page census below) so
	// withEvidenceClaims can resolve an evidence_unit's full page span from its
	// own Stage-2 record before pass 1 builds `fresh` — see groups-lib.ts's
	// pagesOfEvidenceUnit.
	const allInterpsBySegment: Map<string, InterpFile[]> = loadInterpretations(clientDir);

	let built = 0;
	let carried = 0;
	const skipped: string[] = [];
	const lostEdits: GroupEditLoss[] = [];
	// Groups whose manifest.yaml entry has NO `evidence_units` field at all —
	// distinct from a group that legitimately has zero (no links.yaml cluster).
	// `group-skeleton` has always written this field, but manifest.yaml is
	// hand-loaded YAML with no schema enforcement (loadGroupManifest only
	// checks `groups[]` exists), so a manifest built by an older,
	// pre-evidence_units group-skeleton loads with the field simply absent.
	// Both spots below fold that into `?? []` — correct for keeping the build
	// running, but with no warning that fold silently narrows the reciprocal
	// evidence-claim check (preflightBuiltGroups) to "this group claims
	// nothing", which is not the same fact as "this group's evidence was
	// checked and found empty". Recorded here so it reaches the same stdout
	// surface (state.lastGateStdout via the console) every other degrade in
	// this file already uses, instead of only ever showing up as an unusually
	// quiet preflight run.
	const preMigrationEvidenceGroups: string[] = [];

	// Pass 1: build every group's fresh review-data in memory (no writes yet)
	// so preflightBuiltGroups can validate ACROSS groups — an artifact-path
	// claim or a page double-claimed as primary by two groups — before this
	// pass commits anything to disk.
	type Prepared = {
		group: GroupPlan;
		groupDir: string;
		interpText: string;
		categorizeText: string;
		hash: string;
		interp: GroupInterpretation;
		categorize: CategorizeFile;
		fresh: Record<string, unknown>;
	};
	const prepared: Prepared[] = [];
	for (const group of manifest.groups ?? []) {
		const groupDir = join(groupsRoot, group.path);
		const interpPath = join(groupDir, "interpretation.json");
		const categorizePath = join(groupDir, "categorize.json");
		const missing = [interpPath, categorizePath].filter((p) => !existsSync(p));
		if (missing.length) {
			skipped.push(
				`${group.id}: missing ${missing.map((p) => relative(groupDir, p)).join(" + ")}`,
			);
			continue;
		}

		const interpText = readFileSync(interpPath, "utf8");
		const categorizeText = readFileSync(categorizePath, "utf8");
		const hash = contentHash(interpText, categorizeText);

		const interpRaw = readJson<GroupInterpretation>(interpPath, `group interpretation ${group.id}`);
		// A group's PRIMARY document pages are always in `interp.documents`
		// (populate always writes them) — its EVIDENCE pages, until now, were
		// only there if the populate step (group-populate's script copy, or
		// ksk-marple populating an agent group) happened to list them. This
		// folds in every page/sheet the group's OWN links.yaml transaction
		// cluster names as evidence (GroupPlan.evidence_units) regardless of
		// what populate actually copied — the fix for the client-345 run that
		// lost 4 pages of legitimate evidence purely on which populate call
		// happened to remember them. Bank-statement groups have no evidence_units
		// concept (a statement's own claim is one continuous source block, not a
		// documents[] list) and are excluded from the reciprocal preflight check
		// below for the same reason, so this is skipped for them too.
		if (group.category !== "bank_statement" && group.evidence_units === undefined) {
			preMigrationEvidenceGroups.push(group.id);
		}
		const interp: GroupInterpretation =
			group.category === "bank_statement"
				? interpRaw
				: withEvidenceClaims(interpRaw, group.evidence_units ?? [], allInterpsBySegment);
		const categorize = readJson<CategorizeFile>(categorizePath, `categorize ${group.id}`);
		let fresh: Record<string, unknown>;
		try {
			fresh =
				group.category === "bank_statement"
					? buildStatementReviewData(interp, categorize)
					: buildDocumentReviewData(
							interp,
							categorize,
							defaultBuyer,
							relative(clientDir, groupDir),
						);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(message);
			// Nothing is written this run (same "all bets off" contract as a
			// preflight failure below) — a previous successful build's
			// review-data.json must not be mistaken for current either.
			writeStaleSentinel(clientDir, "malformed-group-input", message);
			process.exit(2);
		}
		prepared.push({ group, groupDir, interpText, categorizeText, hash, interp, categorize, fresh });
	}

	// Restrict the Stage-2 page census to segments this run actually prepared a
	// group for. Without this, a segment whose groups haven't been built yet
	// this run (still `skipped` above for missing populate/categorize input)
	// would have its Stage-2 pages compared against zero owners and flagged as
	// dropped documents — a false positive, not a real cross-group
	// inconsistency; that segment simply hasn't reached this stage yet.
	const preparedSegments = new Set<string>();
	for (const p of prepared) for (const seg of p.group.segments) preparedSegments.add(seg);
	const preparedInterpsBySegment = new Map(
		[...allInterpsBySegment].filter(([segmentId]) => preparedSegments.has(segmentId)),
	);

	const preflightIssues = preflightBuiltGroups(
		prepared.map((p) => ({
			groupId: p.group.id,
			groupPath: p.group.path,
			category: p.group.category,
			interp: p.interp,
			fresh: p.fresh,
			evidenceUnits: p.group.evidence_units ?? [],
		})),
		loadInventoryFileSet(clientDir),
		stage2DocumentCountByPage(preparedInterpsBySegment),
		// From EVERY manifest group (not just `prepared`, which is restricted
		// to groups this run actually built) — an evidence claim is ground
		// truth from links.yaml via planGroups regardless of whether the
		// CLAIMING group happened to be built this run, and restricting it to
		// `prepared` would reintroduce the exact false-positive class
		// `preparedSegments` above exists to prevent (a not-yet-built group's
		// evidence claim wrongly absent, making an otherwise-accounted-for page
		// look dropped). Same shared helper findDroppedBookableUnits reads —
		// see groups-lib.ts's evidenceClaimedPageCounts.
		evidenceClaimedPageCounts(manifest.groups ?? [], allInterpsBySegment),
	);
	if (preflightIssues.length) {
		const error = new PreflightFailedError(preflightIssues);
		writeStaleSentinel(clientDir, "preflight-failed", error.message);
		throw error;
	}

	// Pass 2: the actual write loop, reusing what pass 1 already computed.
	for (const { group, groupDir, hash, fresh } of prepared) {
		const reviewPath = join(groupDir, REVIEW_DATA_FILE);
		const aiPath = join(groupDir, REVIEW_DATA_AI_FILE);
		const supersededPath = join(groupDir, REVIEW_DATA_SUPERSEDED_FILE);
		const droppedPath = join(groupDir, DROPPED_EDITS_FILE);

		// Baseline selection (review-data-merge.ts's contract):
		//   1. review-data.ai.json exists and parses → exact baseline.
		//   2. else (sidecar absent OR unreadable), review-data.json's stamp
		//      matches the freshly computed hash → the previous build came from
		//      exactly these inputs, so `fresh` IS the previous AI original. This
		//      is the transition path that keeps every already-edited group on
		//      disk exact on the very first run after this shipped — no sidecar
		//      has to exist yet. Rule 2's validity depends only on the STAMP, not
		//      on whether the sidecar happened to be readable, so a truncated/
		//      half-written sidecar (interrupted run, a sync mid-write) must not
		//      be treated any worse than a missing one — it still falls through
		//      to this check before giving up on an exact baseline.
		//   3. else → no baseline can be derived; merge runs degraded. Preserve
		//      the "unreadable" detail (rather than downgrading to "absent") so
		//      the core still records why no baseline was usable.
		let baseline: BaselineState;
		const aiState = loadState(aiPath);
		if (aiState.kind === "present") {
			baseline = aiState;
		} else {
			const reviewState = loadState(reviewPath);
			if (
				reviewState.kind === "present" &&
				typeof reviewState.data.source_content_hash === "string" &&
				reviewState.data.source_content_hash === hash
			) {
				baseline = { kind: "present", data: fresh };
			} else if (aiState.kind === "unreadable") {
				baseline = aiState;
			} else {
				baseline = { kind: "absent" };
			}
		}

		// Never collapse an unreadable current file to "absent" — that would
		// silently discard a human's document instead of recording it as
		// unmergeable (the merge core turns this into outcome "bailed").
		const existingDropped = loadState(droppedPath);
		const existingDroppedRaw = existingDropped.kind === "present" ? existingDropped.data : null;

		function mergeAgainst(current: CurrentState, priorBytes: string | null) {
			const { data, report } = mergeReviewData({ groupId: group.id, fresh, baseline, current });
			if ((report.outcome === "degraded" || report.outcome === "bailed") && priorBytes != null) {
				writeTextAtomic(supersededPath, priorBytes);
			}
			// Sticky-warning re-injection (see stickyFlagsFor above): only when
			// THIS run's own merge introduced no flags — a run that already
			// flagged something must not be double-flagged from history.
			let writeData: Record<string, unknown> = data;
			if (report.flags.length === 0) {
				const sticky = stickyFlagsFor(existingDroppedRaw, hash);
				if (sticky.length > 0) {
					const existingFlags = Array.isArray(data.review_flags) ? (data.review_flags as unknown[]) : [];
					writeData = { ...data, review_flags: [...existingFlags, ...sticky] };
					if (Array.isArray(writeData.pages)) {
						writeData.pages = (writeData.pages as unknown[]).map((p) =>
							isRecord(p) ? { ...p, initial_status: "needs_attention" } : p,
						);
					}
				}
			}
			return { report, writeData };
		}

		let priorReviewBytes = existsSync(reviewPath) ? readFileSync(reviewPath, "utf8") : null;
		let current: CurrentState = loadState(reviewPath);
		let { report, writeData } = mergeAgainst(current, priorReviewBytes);

		// Race guard (adversarial review finding #7): the console review app can
		// write review-data.json (a save in flight while a reviewer works the
		// page) at any moment between our read above and the write below — its
		// own temp-file+rename can't detect ours or vice versa. Re-read once,
		// right before committing; if the bytes moved since we read `current`,
		// redo the merge against the NEWER bytes exactly once so an in-flight
		// save is folded in rather than silently clobbered, and surface it in
		// the group's lostEdits entry either way so it's never a silent event.
		const raceBytes = existsSync(reviewPath) ? readFileSync(reviewPath, "utf8") : null;
		const raceDetected = raceBytes !== priorReviewBytes;
		if (raceDetected) {
			current = loadState(reviewPath);
			priorReviewBytes = raceBytes;
			({ report, writeData } = mergeAgainst(current, priorReviewBytes));
		}

		writeJsonAtomic(reviewPath, { ...writeData, source_content_hash: hash });
		writeJsonAtomic(aiPath, { ...fresh, source_content_hash: hash });

		// Transition-path audit trail (finding #5): rule 2 assumes the previous
		// build's OUTPUT for these exact inputs was identical to `fresh` — true
		// unless the builder itself changed between that build and this one. If
		// that assumption is wrong, a builder-derived value change looks exactly
		// like a human edit (c !== b, f === b) and gets carried and then pinned
		// by the new sidecar. We cannot detect that case here, but we can make it
		// auditable: whenever the transition path (no sidecar) is the reason a
		// baseline was usable and it carried something, record a note so a
		// maintainer can review the first post-ship rebuild per group.
		const usedTransitionBaseline = aiState.kind !== "present" && baseline.kind === "present";
		const transitionNotes =
			usedTransitionBaseline && report.carried > 0
				? [
						`transition baseline (no review-data.ai.json sidecar): ${report.carried} field(s) carried forward as human edits — verify the builder itself did not change since this file was last written`,
					]
				: [];

		const raceNotes = raceDetected
			? [
					"race guard: review-data.json changed between read and write during this rebuild (likely a concurrent console save) — merge was redone against the newer bytes before committing",
				]
			: [];

		if (
			report.dropped.length > 0 ||
			report.outcome === "degraded" ||
			report.outcome === "bailed" ||
			transitionNotes.length > 0 ||
			raceNotes.length > 0
		) {
			const entry: DroppedEditsRebuild = {
				rebuilt_at: new Date().toISOString(),
				outcome: report.outcome,
				source_content_hash: hash,
				carried: report.carried,
				notes: [...report.notes, ...transitionNotes, ...raceNotes],
				dropped: report.dropped,
			};
			const updated = appendDroppedEdits(existingDroppedRaw, group.id, entry);
			writeJsonAtomic(droppedPath, updated);
		}

		built++;
		carried += report.carried;
		// A degraded/bailed outcome is worth surfacing even when nothing was
		// actually dropped this run (e.g. a bail with a byte-identical rebuild) —
		// the group's baseline situation itself is the thing a human should see.
		// A detected race is surfaced unconditionally too, even on an otherwise
		// clean merge, so a concurrent save is never a silent event.
		if (
			report.dropped.length > 0 ||
			report.lostSkips > 0 ||
			report.outcome === "degraded" ||
			report.outcome === "bailed" ||
			raceDetected
		) {
			lostEdits.push({
				groupId: group.id,
				path: group.path,
				outcome: report.outcome,
				dropped: report.dropped.length,
				lostSkips: report.lostSkips,
				...(raceDetected ? { raceDetected: true } : {}),
			});
		}
	}

	// Only clear the sentinel when EVERY manifest group actually went through
	// pass 2 this run (see clearStaleSentinel above) — a run that leaves any
	// group `skipped` has not re-established that the full on-disk
	// review-data set is trustworthy.
	if (skipped.length === 0) clearStaleSentinel(clientDir);
	return { built, carried, skipped, lostEdits, preMigrationEvidenceGroups };
}

function main() {
	const argv = Bun.argv.slice(2);
	if (argv.length !== 1 || argv[0].startsWith("--")) usage();
	const clientDir = resolveClientDir(argv[0]);

	let result: BuildResult;
	try {
		result = runBuildReviewData(clientDir);
	} catch (error) {
		if (error instanceof PreflightFailedError) {
			console.error(`build-review-data: ${error.message}`);
			console.error(
				`this is NOT a usage error — the pipeline's own output is inconsistent. Nothing was written this run, and the previous build (if any) has been marked stale (${buildReviewDataStalePath(clientDir)}) so it cannot be read as current. Fix the inconsistency named above, then re-run this command; do not re-dispatch review-groups or the ledger while the sentinel exists.`,
			);
			process.exit(3);
		}
		throw error;
	}
	const { built, carried, skipped, lostEdits, preMigrationEvidenceGroups } = result;

	console.log(`built ${built} review-data.json file(s)`);
	if (carried > 0) console.log(`carried forward ${carried} human edit(s)`);
	if (preMigrationEvidenceGroups.length > 0) {
		console.log(
			`⚠ ${preMigrationEvidenceGroups.length} group(s) have no evidence_units field in manifest.yaml (built by an older group-skeleton) — the reciprocal evidence-claim check ran as if they claim no evidence, not because they actually don't:`,
		);
		for (const id of preMigrationEvidenceGroups) console.log(`  - ${id}`);
		console.log("re-run group-skeleton for this client-month to add the missing field, then re-run this command");
	}
	if (lostEdits.length > 0) {
		console.log(`⚠ ${lostEdits.length} group(s) had review edits dropped or degraded on rebuild:`);
		for (const loss of lostEdits) {
			const supersededNote =
				loss.outcome === "degraded" || loss.outcome === "bailed"
					? `; see also ${loss.path}/${REVIEW_DATA_SUPERSEDED_FILE}`
					: "";
			const raceNote = loss.raceDetected
				? " [concurrent console save detected during rebuild — merge redone against the newer bytes]"
				: "";
			console.log(
				`  - ${loss.path}: ${loss.dropped} edit(s) dropped, ${loss.lostSkips} "skipped" flag(s) lost [${loss.outcome}] — see ${loss.path}/${DROPPED_EDITS_FILE}${supersededNote}${raceNote}`,
			);
		}
	}
	if (skipped.length) {
		console.log(`skipped ${skipped.length} group(s) with missing inputs:`);
		for (const line of skipped) console.log(`  - ${line}`);
		console.log("re-run the populate/categorize stage for those groups, then re-run this command");
		process.exit(1);
	}
	console.log(
		`next: bun run --cwd .claude/skills/ksk-keying/scripts review-groups -- --force "<client-dir>"`,
	);
}

if (import.meta.main) main();
