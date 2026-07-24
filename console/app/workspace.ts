// Two-level client/month directory walk — the same shape every client
// workspace has (samples/clients/<client>/<month>/, or a real Dropbox
// workspace root). Factored out of console/server.ts's listClients() so the
// new app's dashboard (#39) and run-store.ts's cross-workspace run listing
// share one definition instead of drifting apart.
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parse as yamlParse } from "yaml";

export type ClientMonth = {
	clientId: string;
	monthId: string;
	/** POSIX, workspace-root-relative — e.g. "216/เดือนพฤษภาคม". */
	relPath: string;
};

function toPosix(p: string): string {
	return p.split(sep).join("/");
}

async function subdirs(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	return entries
		.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
		.map((e) => e.name)
		.sort((a, b) => a.localeCompare(b, "th"));
}

// Matches a `client_name: "..."` line inside CLIENT.md's YAML frontmatter —
// same narrow regex console/server.ts already uses; a full YAML parser is
// unwarranted for pulling out one field.
const CLIENT_NAME_RE = /^client_name:\s*"([^"]*)"/m;

/** Read <clientDir>/CLIENT.md and pull out client_name, or null if the file
 * is missing or the field can't be found. */
export async function readCompanyName(clientDir: string): Promise<string | null> {
	const raw = await readFile(join(clientDir, "CLIENT.md"), "utf-8").catch(() => null);
	if (!raw) return null;
	const match = CLIENT_NAME_RE.exec(raw);
	return match ? match[1] : null;
}

export type LedgerCounts = { total: number; reviewed: number; excluded: number };

/** Read <targetDir>/ข้อมูลระบบ/_pages/ledger.yaml's `counts` (written by
 * ledger.ts's own `--gate final`) for a done run's summary line. Real data
 * already on disk — not recomputed here. Returns null if the gate has never
 * run or the file doesn't parse as expected. */
export async function readLedgerCounts(targetDir: string): Promise<LedgerCounts | null> {
	const path = join(targetDir, "ข้อมูลระบบ", "_pages", "ledger.yaml");
	if (!existsSync(path)) return null;
	try {
		const doc = yamlParse(await readFile(path, "utf8"));
		const counts = doc?.counts;
		if (!counts || typeof counts.units !== "number") return null;
		return {
			total: counts.units,
			reviewed: typeof counts.reviewed === "number" ? counts.reviewed : 0,
			excluded: typeof counts.excluded === "number" ? counts.excluded : 0,
		};
	} catch {
		return null;
	}
}

export async function listClientMonths(workspaceRoot: string): Promise<ClientMonth[]> {
	if (!existsSync(workspaceRoot)) return [];
	const result: ClientMonth[] = [];
	for (const clientId of await subdirs(workspaceRoot)) {
		const clientPath = join(workspaceRoot, clientId);
		for (const monthId of await subdirs(clientPath)) {
			result.push({ clientId, monthId, relPath: toPosix(join(clientId, monthId)) });
		}
	}
	return result;
}

/** Resolve a POSIX workspace-relative path under workspaceRoot, guarding
 * traversal. Returns null if the decoded+resolved path escapes the root. */
export function resolveUnderRoot(workspaceRoot: string, rawRelPath: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(rawRelPath);
	} catch {
		return null;
	}
	const resolved = resolve(workspaceRoot, "." + sep + decoded);
	const rel = relative(workspaceRoot, resolved);
	if (rel === "") return resolved;
	if (rel.startsWith("..") || resolve(workspaceRoot, rel) !== resolved) return null;
	if (!resolved.startsWith(workspaceRoot + sep)) return null;
	return resolved;
}
