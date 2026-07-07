// Stage 4b — populate every `populate: script` group by copying facts + all
// line items from its primary Stage-2 interpretation into the group folder
// ("agents judge, scripts copy"; formerly one ksk-marple call per group).
//
// For each manifest group with populate: script, writes
//   ข้อมูลระบบ/_doc_groups/<group.path>/interpretation.json  (ksk_group_interpretation.v1)
// Groups marked populate: agent are listed and left for ksk-marple — they
// need judgment (line selection from a shared sheet, unresolved primary).
//
// Exit codes: 0 all script groups populated, 2 usage/malformed input.

import { join, relative } from "node:path";
import { writeFileSync } from "node:fs";
import { docGroupsDir } from "./paths";
import {
	buildDocumentGroupInterpretation,
	buildStatementGroupInterpretation,
	type Interpretation,
} from "./groups-lib";
import {
	loadGroupManifest,
	loadLinks,
	loadSegmentSources,
	readJson,
	resolveClientDir,
} from "./groups-io";

function usage(): never {
	console.error(`Usage: bun run group-populate -- <client-dir>

Copies facts + line items from each group's primary interpretation file into
<group>/interpretation.json, for every manifest group with populate: script.
Run group-skeleton first. Groups with populate: agent are left for ksk-marple.

Exit codes: 0 populated, 2 usage/malformed input.
`);
	process.exit(2);
}

function main() {
	const argv = Bun.argv.slice(2);
	if (argv.length !== 1 || argv[0].startsWith("--")) usage();
	const clientDir = resolveClientDir(argv[0]);

	const manifest = loadGroupManifest(clientDir);
	const links = loadLinks(clientDir);
	const sources = loadSegmentSources(clientDir);
	const groupsRoot = docGroupsDir(clientDir);

	let populated = 0;
	const agentGroups: string[] = [];
	for (const group of manifest.groups ?? []) {
		if (group.populate !== "script") {
			agentGroups.push(group.id);
			continue;
		}
		if (!group.primary_interpretation) {
			console.error(`group ${group.id} is populate: script but has no primary_interpretation`);
			process.exit(2);
		}
		const primary = readJson<Interpretation>(
			join(clientDir, group.primary_interpretation),
			`interpretation for ${group.id}`,
		);
		let result;
		if (group.category === "bank_statement") {
			// source block from the segment manifest — the deterministic record of
			// which file/pages this statement physically lives in
			const src = (sources.get(group.segments[0]) ?? [])[0] ?? null;
			if ((sources.get(group.segments[0]) ?? []).length > 1)
				console.log(
					`warning: ${group.id}: segment ${group.segments[0]} has several sources — source block uses the first`,
				);
			result = buildStatementGroupInterpretation(group, primary, src);
		} else {
			const evidence = group.evidence_interpretations.map((path) =>
				readJson<Interpretation>(join(clientDir, path), `evidence interpretation for ${group.id}`),
			);
			const clusterEvidence = group.transaction_id
				? (links?.evidenceById.get(group.transaction_id) ?? null)
				: null;
			result = buildDocumentGroupInterpretation(group, primary, evidence, clusterEvidence);
		}
		const outPath = join(groupsRoot, group.path, "interpretation.json");
		writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
		populated++;
	}

	console.log(
		`populated ${populated} group(s) under ${relative(clientDir, groupsRoot)}` +
			(agentGroups.length
				? `; ${agentGroups.length} left for ksk-marple populate: ${agentGroups.join(", ")}`
				: "; no agent-populated groups"),
	);
}

if (import.meta.main) main();
