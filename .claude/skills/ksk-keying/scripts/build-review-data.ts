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
// input.

import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { docGroupsDir } from "./paths";
import {
	buildDocumentReviewData,
	buildStatementReviewData,
	type CategorizeFile,
	type DefaultBuyer,
	type GroupInterpretation,
} from "./groups-lib";
import {
	loadClientProfile,
	loadGroupManifest,
	readJson,
	resolveClientDir,
} from "./groups-io";
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
};

// Core logic, no process.exit for the normal paths — safe to call from tests
// (same shape as category-account-check.ts's runCategoryAccountCheck /
// stage-shape-check.ts's runStageShapeCheck). Still exits the process on a
// malformed manifest/interpretation/categorize file, matching this script's
// existing all-or-nothing contract for genuinely broken input — a corrupt
// review-data.json (the human-writable file) is instead handled by the merge
// as a "bailed" outcome, never a process exit, because it is retried on every
// re-run and must not deadlock the whole client-month behind it.
export function runBuildReviewData(clientDir: string): BuildResult {
	const manifest = loadGroupManifest(clientDir);
	const defaultBuyer = defaultBuyerOf(loadClientProfile(clientDir));
	const groupsRoot = docGroupsDir(clientDir);

	let built = 0;
	let carried = 0;
	const skipped: string[] = [];
	const lostEdits: GroupEditLoss[] = [];
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

		const interp = readJson<GroupInterpretation>(interpPath, `group interpretation ${group.id}`);
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
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(2);
		}

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

	return { built, carried, skipped, lostEdits };
}

function main() {
	const argv = Bun.argv.slice(2);
	if (argv.length !== 1 || argv[0].startsWith("--")) usage();
	const clientDir = resolveClientDir(argv[0]);

	const { built, carried, skipped, lostEdits } = runBuildReviewData(clientDir);

	console.log(`built ${built} review-data.json file(s)`);
	if (carried > 0) console.log(`carried forward ${carried} human edit(s)`);
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
