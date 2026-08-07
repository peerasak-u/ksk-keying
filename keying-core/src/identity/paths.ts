// The path security boundary. Plan §9.2 is explicit: "The Core resolves every
// path beneath `KSK_WORKSPACE_ROOT` and rejects traversal, symlink escape,
// URL-encoded escape, absolute host paths, and unknown client/months", and
// "API responses never expose an arbitrary host absolute path."
//
// Core trusts NO caller-supplied path (plan §9.4). Everything a caller may name
// is a `clientKey` and a `monthId`, each validated by format first, and only
// then joined and re-checked against the root — so a name that survives its own
// format check still cannot reach outside the workspace.
//
// The traversal/containment core is the runtime's own guard
// (`console/app/workspace.ts:111-124`, which spec §5.19 cites as *the* guard);
// this module adds the symlink-escape check the plan requires and that
// `resolve()` alone cannot make, because `resolve()` is pure string arithmetic
// and a symlink is a fact about the filesystem.
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CoreError } from "../errors/core-error";
import { assertMonthId } from "./month";

/** §1.4: "The client directory name under `KSK_WORKSPACE_ROOT`; Thai allowed;
 * no `/`, no leading `.`". §2.3's `invalid_client_key` adds "Empty … or fails
 * the path guard". A backslash is rejected too: it is a separator on some
 * hosts and never a legitimate part of a directory name here. */
export function isClientKey(value: string): boolean {
	if (value.length === 0) return false;
	if (value.startsWith(".")) return false;
	if (value.includes("/") || value.includes("\\")) return false;
	if (value.includes("\0")) return false;
	// A name that is only whitespace is not a directory anybody meant to name.
	if (value.trim().length === 0) return false;
	return true;
}

export function assertClientKey(value: unknown, path = "clientKey"): string {
	if (typeof value !== "string" || !isClientKey(value)) {
		throw new CoreError("invalid_client_key", {
			details: { fields: [{ path, problem: "format" }] },
		});
	}
	return value;
}

/** Decode a caller-supplied path segment EXACTLY ONCE (§5.17), then reject it
 * if either the raw or the decoded form carries a traversal segment. Checking
 * both is what closes the URL-encoded escape the plan names: `../` is caught
 * raw, `%2e%2e%2f` is caught decoded, and `%252e%252e%252f` decodes once to the
 * literal string `%2e%2e%2f`, which is a filename and not a traversal — that is
 * the intended consequence of decoding exactly once, not an oversight.
 *
 * A path that is not valid percent-encoding is rejected rather than passed
 * through, which is the runtime's behaviour too (`workspace.ts:113-116`). The
 * narrow cost, stated: a directory whose real name contains a bare `%` cannot
 * be addressed through this guard. */
function decodeOnce(rawRelPath: string): string {
	try {
		return decodeURIComponent(rawRelPath);
	} catch {
		throw new CoreError("invalid_path", { details: { fields: [{ path: "path", problem: "malformed_encoding" }] } });
	}
}

function hasTraversalSegment(value: string): boolean {
	return value
		.split(/[/\\]/)
		.some((segment) => segment === ".." || segment === "%2e%2e" || segment.toLowerCase() === "%2e%2e");
}

function invalidPath(problem: string): CoreError {
	// §2.5: an error never carries a host absolute path, so `problem` is a fixed
	// label and the offending value is never echoed back.
	return new CoreError("invalid_path", { details: { fields: [{ path: "path", problem }] } });
}

/** Resolve the deepest ancestor of `absolutePath` that exists, through
 * symlinks, and re-attach the segments that do not exist yet. A caller may
 * legitimately name a month folder that is absent (that is a `404`, decided by
 * the caller, not a `400`), so the guard must be able to answer for a path that
 * is not on disk — while still refusing one whose existing prefix is a symlink
 * pointing out of the workspace. */
function realpathDeepest(absolutePath: string): string {
	const missing: string[] = [];
	let cursor = absolutePath;
	for (;;) {
		if (existsSync(cursor)) {
			let real: string;
			try {
				real = realpathSync(cursor);
			} catch {
				throw invalidPath("unresolvable");
			}
			return missing.length === 0 ? real : join(real, ...missing.reverse());
		}
		const parent = dirname(cursor);
		if (parent === cursor) return absolutePath; // reached the filesystem root
		missing.push(cursor.slice(parent.length + 1));
		cursor = parent;
	}
}

