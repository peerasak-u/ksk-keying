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
// Skip-if-unchanged (wayfinder #35/#41): a group whose review-data.json is
// already stamped with a hash of its current interpretation.json +
// categorize.json content is left on disk untouched — this is what protects
// a human's saved review edits (the console review app writes value/account
// corrections straight into review-data.json) from a Stage-3 "repair"
// re-run that rebuilds every group in a client-month, not just the one that
// changed.
//
// Exit codes: 0 groups built and/or left unchanged (no missing inputs), 1
// some groups skipped (missing inputs — re-dispatch those stages), 2
// usage/malformed input.

import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

function usage(): never {
	console.error(`Usage: bun run build-review-data -- <client-dir>

Merges each group's interpretation.json + categorize.json (+ CLIENT.md
default_buyer) into review-data.json. Run group-populate / ksk-marple populate
and the poirot categorize wave first; run review-groups after.

A group whose interpretation/categorize content hasn't changed since the last
build is left untouched (saved review edits are protected) — see
source_content_hash in the written file.

Exit codes: 0 built/unchanged, 1 groups skipped for missing inputs, 2 usage/malformed input.
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
// would make two different (interp, categorize) pairs collide.
function contentHash(...parts: string[]): string {
	return createHash("sha256").update(parts.join(" ")).digest("hex");
}

// Whether a group's review-data.json needs (re)building, given the freshly
// computed source hash and whatever `source_content_hash` (if any) the file
// on disk was last stamped with. Pure — no I/O — so it's directly
// unit-testable: no stamp at all (file doesn't exist yet, parsed but
// pre-dates this fix, or failed to parse) always rebuilds once; a stamp that
// matches is the only case that skips.
export function needsRebuild(hash: string, existingStamp: string | null | undefined): boolean {
	return typeof existingStamp !== "string" || existingStamp !== hash;
}

export type BuildResult = {
	built: number;
	unchanged: number;
	skipped: string[];
};

// Core logic, no process.exit for the normal paths — safe to call from tests
// (same shape as category-account-check.ts's runCategoryAccountCheck /
// stage-shape-check.ts's runStageShapeCheck). Still exits the process on a
// malformed manifest/interpretation/categorize file, matching this script's
// existing all-or-nothing contract for genuinely broken input — only the new
// skip-if-unchanged decision was made testable in isolation.
export function runBuildReviewData(clientDir: string): BuildResult {
	const manifest = loadGroupManifest(clientDir);
	const defaultBuyer = defaultBuyerOf(loadClientProfile(clientDir));
	const groupsRoot = docGroupsDir(clientDir);

	let built = 0;
	let unchanged = 0;
	const skipped: string[] = [];
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

		const reviewPath = join(groupDir, "review-data.json");
		if (existsSync(reviewPath)) {
			let existingStamp: string | null | undefined;
			try {
				const existing = JSON.parse(readFileSync(reviewPath, "utf8")) as Record<string, unknown>;
				existingStamp = typeof existing.source_content_hash === "string" ? existing.source_content_hash : null;
			} catch {
				existingStamp = null; // corrupt file on disk — treat as changed, rebuild
			}
			if (!needsRebuild(hash, existingStamp)) {
				unchanged++;
				continue;
			}
		}

		const interp = readJson<GroupInterpretation>(interpPath, `group interpretation ${group.id}`);
		const categorize = readJson<CategorizeFile>(categorizePath, `categorize ${group.id}`);
		let reviewData: Record<string, unknown>;
		try {
			reviewData =
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
		reviewData.source_content_hash = hash;
		writeFileSync(reviewPath, `${JSON.stringify(reviewData, null, 2)}\n`);
		built++;
	}

	return { built, unchanged, skipped };
}

function main() {
	const argv = Bun.argv.slice(2);
	if (argv.length !== 1 || argv[0].startsWith("--")) usage();
	const clientDir = resolveClientDir(argv[0]);

	const { built, unchanged, skipped } = runBuildReviewData(clientDir);

	console.log(`built ${built} review-data.json file(s)`);
	if (unchanged > 0)
		console.log(
			`left ${unchanged} group(s) unchanged (interpretation/categorize unchanged since last build — saved review edits protected)`,
		);
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
