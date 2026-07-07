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
// Exit codes: 0 all groups built, 1 some groups skipped (missing inputs —
// re-dispatch those stages), 2 usage/malformed input.

import { join, relative } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
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

Exit codes: 0 built, 1 groups skipped for missing inputs, 2 usage/malformed input.
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

function main() {
	const argv = Bun.argv.slice(2);
	if (argv.length !== 1 || argv[0].startsWith("--")) usage();
	const clientDir = resolveClientDir(argv[0]);

	const manifest = loadGroupManifest(clientDir);
	const defaultBuyer = defaultBuyerOf(loadClientProfile(clientDir));
	const groupsRoot = docGroupsDir(clientDir);

	let built = 0;
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
		writeFileSync(join(groupDir, "review-data.json"), `${JSON.stringify(reviewData, null, 2)}\n`);
		built++;
	}

	console.log(`built ${built} review-data.json file(s)`);
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