/** The workspace root, resolved through any symlinks, so containment
 * comparisons are made in the same namespace the filesystem uses. On macOS
 * `/tmp` is itself a symlink to `/private/tmp`; without this every path under a
 * `/tmp` root would look like an escape. It goes through `realpathDeepest` for
 * the same reason a candidate does: a root that is not mounted yet must still
 * produce a comparable answer, and mixing a lexical root with a realpath'd
 * candidate would report an escape that is not one. */
export function realWorkspaceRoot(workspaceRoot: string): string {
	return realpathDeepest(resolve(workspaceRoot));
}

/** Resolve a POSIX workspace-relative path under the root, or throw
 * `400 invalid_path`. The returned value is a host absolute path for Core's own
 * filesystem use; it is never put on the wire (plan §9.2). */
export function resolveWithinRoot(workspaceRoot: string, rawRelPath: string): string {
	if (rawRelPath.includes("\0")) throw invalidPath("nul_byte");
	// An absolute host path is refused explicitly rather than incidentally, so
	// the rejection is a decision in the code and not a side effect of joining.
	if (isAbsolute(rawRelPath)) throw invalidPath("absolute_path");

	const decoded = decodeOnce(rawRelPath);
	if (decoded.includes("\0")) throw invalidPath("nul_byte");
	if (isAbsolute(decoded)) throw invalidPath("absolute_path");
	if (hasTraversalSegment(rawRelPath) || hasTraversalSegment(decoded)) throw invalidPath("traversal");

	const root = realWorkspaceRoot(workspaceRoot);
	const resolved = resolve(root, `.${sep}${decoded}`);
	const rel = relative(root, resolved);
	if (rel === "") return resolved; // the root itself
	if (rel.startsWith("..") || resolve(root, rel) !== resolved) throw invalidPath("escapes_root");
	if (!resolved.startsWith(root + sep)) throw invalidPath("escapes_root");

	// Symlink escape: the string is inside the root, but the filesystem may not
	// be. `resolve()` cannot see this; `realpath` can.
	const real = realpathDeepest(resolved);
	if (real !== root && !real.startsWith(root + sep)) throw invalidPath("symlink_escape");

	return resolved;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export type ClientMonthLocation = {
	clientKey: string;
	monthId: string;
	/** `<clientKey>/<monthId>`, POSIX. The canonical compatibility identity, and
	 * the only path form that ever crosses the wire (§1.4). */
	workspaceRelPath: string;
	/** Host absolute. For Core's own reads; never serialised. */
	absolutePath: string;
};

/** Resolve a client directory, or throw. `invalid_client_key` / `invalid_path`
 * are 400s (the name is not a name); `client_not_found` is a 404 (the name is
 * fine, the directory is not there). §2.2's line, kept. */
export function resolveClientDir(workspaceRoot: string, clientKey: unknown): { clientKey: string; absolutePath: string } {
	const key = assertClientKey(clientKey);
	const absolutePath = resolveWithinRoot(workspaceRoot, key);
	if (!isDirectory(absolutePath)) throw new CoreError("client_not_found");
	return { clientKey: key, absolutePath };
}

/** Resolve `<clientKey>/<monthId>`. Plan §9.2 step 5: Core never creates the
 * directory and never fuzzy-matches a near miss — a folder called `69-8` is one
 * the operator must rename, and it is already named in §5.2's `warnings[]`. */
export function resolveClientMonth(workspaceRoot: string, clientKey: unknown, monthId: unknown): ClientMonthLocation {
	const client = resolveClientDir(workspaceRoot, clientKey);
	const month = assertMonthId(monthId);
	const absolutePath = resolveWithinRoot(workspaceRoot, `${client.clientKey}/${month}`);
	if (!isDirectory(absolutePath)) {
		throw new CoreError("month_folder_not_found", { details: { expectedMonthId: month } });
	}
	return {
		clientKey: client.clientKey,
		monthId: month,
		workspaceRelPath: `${client.clientKey}/${month}`,
		absolutePath,
	};
}
