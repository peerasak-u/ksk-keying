// The rejections are the point of this file. Every test below is written so it
// FAILS if its rejection is removed — plan §9.2 calls this a trust boundary and
// a happy-path-only suite would prove nothing about it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErrorCode } from "../errors/codes";
import { CoreError } from "../errors/core-error";
import { assertClientKey, isClientKey, resolveClientDir, resolveClientMonth, resolveWithinRoot } from "./paths";

let root = "";
let outside = "";

beforeAll(() => {
	const base = mkdtempSync(join(tmpdir(), "keying-core-paths-"));
	root = join(base, "workspace");
	outside = join(base, "outside");
	mkdirSync(join(root, "216", "69-08"), { recursive: true });
	mkdirSync(join(root, "ศรีชัย", "69-07"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "secret.txt"), "not yours");
	// A symlink that stays inside the root is fine; one that leaves is not.
	symlinkSync(outside, join(root, "escape-hatch"));
	symlinkSync(join(root, "216"), join(root, "inside-link"));
});

afterAll(() => {
	if (root) rmSync(join(root, ".."), { recursive: true, force: true });
});

function expectCoreError(fn: () => unknown, code: ErrorCode): CoreError {
	try {
		fn();
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(CoreError);
		const error = thrown as CoreError;
		expect(error.code).toBe(code);
		return error;
	}
	throw new Error(`expected a CoreError with code ${code}, but nothing was thrown`);
}

describe("clientKey (§1.4, §2.3 invalid_client_key)", () => {
	test("accepts a Thai name and a numeric name", () => {
		expect(isClientKey("216")).toBe(true);
		expect(isClientKey("ศรีชัย")).toBe(true);
		expect(isClientKey("บริษัท สองหนึ่งหก จำกัด")).toBe(true);
	});

	test("rejects empty, a leading dot, a slash, a backslash, and a NUL", () => {
		for (const value of ["", ".", ".git", ".claude", "a/b", "a\\b", "a\0b", "   "]) {
			expect(isClientKey(value)).toBe(false);
		}
	});

	test("assertClientKey throws 400 invalid_client_key, not a 404", () => {
		const error = expectCoreError(() => assertClientKey("../etc"), "invalid_client_key");
		expect(error.status).toBe(400);
	});

	test("assertClientKey rejects a non-string", () => {
		expectCoreError(() => assertClientKey(216), "invalid_client_key");
		expectCoreError(() => assertClientKey(undefined), "invalid_client_key");
	});
});

describe("resolveWithinRoot — the five rejections plan §9.2 names", () => {
	test("allows a real relative path under the root", () => {
		expect(resolveWithinRoot(root, "216/69-08")).toContain("216");
		expect(resolveWithinRoot(root, "216")).toContain("216");
	});

	test("allows a path that does not exist yet — absence is the caller's 404, not a 400", () => {
		expect(() => resolveWithinRoot(root, "216/69-09")).not.toThrow();
		expect(() => resolveWithinRoot(root, "ยังไม่มี/69-08")).not.toThrow();
	});

	test("rejects traversal", () => {
		for (const value of ["../outside", "216/../../outside", "..", "216/..%2f..", "a/../../b"]) {
			expectCoreError(() => resolveWithinRoot(root, value), "invalid_path");
		}
	});

	test("rejects URL-encoded traversal", () => {
		for (const value of ["%2e%2e/outside", "216/%2e%2e/%2e%2e/outside", "%2E%2E%2Foutside", "..%2foutside"]) {
			expectCoreError(() => resolveWithinRoot(root, value), "invalid_path");
		}
	});

	test("decodes exactly once, so a double-encoded traversal stays a literal name", () => {
		// `%252e%252e%252f` decodes once to the literal `%2e%2e%2f`, which is a
		// filename and not a traversal. It must resolve INSIDE the root — that is
		// the intended consequence of §5.17's decode-exactly-once rule.
		const resolved = resolveWithinRoot(root, "%252e%252e%252fx");
		// Compared against the root's realpath: on macOS the tmpdir is itself a
		// symlink, and resolveWithinRoot deliberately answers in the filesystem's
		// own namespace.
		expect(resolved.startsWith(realpathSync(root))).toBe(true);
	});

	test("rejects an absolute host path", () => {
		for (const value of ["/etc/passwd", "/", `${outside}/secret.txt`, "//etc/passwd"]) {
			expectCoreError(() => resolveWithinRoot(root, value), "invalid_path");
		}
	});

	test("rejects an encoded absolute host path", () => {
		expectCoreError(() => resolveWithinRoot(root, "%2Fetc%2Fpasswd"), "invalid_path");
	});

	test("rejects a symlink that escapes the root", () => {
		expectCoreError(() => resolveWithinRoot(root, "escape-hatch"), "invalid_path");
		expectCoreError(() => resolveWithinRoot(root, "escape-hatch/secret.txt"), "invalid_path");
	});

	test("allows a symlink that stays inside the root", () => {
		expect(() => resolveWithinRoot(root, "inside-link")).not.toThrow();
		expect(() => resolveWithinRoot(root, "inside-link/69-08")).not.toThrow();
	});

	test("a workspace root that does not exist still resolves without throwing on the root itself", () => {
		// realWorkspaceRoot falls back to the lexically resolved path when the root
		// cannot be realpath'd, so a missing mount produces a clean 404 from the
		// caller rather than an unhandled failure inside the guard.
		const gone = join(root, "no-such-root");
		expect(() => resolveWithinRoot(gone, "216/69-08")).not.toThrow();
		expectCoreError(() => resolveWithinRoot(gone, "../escape"), "invalid_path");
	});

	test("rejects a NUL byte and malformed percent-encoding", () => {
		expectCoreError(() => resolveWithinRoot(root, "216/\0/69-08"), "invalid_path");
		expectCoreError(() => resolveWithinRoot(root, "216/%zz"), "invalid_path");
	});

	test("the error never echoes a host path back to the caller (§2.5)", () => {
		const error = expectCoreError(() => resolveWithinRoot(root, `${outside}/secret.txt`), "invalid_path");
		expect(JSON.stringify(error.toBody("req_x"))).not.toContain(outside);
		expect(JSON.stringify(error.toBody("req_x"))).not.toContain("secret.txt");
	});
});

