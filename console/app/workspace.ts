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

/**
 * Native separators -> POSIX ones, for values used as stable keys.
 *
 * Splits on `sep` rather than on both separators: on POSIX that is a no-op, so
 * a filename legitimately containing a backslash survives intact. (The skill
 * scripts' paths.ts helper of the same name deliberately splits on both,
 * because it normalizes values persisted on one OS and re-read on another.)
 */
export function toPosix(p: string): string {
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

export type DefaultBuyer = { name: string | null; tax_id: string | null };

/** Read <clientDir>/CLIENT.md's YAML frontmatter block and pull out
 * default_buyer {name, tax_id} — a nested object, so (unlike client_name
 * above) this needs a real YAML parse of the whole `---\n...\n---` block,
 * matching groups-io.ts's loadClientProfile technique exactly (ticket #42's
 * group-source.ts needs the same buyer fallback build-review-data.ts already
 * applies, so a reconstructed "AI original" fact set doesn't false-positive a
 * buyer field as human-edited). Returns null when the file/frontmatter/field
 * is missing or the frontmatter doesn't parse as YAML. */
export async function readDefaultBuyer(clientDir: string): Promise<DefaultBuyer | null> {
	const raw = await readFile(join(clientDir, "CLIENT.md"), "utf-8").catch(() => null);
	if (!raw) return null;
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return null;
	let doc: unknown;
	try {
		doc = yamlParse(match[1]);
	} catch {
		return null;
	}
	const buyer = (doc as Record<string, unknown> | null)?.default_buyer;
	if (!buyer || typeof buyer !== "object") return null;
	const b = buyer as { name?: unknown; tax_id?: unknown };
	return {
		name: typeof b.name === "string" ? b.name : null,
		tax_id: typeof b.tax_id === "string" ? b.tax_id : null,
	};
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

/**
 * Decode ONE URL path segment (a client id, month id or group id) into a name
 * that is safe to hand to join().
 *
 * The route patterns match segments with `[^/]+`, which stops a literal slash
 * but NOT its percent-encoding: `%2F` survives the regex and only becomes "/"
 * at decodeURIComponent, so `..%2F..%2Fetc` reached join() and escaped the
 * workspace root. `%5C` is the same trick for Windows, where a backslash is
 * also a separator — inert on POSIX, which is why this hid.
 *
 * Returns null for anything that is not a single, ordinary path component.
 */
export function decodeSegment(raw: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return null;
	}
	if (!decoded || decoded === "." || decoded === "..") return null;
	if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) return null;
	if (!isWindowsSafeComponent(decoded)) return null;
	return decoded;
}

// Reserved DOS device names. Opening one of these resolves to the device, not
// to a file, on any Windows path — so a client folder must never be addressed
// by one, whatever it is called on disk.
const WINDOWS_DEVICE_NAMES = new Set([
	"con", "prn", "aux", "nul",
	"com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
	"lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/**
 * Is this a path component Windows will open as itself?
 *
 * Applied on EVERY platform, not just win32, and deliberately so. Win32 strips
 * trailing dots and spaces when opening a path, which makes "monthA." an alias
 * for "monthA" — two spellings of one directory. Everything that locks a
 * client-month against concurrent edits (the orchestrator registry key, the
 * review guard) compares these strings exactly, so an alias walks straight past
 * a lock held on the canonical name while existsSync still says yes. Rejecting
 * the alias everywhere keeps one rule instead of two, and costs macOS/Linux
 * nothing: no name this app generates ends in a dot or a space.
 */
export function isWindowsSafeComponent(name: string): boolean {
	if (/[. ]$/.test(name)) return false;
	// A device name is reserved with or without an extension ("nul.txt" too).
	const stem = name.split(".")[0]?.toLowerCase() ?? "";
	return !WINDOWS_DEVICE_NAMES.has(stem);
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
	// Same component rule as decodeSegment, applied to every segment of a
	// multi-segment path. This is the /files/ route's third capture group,
	// which reaches the filesystem without going through seg().
	//
	// "." and ".." are skipped deliberately: they are navigation, not
	// filenames, and would otherwise trip the trailing-dot rule below. The
	// traversal check that follows is what owns them, and it already rejects
	// any ".." that actually escapes.
	if (
		decoded
			.split(/[\\/]/)
			.some((part) => part && part !== "." && part !== ".." && !isWindowsSafeComponent(part))
	)
		return null;
	const resolved = resolve(workspaceRoot, "." + sep + decoded);
	const rel = relative(workspaceRoot, resolved);
	if (rel === "") return resolved;
	if (rel.startsWith("..") || resolve(workspaceRoot, rel) !== resolved) return null;
	if (!resolved.startsWith(workspaceRoot + sep)) return null;
	return resolved;
}
