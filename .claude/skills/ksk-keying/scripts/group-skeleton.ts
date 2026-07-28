// Stage 4a — doc-group skeleton, deterministically ("agents judge, scripts
// copy"; formerly a ksk-lestrade agent call).
//
// Reads ข้อมูลระบบ/_doc_groups/links.yaml (optional — linking may be skipped)
// plus every Stage-2 interpretation under ข้อมูลระบบ/_segments/, and writes:
//   ข้อมูลระบบ/_doc_groups/manifest.yaml   (ksk_doc_groups.v1, layout category_vat_tree.v1)
//   ข้อมูลระบบ/_doc_groups/<category>/<vat>/<group-id>/   (empty folders)
//
// Idempotent under links.yaml edits: group ids are derived from each group's
// own content (segment id + document number, never a global creation-order
// index — see planGroups in groups-lib.ts), so inserting or removing an
// unrelated transaction never renumbers anyone else's folder. Any directory
// left over from a previous run whose transaction/document no longer appears
// in the fresh plan is deleted before the new tree is written — a re-run
// never leaves an orphaned, already-populated group folder behind.
//
// One group per bookable_docs entry, never per transaction — a cluster with
// two bookable invoices yields two groups sharing the receipt as evidence.
// Each group carries populate: script|agent — script when the group is a pure
// 1:1 copy of one interpretation file (group-populate handles it), agent when
// line selection or disambiguation is required (ksk-marple populate).
//
// Exit codes: 0 clean pass, 1 written but DEGRADED (links.yaml predates unit
// identity — see the "warning: links.yaml predates unit identity" line;
// re-run Stage 3 linking, then re-run this script), 2 usage/malformed input.
// 1 is deliberately its own bucket, not folded into 2: a pre-migration
// links.yaml written by an older version of this tool is not "usage/malformed
// input" the way a missing client dir or an unreadable manifest is — the
// arguments and files this run was given are fine, this run's OWN output
// (manifest.yaml + the group tree) is still written, and the fix is a normal
// re-run of an earlier stage, not a human going and editing something. Exit 1
// mirrors the Ledger Gate family's own "blocked, worth a retry" bucket
// (ledger.ts, completion-check.ts) rather than build-review-data.ts's exit 3
// (which additionally guarantees NOTHING was written this run) — this script
// writes a normal, usable manifest even in the degraded case, only with a
// weaker completeness guarantee on the segments named in the warning.

import { join, relative } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { stringify as yamlStringify } from "yaml";
import { docGroupsDir } from "./paths";
import { GROUP_LAYOUT, GROUP_MANIFEST_SCHEMA, orphanedGroupDirs, planGroups } from "./groups-lib";
import {
	listExistingGroupDirs,
	loadInterpretations,
	loadLinks,
	loadSegmentSources,
	resolveClientDir,
} from "./groups-io";

function usage(): never {
	console.error(`Usage: bun run group-skeleton -- <client-dir>

Builds the ข้อมูลระบบ/_doc_groups/ category/VAT tree + manifest.yaml from
links.yaml and the Stage-2 interpretations. Structural only — populate the
groups afterwards (group-populate for populate: script, ksk-marple for
populate: agent).

Exit codes: 0 clean pass, 1 written but degraded (links.yaml predates unit
identity — re-run Stage 3 linking, then re-run this script), 2 usage/malformed
input.
`);
	process.exit(2);
}

// Core logic, factored out of main() so tests can drive it directly against
// a temp client dir (e.g. to assert idempotency across links.yaml edits)
// without spawning a subprocess or touching process.argv/exit. Returns
// whether the run was degraded (see the exit-code comment above) — callers
// that only care about the artifacts on disk (most existing tests) can
// ignore the return value exactly as before.
export function runGroupSkeleton(clientDir: string): { degraded: boolean } {
	const interps = loadInterpretations(clientDir);
	if (interps.size === 0) {
		console.error(
			`no interpretation files under ${relative(clientDir, join(clientDir, "ข้อมูลระบบ/_segments"))} — run Stage 2 first`,
		);
		process.exit(2);
	}
	const links = loadLinks(clientDir);
	const sources = loadSegmentSources(clientDir);

	let plan: ReturnType<typeof planGroups>;
	try {
		plan = planGroups(links?.clusters ?? null, interps, sources);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(2);
	}

	const groupsRoot = docGroupsDir(clientDir);
	// Delete directories left over from a previous run whose transaction/document
	// no longer appears in the fresh plan (e.g. a duplicate stub removed from
	// links.yaml) — stable ids mean anything left over here is genuinely stale,
	// never a still-current group whose id merely shifted (see groups-lib.ts's
	// orphanedGroupDirs). Left uncleaned, stale folders accumulate an
	// already-populated interpretation.json/categorize.json that no longer
	// corresponds to anything in the manifest.
	const orphans = orphanedGroupDirs(listExistingGroupDirs(groupsRoot), plan.groups);
	for (const orphan of orphans) {
		rmSync(join(groupsRoot, orphan), { recursive: true, force: true });
		console.log(`removed stale group directory (no longer in links.yaml): ${orphan}`);
	}
	for (const group of plan.groups) mkdirSync(join(groupsRoot, group.path), { recursive: true });
	const manifestPath = join(groupsRoot, "manifest.yaml");
	writeFileSync(
		manifestPath,
		yamlStringify({
			schema: GROUP_MANIFEST_SCHEMA,
			layout: GROUP_LAYOUT,
			groups: plan.groups,
		}),
	);

	const scriptGroups = plan.groups.filter((g) => g.populate === "script");
	const agentGroups = plan.groups.filter((g) => g.populate === "agent");
	console.log(
		`wrote ${relative(clientDir, manifestPath)}: ${plan.groups.length} group(s) — ` +
			`${scriptGroups.length} populate: script, ${agentGroups.length} populate: agent` +
			(links ? "" : " (no links.yaml — one group per interpretation file)"),
	);
	// Printed BEFORE the per-group listing (which can run to hundreds of lines
	// on a real client-month) so a human/agent reading top-down sees this first,
	// not buried at the bottom of a piped-to-file log — see
	// references/orchestration.md's "cap output, read back only the count/exit
	// lines" convention, which would otherwise miss a warning this important.
	if (plan.degraded)
		console.log(
			`⚠ DEGRADED — this run's completeness check for unnumbered documents could not be fully verified (see "warning: links.yaml predates unit identity" below). The manifest below was still written; exit code will be 1, not 0.`,
		);
	for (const group of plan.groups) {
		const flags = group.warnings.length ? ` ⚠ ${group.warnings.join(" | ")}` : "";
		console.log(`  ${group.path} [${group.populate}]${flags}`);
	}
	for (const warning of plan.warnings) console.log(`warning: ${warning}`);
	if (agentGroups.length)
		console.log(
			`next: run group-populate, then dispatch ksk-marple populate for: ${agentGroups.map((g) => g.id).join(", ")}`,
		);
	else console.log("next: run group-populate (no agent-populated groups)");
	return { degraded: plan.degraded };
}

function main() {
	const argv = Bun.argv.slice(2);
	if (argv.length !== 1 || argv[0].startsWith("--")) usage();
	const clientDir = resolveClientDir(argv[0]);
	const { degraded } = runGroupSkeleton(clientDir);
	if (degraded) process.exit(1);
}

if (import.meta.main) main();