describe("resolveClientDir / resolveClientMonth — unknown client/months", () => {
	test("resolves a real client and month", () => {
		const location = resolveClientMonth(root, "216", "69-08");
		expect(location.workspaceRelPath).toBe("216/69-08");
		expect(location.clientKey).toBe("216");
		expect(location.monthId).toBe("69-08");
	});

	test("resolves a Thai client name", () => {
		expect(resolveClientMonth(root, "ศรีชัย", "69-07").workspaceRelPath).toBe("ศรีชัย/69-07");
	});

	test("an unknown client is 404 client_not_found", () => {
		const error = expectCoreError(() => resolveClientDir(root, "ไม่มีลูกค้ารายนี้"), "client_not_found");
		expect(error.status).toBe(404);
	});

	test("a valid monthId with no directory is 404 month_folder_not_found, naming the expected monthId", () => {
		const error = expectCoreError(() => resolveClientMonth(root, "216", "69-09"), "month_folder_not_found");
		expect(error.status).toBe(404);
		expect(error.details).toEqual({ expectedMonthId: "69-09" });
	});

	test("a malformed monthId is 400 invalid_month_id, NOT 404 — §2.2's consequence 1", () => {
		const error = expectCoreError(() => resolveClientMonth(root, "216", "69-8"), "invalid_month_id");
		expect(error.status).toBe(400);
	});

	test("never fuzzy-matches a near miss (plan §9.2 step 5)", () => {
		// `69-8` exists nowhere; even if a `69-8` folder existed, the format check
		// fires first and Core never guesses which folder was meant.
		mkdirSync(join(root, "216", "69-8"), { recursive: true });
		expectCoreError(() => resolveClientMonth(root, "216", "69-8"), "invalid_month_id");
		rmSync(join(root, "216", "69-8"), { recursive: true, force: true });
	});

	test("a client key that would traverse never reaches the filesystem", () => {
		expectCoreError(() => resolveClientMonth(root, "../outside", "69-08"), "invalid_client_key");
		expectCoreError(() => resolveClientMonth(root, "216/69-08", "69-08"), "invalid_client_key");
	});

	test("a symlinked client directory that escapes the root is refused", () => {
		expectCoreError(() => resolveClientDir(root, "escape-hatch"), "invalid_path");
	});

	test("a file where a directory is expected is not a client", () => {
		writeFileSync(join(root, "notes.txt"), "x");
		expectCoreError(() => resolveClientDir(root, "notes.txt"), "client_not_found");
		rmSync(join(root, "notes.txt"), { force: true });
	});
});
