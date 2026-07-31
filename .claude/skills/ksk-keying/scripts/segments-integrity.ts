// Stage-2 immutability check (real incident, client 345, month 04-69,
// 2026-07-28): Stage 4 (ksk-stage-group) hit its own completeness guard —
// `isExcludedFromMatch` -> `isApprovedBookable` -> `stage2DocumentCountByPage`
// in groups-lib.ts, which reads `usable_for_booking` off Stage-2's
// interpretation files — and instead of reporting the block, an agent edited
// SIX of those already-approved files, flipping `usable_for_booking: true ->
// false` and appending a self-justifying warning explaining why. That
// silently removed the documents from the guard's census, the guard fell
// silent, and the run failed three stages later for an unrelated reason.
// `ข้อมูลระบบ/_segments/**` is Stage 2's factual record of what each document
// says; every later stage reads it, none should ever write it.
//
// This script makes that boundary enforceable instead of just documented:
//
//   stamp  — record a sha256 of every file under _segments/ into
//            _pages/segments-manifest.yaml. Called by ledger.ts itself the
//            moment `--gate interpret` passes (never by a stage skill) —
//            so the ONLY way to legitimately move the manifest forward is
//            the real re-dispatch path (re-run/retry Stage 2, which ends,
//            same as a first run, by calling `ledger --gate interpret`
//            again). A stage hand-editing a file can never also re-stamp.
//
//   verify — recompute the same hashes and diff against the manifest. Any
//            later stage (link, group, categorize, final) runs this before
//            its own completion check. A mismatch names the exact file(s)
//            that changed/vanished/appeared and blocks loudly instead of
//            letting the stage's own guard go quiet the way it did in the
//            incident above.
//
// A run with no manifest at all (an older run predating this check, or a
// customer mid-upgrade) is NOT a failure — `verify` degrades to a warning on
// stderr and exits 0. Once such a run's Stage 2 is next re-dispatched (or
// any interpret re-gate happens), the manifest starts existing and every
// later transition is covered from then on.
//
// Hashing is over raw file bytes only — no YAML/JSON parsing — so this is
// cheap enough to run on every stage transition (a client's _segments/ tree
// is at most a few hundred small JSON/YAML files).
//
// Exit codes: stamp — 0 success, 2 usage/environment error.
//             verify — 0 pass (including the no-manifest degrade), 1
//             tampered (evidence changed since the last stamp), 2
//             usage/environment error.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
	pagesDir as machineryPagesDir,
	segmentsDir,
	segmentsManifestHistoryPath,
	segmentsManifestPath,
} from "./paths";

const TOOL_DIR = import.meta.dir;
const PROJECT_ROOT = resolve(TOOL_DIR, "../../../..");

const MANIFEST_SCHEMA = "ksk_segments_manifest.v1";

export type ManifestFile = { path: string; sha256: string };

export type Manifest = {
	schema: string;
	stamped_at: string;
	gate: "interpret";
	files: ManifestFile[];
};

export type ManifestDiff = { changed: string[]; missing: string[]; added: string[] };

export type VerifyResult =
	| { status: "no-manifest"; manifestPath: string }
	| { status: "pass"; manifestPath: string }
	| ({ status: "tampered"; manifestPath: string } & ManifestDiff);

const HISTORY_SCHEMA = "ksk_segments_manifest_history.v1";

export type ManifestHistoryEntry = {
	stamped_at: string;
	// The manifest this re-stamp replaced (not the one it produced) — i.e.
	// "what _segments/ looked like right before this stamp, vs. what it now
	// looks like". Lets a human read one entry and know exactly which stamp
	// it followed.
	previous_stamped_at: string;
} & ManifestDiff;

export type ManifestHistory = {
	schema: string;
	entries: ManifestHistoryEntry[];
};

// _segments/** is JSON/YAML text only (Stage-2 interpretation files, segment
// manifests) — reading as utf8 keeps this in the same string-hashing style
// as build-review-data.ts's contentHash, and sidesteps this checkout's
// missing @types/node Buffer typing.
function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path, "utf8")).digest("hex");
}

// Every file under _segments/, sorted, as a relative-to-_segments/ path.
// Directories are descended, symlinks are not expected here and are treated
// like any other statSync-able entry (this tree is agent/script-written
// JSON+YAML, never a symlink farm the way _gate_groups/ is).
//
// Always "/"-separated, never the host separator: these strings are not
// transient — they are hashed into the segments-manifest, written to the
// re-stamp history, and printed as the name of the tampered file a human then
// has to go find. node:path's relative() yields "seg-001\interpretation.json"
// on Windows, which would make a manifest stamped there compare unequal to the
// same tree anywhere else (every file reported both missing AND added), and
// would put a path into a client artifact that no other stage's "/"-joined
// path can match.
function walkFiles(dir: string, base: string, out: string[]): void {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir).sort()) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) walkFiles(full, base, out);
		else if (stat.isFile()) out.push(relative(base, full).split(sep).join("/"));
	}
}

