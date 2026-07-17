// File I/O shared by the doc-group CLIs (group-skeleton, group-populate,
// build-review-data). Pure transforms live in groups-lib.ts.

import { dirname, join, relative, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { parse as yamlParse, type SchemaOptions } from "yaml";
import { docGroupsDir, segmentsDir } from "./paths";
import type {
	GroupPlan,
	InterpFile,
	Interpretation,
	LinkCluster,
	SegmentSourceRef,
} from "./groups-lib";

const TOOL_DIR = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = resolve(TOOL_DIR, "../../../..");

// A Stage-3 child can write a long or leading-zero document_no UNQUOTED in
// links.yaml (e.g. an 18-digit e-Tax invoice id, or "065091238867"). yaml's
// default schema then parses it as a number — losing precision past 2^53 and
// dropping the leading zero — after which planGroups's `typeof === "string"`
// filter silently drops the whole document from the books (money lost). Resolve
// every int/float scalar to its exact source string instead: document numbers
// are the only numeric-looking scalars in links.yaml, so null/bool/text are
// untouched and nothing is lost. Scoped to links.yaml — segment/group manifests
// carry real numbers (page counts) and keep the default schema.
const LINKS_YAML_OPTS: SchemaOptions = {
	customTags: (tags) =>
		tags.map((t) =>
			t.tag === "tag:yaml.org,2002:int" || t.tag === "tag:yaml.org,2002:float"
				? { ...t, resolve: (str: string) => str }
				: t,
		),
};

export function resolveClientDir(input: string): string {
	const path = resolve(input);
	if (existsSync(path) && statSync(path).isDirectory()) return path;
	const fromRoot = resolve(PROJECT_ROOT, input);
	if (existsSync(fromRoot) && statSync(fromRoot).isDirectory()) return fromRoot;
	console.error(`not a client directory: ${input}`);
	process.exit(2);
}

export function readJson<T>(path: string, label: string): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		console.error(
			`failed to parse ${label} (${path}): ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(2);
	}
}

export function readYaml<T>(path: string, label: string, options?: SchemaOptions): T {
	try {
		return yamlParse(readFileSync(path, "utf8"), options) as T;
	} catch (error) {
		console.error(
			`failed to parse ${label} (${path}): ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(2);
	}
}

// Every Stage-2 interpretation file, keyed by segment id, paths kept
// client-root-relative (they go into manifests and prompts verbatim).
export function loadInterpretations(clientDir: string): Map<string, InterpFile[]> {
	const root = segmentsDir(clientDir);
	const bySegment = new Map<string, InterpFile[]>();
	if (!existsSync(root)) return bySegment;
	for (const segmentId of readdirSync(root).sort()) {
		const dir = join(root, segmentId);
		if (!statSync(dir).isDirectory()) continue;
		const files = readdirSync(dir)
			.filter((name) => name.startsWith("interpretation") && name.endsWith(".json"))
			.sort();
		if (!files.length) continue;
		bySegment.set(
			segmentId,
			files.map((name) => ({
				path: relative(clientDir, join(dir, name)),
				segmentId,
				json: readJson<Interpretation>(join(dir, name), `interpretation ${segmentId}/${name}`),
			})),
		);
	}
	return bySegment;
}

export function loadLinks(clientDir: string): { clusters: LinkCluster[]; evidenceById: Map<string, string> } | null {
	const path = join(docGroupsDir(clientDir), "links.yaml");
	if (!existsSync(path)) return null;
	const doc = readYaml<{ transactions?: LinkCluster[] }>(path, "links.yaml", LINKS_YAML_OPTS);
	const clusters = Array.isArray(doc?.transactions) ? doc.transactions : [];
	const evidenceById = new Map<string, string>();
	for (const cluster of clusters)
		if (cluster.transaction_id && cluster.evidence)
			evidenceById.set(cluster.transaction_id, cluster.evidence);
	return { clusters, evidenceById };
}

export function loadSegmentSources(clientDir: string): Map<string, SegmentSourceRef[]> {
	const path = join(segmentsDir(clientDir), "manifest.yaml");
	const map = new Map<string, SegmentSourceRef[]>();
	if (!existsSync(path)) return map;
	const doc = readYaml<{ segments?: { segment_id?: string; sources?: SegmentSourceRef[] }[] }>(
		path,
		"segment manifest",
	);
	for (const segment of doc?.segments ?? [])
		if (segment.segment_id && Array.isArray(segment.sources))
			map.set(
				segment.segment_id,
				segment.sources.map((s) => ({
					file: s.file,
					pages: s.pages ?? null,
					sheets: s.sheets ?? null,
				})),
			);
	return map;
}

// Leaf group directories already on disk under ข้อมูลระบบ/_doc_groups/, as
// paths relative to that root (e.g. "expense/vat/seg-005-INV-001",
// "bank_statement/seg-009"). A "leaf" is any directory with no subdirectories
// of its own — the manifest.yaml/links.yaml files living at docGroupsDir's
// top level are not directories, so they're never mistaken for one. Used to
// detect group directories orphaned by a links.yaml edit since the last run
// (orphanedGroupDirs in groups-lib.ts does the comparison against the fresh
// plan; this only walks the filesystem).
export function listExistingGroupDirs(groupsRoot: string): string[] {
	const leaves: string[] = [];
	function walk(dir: string, rel: string) {
		const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
		if (entries.length === 0) {
			if (rel) leaves.push(rel);
			return;
		}
		for (const entry of entries) walk(join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
	}
	if (existsSync(groupsRoot)) walk(groupsRoot, "");
	return leaves;
}

export type GroupManifest = {
	schema?: string;
	layout?: string;
	groups?: GroupPlan[];
};

export function loadGroupManifest(clientDir: string): GroupManifest {
	const path = join(docGroupsDir(clientDir), "manifest.yaml");
	if (!existsSync(path)) {
		console.error(`missing ${path} — run group-skeleton first`);
		process.exit(2);
	}
	const doc = readYaml<GroupManifest>(path, "doc-group manifest");
	if (!Array.isArray(doc?.groups)) {
		console.error(`malformed doc-group manifest (${path}): missing groups[] list`);
		process.exit(2);
	}
	return doc;
}

// CLIENT.md carries a machine-parseable YAML frontmatter (ksk_client_profile.v1).
export function loadClientProfile(clientDir: string): Record<string, unknown> | null {
	const path = join(clientDir, "CLIENT.md");
	if (!existsSync(path)) return null;
	const text = readFileSync(path, "utf8");
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return null;
	try {
		const doc = yamlParse(match[1]);
		return doc && typeof doc === "object" ? (doc as Record<string, unknown>) : null;
	} catch {
		console.error(`warning: CLIENT.md frontmatter is not valid YAML — buyer fallback unavailable`);
		return null;
	}
}
