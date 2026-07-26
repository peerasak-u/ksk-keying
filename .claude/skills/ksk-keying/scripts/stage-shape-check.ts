// Completion probe for the three ksk-keying stages that have no pass/fail
// gate of their own (profile, link, group — unlike segment/interpret/final,
// which ledger.ts already gates on real Page-Ledger evidence). This is
// deliberately weaker than a Ledger Gate: it only proves a stage's *contract
// artifacts exist and have the expected shape*, so an external sequencer can
// tell "this stage's process crashed/no-op'd" from "this stage genuinely
// finished" without trusting the agent's own transcript. It is not a
// correctness check (that's what the later opus validators are for) and it
// writes no snapshot file — stdout + exit code only, since nothing downstream
// reads its output the way ledger.yaml is read.
//
// Malformed inputs exit 2 immediately via the shared readJson/readYaml
// helpers (groups-io.ts) — consistent with every other script in this
// directory. Missing-but-expected artifacts are collected as offenses and
// exit 1 (the stage is still in progress, not broken).
//
// Exit codes: 0 shape complete, 1 shape incomplete, 2 usage/malformed input.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { docGroupsDir, pagesDir, resolveContextFile } from "./paths";
import { loadInterpretations, loadLinks, resolveClientDir } from "./groups-io";
import type { GroupPlan } from "./groups-lib";

export const STAGES = ["profile", "link", "group"] as const;
export type Stage = (typeof STAGES)[number];

type Args = {
	clientDir: string;
	stage: Stage;
};

function usage(): never {
	console.error(`Usage: bun run stage-shape-check -- --stage profile|link|group <client-dir>

Completion probe for stages with no Ledger Gate of their own. Checks that a
stage's contract artifacts exist and have the expected shape — not a
correctness check.

Exit codes: 0 shape complete, 1 shape incomplete, 2 usage/malformed input.
`);
	process.exit(2);
}

function parseArgs(argv: string[]): Args {
	let clientDir = "";
	let stage: Stage | "" = "";
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--stage") {
			const value = argv[++i];
			if (!STAGES.includes(value as Stage)) usage();
			stage = value as Stage;
		} else if (arg === "--help" || arg === "-h" || arg.startsWith("--")) usage();
		else if (!clientDir) clientDir = arg;
		else usage();
	}
	if (!clientDir || !stage) usage();
	return { clientDir, stage };
}

function checkProfile(clientDir: string): string[] {
	const offenses: string[] = [];

	const clientMdPath = resolveContextFile(clientDir, "CLIENT.md");
	if (!clientMdPath) {
		offenses.push("CLIENT.md not found at run root or client root");
	} else {
		const text = readFileSync(clientMdPath, "utf8");
		const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!match) {
			offenses.push(`CLIENT.md (${clientMdPath}) has no YAML frontmatter`);
		} else {
			try {
				yamlParse(match[1]);
			} catch (error) {
				offenses.push(
					`CLIENT.md (${clientMdPath}) frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	const coaPath = resolveContextFile(clientDir, "coa.csv");
	if (!coaPath) offenses.push("coa.csv not found at run root or client root");
	else if (statSync(coaPath).size === 0) offenses.push(`coa.csv (${coaPath}) is empty`);

	const inventoryPath = join(pagesDir(clientDir), "inventory.yaml");
	if (!existsSync(inventoryPath)) {
		offenses.push(`${inventoryPath} not found — run the inventory script`);
	} else {
		const doc = yamlParse(readFileSync(inventoryPath, "utf8")) as { schema?: string; files?: unknown[] } | null;
		if (doc?.schema !== "ksk_inventory.v1") offenses.push(`${inventoryPath} missing/unexpected schema field`);
		if (!Array.isArray(doc?.files) || doc.files.length === 0)
			offenses.push(`${inventoryPath} has no files[] entries`);
	}

	return offenses;
}

function checkLink(clientDir: string): string[] {
	const offenses: string[] = [];

	const draftPath = join(docGroupsDir(clientDir), "links.draft.yaml");
	if (!existsSync(draftPath)) offenses.push(`${draftPath} not found — run prelink first`);

	const links = loadLinks(clientDir);
	if (!links) {
		offenses.push(`${join(docGroupsDir(clientDir), "links.yaml")} not found — sherlock has not written it yet`);
		return offenses;
	}

	const covered = new Set<string>();
	for (const cluster of links.clusters) for (const segmentId of cluster.segments ?? []) covered.add(segmentId);

	const interpreted = loadInterpretations(clientDir);
	const uncovered = [...interpreted.keys()].filter((segmentId) => !covered.has(segmentId)).sort();
	if (uncovered.length)
		offenses.push(`segment(s) with an interpretation but in no links.yaml cluster: ${uncovered.join(", ")}`);

	return offenses;
}

function checkGroup(clientDir: string): string[] {
	const offenses: string[] = [];

	const manifestPath = join(docGroupsDir(clientDir), "manifest.yaml");
	if (!existsSync(manifestPath)) {
		offenses.push(`${manifestPath} not found — run group-skeleton first`);
		return offenses;
	}
	const doc = yamlParse(readFileSync(manifestPath, "utf8")) as { schema?: string; groups?: GroupPlan[] } | null;
	if (!Array.isArray(doc?.groups)) {
		offenses.push(`${manifestPath} missing groups[] list`);
		return offenses;
	}

	const groupsRoot = docGroupsDir(clientDir);
	const missing: string[] = [];
	for (const group of doc.groups) {
		const interpPath = join(groupsRoot, group.path, "interpretation.json");
		if (!existsSync(interpPath)) missing.push(`${group.id} (${group.path})`);
	}
	if (missing.length) offenses.push(`group(s) with no interpretation.json yet: ${missing.join(", ")}`);

	return offenses;
}

// Core check, importable directly by tests without spawning a subprocess —
// same shape as group-skeleton.ts's exported runGroupSkeleton.
export function runStageShapeCheck(clientDir: string, stage: Stage): string[] {
	if (stage === "profile") return checkProfile(clientDir);
	if (stage === "link") return checkLink(clientDir);
	return checkGroup(clientDir);
}

function main() {
	const args = parseArgs(Bun.argv.slice(2));
	const clientDir = resolveClientDir(args.clientDir);
	const offenses = runStageShapeCheck(clientDir, args.stage);

	console.log(`Stage shape check — ${args.stage} — ${clientDir}`);
	if (offenses.length === 0) {
		console.log("RESULT: PASS — all contract artifacts present");
		return;
	}
	console.log(`RESULT: INCOMPLETE (${offenses.length}):`);
	for (const offense of offenses) console.log(`  - ${offense}`);
	process.exit(1);
}

if (import.meta.main) main();