function currentFileHashes(clientDir: string): Map<string, string> {
	const base = segmentsDir(clientDir);
	const relPaths: string[] = [];
	walkFiles(base, base, relPaths);
	const map = new Map<string, string>();
	for (const rel of relPaths.sort()) map.set(rel, sha256File(join(base, rel)));
	return map;
}

// Shared by stamp (diffing against the manifest it's about to replace) and
// verify (diffing against the manifest a later stage must match) — the exact
// same three-way classification either way: a path present in both sides
// with a different hash is "changed", present only in `recorded` is
// "missing", present only in `current` is "added".
function diffHashes(recorded: Map<string, string>, current: Map<string, string>): ManifestDiff {
	const changed: string[] = [];
	const missing: string[] = [];
	const added: string[] = [];
	for (const [path, hash] of recorded) {
		const now = current.get(path);
		if (now === undefined) missing.push(path);
		else if (now !== hash) changed.push(path);
	}
	for (const path of current.keys()) if (!recorded.has(path)) added.push(path);
	return { changed: changed.sort(), missing: missing.sort(), added: added.sort() };
}

function loadManifest(manifestPath: string): Manifest | null {
	if (!existsSync(manifestPath)) return null;
	return yamlParse(readFileSync(manifestPath, "utf8")) as Manifest | null;
}

function recordedHashes(manifest: Manifest | null): Map<string, string> {
	const recorded = new Map<string, string>();
	for (const f of manifest?.files ?? []) {
		if (f && typeof f.path === "string" && typeof f.sha256 === "string") recorded.set(f.path, f.sha256);
	}
	return recorded;
}

function appendManifestHistory(clientDir: string, entry: ManifestHistoryEntry): void {
	const path = segmentsManifestHistoryPath(clientDir);
	const existing = existsSync(path) ? (yamlParse(readFileSync(path, "utf8")) as ManifestHistory | null) : null;
	const history: ManifestHistory = {
		schema: HISTORY_SCHEMA,
		entries: [...(existing?.entries ?? []), entry],
	};
	mkdirSync(machineryPagesDir(clientDir), { recursive: true });
	writeFileSync(path, yamlStringify(history));
}

// Called by ledger.ts the instant `--gate interpret` passes. Never called by
// any stage skill or agent — that is exactly the property that makes the
// manifest trustworthy: the only code path that can move it forward is the
// same deterministic gate every re-dispatch of Stage 2 already ends with.
//
// A validator found this re-stamp was launderable: re-running the interpret
// gate over an already-tampered tree just overwrote the manifest with the
// tampered hashes, silently making the tampering the new "truth" with nothing
// anywhere recording that _segments/ had changed since the last stamp. A
// legitimate Stage-2 re-dispatch genuinely does change these files and must
// stay possible without a human unblocking it by hand — so this cannot become
// a hard block. Instead: before overwriting, diff the current tree against
// whatever manifest is already on disk, and if anything changed, append one
// entry to segments-manifest-history.yaml naming exactly which files changed,
// went missing, or appeared — attributable and durable, even though the
// re-stamp itself still proceeds. Re-stamping a tree that matches the
// existing manifest exactly (first stamp, or nothing changed since) appends
// nothing — this must stay silent and idempotent for the common case.
export function stampSegmentsManifest(clientDir: string): { path: string; fileCount: number; restamped: boolean } {
	const manifestPath = segmentsManifestPath(clientDir);
	const previous = loadManifest(manifestPath);
	const hashes = currentFileHashes(clientDir);

	let restamped = false;
	if (previous) {
		const diff = diffHashes(recordedHashes(previous), hashes);
		if (diff.changed.length || diff.missing.length || diff.added.length) {
			restamped = true;
			appendManifestHistory(clientDir, {
				stamped_at: new Date().toISOString(),
				previous_stamped_at: previous.stamped_at,
				...diff,
			});
		}
	}

	const manifest: Manifest = {
		schema: MANIFEST_SCHEMA,
		stamped_at: new Date().toISOString(),
		gate: "interpret",
		files: [...hashes.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([path, sha256]) => ({ path, sha256 })),
	};
	mkdirSync(machineryPagesDir(clientDir), { recursive: true });
	writeFileSync(manifestPath, yamlStringify(manifest));
	return { path: manifestPath, fileCount: manifest.files.length, restamped };
}

export function verifySegmentsIntegrity(clientDir: string): VerifyResult {
	const manifestPath = segmentsManifestPath(clientDir);
	const manifest = loadManifest(manifestPath);
	if (!manifest) return { status: "no-manifest", manifestPath };

	const diff = diffHashes(recordedHashes(manifest), currentFileHashes(clientDir));
	if (diff.changed.length === 0 && diff.missing.length === 0 && diff.added.length === 0) {
		return { status: "pass", manifestPath };
	}
	return { status: "tampered", manifestPath, ...diff };
}

// --- CLI --------------------------------------------------------------------

function usage(): never {
	console.error(`Usage: bun run segments-integrity -- stamp <client-dir>
       bun run segments-integrity -- verify <client-dir>

stamp  — record a sha256 manifest of every file under ข้อมูลระบบ/_segments/
         into ข้อมูลระบบ/_pages/segments-manifest.yaml. Normally only ledger.ts
         calls this, the instant \`--gate interpret\` passes.
verify — diff the current _segments/ tree against that manifest. A run with
         no manifest yet degrades to a warning (exit 0), never a hard fail.

Exit codes: stamp — 0 success, 2 usage/environment error.
            verify — 0 pass or no-manifest degrade, 1 tampered, 2 usage error.
`);
	process.exit(2);
}

function resolveClientDir(input: string): string {
	const path = resolve(input);
	if (existsSync(path) && statSync(path).isDirectory()) return path;
	const fromRoot = resolve(PROJECT_ROOT, input);
	if (existsSync(fromRoot) && statSync(fromRoot).isDirectory()) return fromRoot;
	console.error(`not a client directory: ${input}`);
	process.exit(2);
}

function main() {
	const argv = Bun.argv.slice(2);
	const [mode, ...rest] = argv;
	if (mode !== "stamp" && mode !== "verify") usage();
	const dirArg = rest.filter((a) => a !== "--help" && a !== "-h")[0];
	if (!dirArg || rest.includes("--help") || rest.includes("-h")) usage();
	const clientDir = resolveClientDir(dirArg);

	if (mode === "stamp") {
		const { path, fileCount, restamped } = stampSegmentsManifest(clientDir);
		console.log(`segments-manifest stamped: ${fileCount} files -> ${path}`);
		if (restamped) {
			console.log(
				`_segments/ changed since the previous stamp — recorded exactly which files in ` +
					`${displayRel(clientDir, segmentsManifestHistoryPath(clientDir))}`,
			);
		}
		process.exit(0);
	}

	// verify
	const result = verifySegmentsIntegrity(clientDir);
	if (result.status === "no-manifest") {
		console.error(
			`WARNING: no segments-manifest at ${displayRel(clientDir, result.manifestPath)} — this run predates the ` +
				`Stage-2 immutability check (or Stage 2 has not passed its interpret gate yet). Degrading to a ` +
				`warning, not a failure; the manifest starts existing the next time \`ledger --gate interpret\` passes.`,
		);
		process.exit(0);
	}
	if (result.status === "pass") {
		console.log(`segments-manifest OK: ข้อมูลระบบ/_segments/** matches ${displayRel(clientDir, result.manifestPath)}`);
		process.exit(0);
	}

	// tampered
	const lines: string[] = [];
	lines.push(
		`BLOCKED: ข้อมูลระบบ/_segments/** no longer matches the manifest stamped when Stage 2's interpret gate ` +
			`last passed (${displayRel(clientDir, result.manifestPath)}). Stage 2's evidence is meant to be ` +
			`immutable once approved — a later stage must never edit it to clear a guard.`,
	);
	if (result.changed.length) {
		lines.push(`Changed (content differs from the stamped version):`);
		for (const p of result.changed) lines.push(`  - ${machineryRel(clientDir, p)}`);
	}
	if (result.missing.length) {
		lines.push(`Missing (present in the manifest, gone from disk):`);
		for (const p of result.missing) lines.push(`  - ${machineryRel(clientDir, p)}`);
	}
	if (result.added.length) {
		lines.push(`Added (not in the manifest — appeared without a re-stamp):`);
		for (const p of result.added) lines.push(`  - ${machineryRel(clientDir, p)}`);
	}
	lines.push(
		`What to do instead: report this block (do not edit these files to make a downstream guard pass). ` +
			`Re-dispatch Stage 2 for the affected unit(s) through the proper path — re-run/retry the interpret ` +
			`stage (the deterministic executor's resume/re-dispatch, or the documented interactive fallback in ` +
			`.claude/skills/ksk-stage-interpret/SKILL.md) — which ends by calling \`ledger --gate interpret\` again ` +
			`and, once it passes, re-stamps this manifest automatically. Never hand-edit a file under _segments/.`,
	);
	console.error(lines.join("\n"));
	process.exit(1);
}

// Artifact paths in these messages are always "/"-separated, on every host.
// They name files inside the client's ข้อมูลระบบ/ tree, and every other stage
// (and the surrounding sentences here) refers to that tree with "/" — a
// join()-built "ข้อมูลระบบ\_segments\…" in the middle of a message that also
// says "ข้อมูลระบบ/_segments/**" is just a second spelling of the same path
// for a human to reconcile.
function displayRel(from: string, target: string): string {
	return relative(from, target).split(sep).join("/");
}

function machineryRel(_clientDir: string, segmentsRelPath: string): string {
	// segmentsRelPath is already "/"-separated — see walkFiles.
	return `ข้อมูลระบบ/_segments/${segmentsRelPath}`;
}

if (import.meta.main) main();
