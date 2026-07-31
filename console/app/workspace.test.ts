import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { decodeSegment, listClientMonths, readCompanyName, readDefaultBuyer, readLedgerCounts, resolveUnderRoot } from "./workspace";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ksk-workspace-test-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("listClientMonths", () => {
	test("walks two levels and skips dotfiles/node_modules", async () => {
		mkdirSync(join(root, "216", "เดือนพฤษภาคม"), { recursive: true });
		mkdirSync(join(root, "216", "เดือนมิถุนายน"), { recursive: true });
		mkdirSync(join(root, "339", "เดือนมกราคม"), { recursive: true });
		mkdirSync(join(root, ".git"), { recursive: true });
		mkdirSync(join(root, "216", "node_modules"), { recursive: true });

		const result = await listClientMonths(root);
		expect(result).toEqual([
			{ clientId: "216", monthId: "เดือนพฤษภาคม", relPath: "216/เดือนพฤษภาคม" },
			{ clientId: "216", monthId: "เดือนมิถุนายน", relPath: "216/เดือนมิถุนายน" },
			{ clientId: "339", monthId: "เดือนมกราคม", relPath: "339/เดือนมกราคม" },
		]);
	});

	test("returns [] when the workspace root doesn't exist", async () => {
		expect(await listClientMonths(join(root, "nope"))).toEqual([]);
	});
});

describe("readCompanyName", () => {
	test("returns null when CLIENT.md is missing", async () => {
		expect(await readCompanyName(root)).toBeNull();
	});

	test("parses client_name out of CLIENT.md's frontmatter", async () => {
		writeFileSync(join(root, "CLIENT.md"), '---\nclient_name: "บริษัท ทดสอบ จำกัด"\n---\n\nbody text\n', "utf8");
		expect(await readCompanyName(root)).toBe("บริษัท ทดสอบ จำกัด");
	});
});

describe("readDefaultBuyer", () => {
	test("returns null when CLIENT.md is missing", async () => {
		expect(await readDefaultBuyer(root)).toBeNull();
	});

	test("returns null when the frontmatter has no default_buyer", async () => {
		writeFileSync(join(root, "CLIENT.md"), '---\nclient_name: "บริษัท ทดสอบ จำกัด"\n---\n', "utf8");
		expect(await readDefaultBuyer(root)).toBeNull();
	});

	test("parses a nested default_buyer out of the frontmatter", async () => {
		const frontmatter = yamlStringify({ client_name: "บริษัท ทดสอบ จำกัด", default_buyer: { name: "บริษัท ทดสอบ จำกัด", tax_id: "0105500000000" } });
		writeFileSync(join(root, "CLIENT.md"), `---\n${frontmatter}---\n\nbody text\n`, "utf8");
		expect(await readDefaultBuyer(root)).toEqual({ name: "บริษัท ทดสอบ จำกัด", tax_id: "0105500000000" });
	});

	test("returns null when the frontmatter isn't valid YAML", async () => {
		writeFileSync(join(root, "CLIENT.md"), "---\nnot: valid: : yaml: shape:\n---\n", "utf8");
		expect(await readDefaultBuyer(root)).toBeNull();
	});
});

describe("readLedgerCounts", () => {
	test("returns null when ledger.yaml doesn't exist", async () => {
		expect(await readLedgerCounts(root)).toBeNull();
	});

	test("reads real counts written by ledger.ts's shape", async () => {
		const dir = join(root, "ข้อมูลระบบ", "_pages");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "ledger.yaml"),
			yamlStringify({
				schema: "ksk_ledger.v1",
				gate: "final",
				result: "pass",
				counts: { files: 5, units: 52, reviewed: 50, excluded: 2, excluded_human: 1, excluded_agent: 1, segmented: 0, unaccounted: 0 },
			}),
			"utf8",
		);
		expect(await readLedgerCounts(root)).toEqual({ total: 52, reviewed: 50, excluded: 2 });
	});

	test("returns null on a malformed counts shape", async () => {
		const dir = join(root, "ข้อมูลระบบ", "_pages");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "ledger.yaml"), "not: valid: : yaml: shape:", "utf8");
		expect(await readLedgerCounts(root)).toBeNull();
	});
});

describe("resolveUnderRoot", () => {
	test("resolves a plain relative path", () => {
		expect(resolveUnderRoot(root, "216/เดือนพฤษภาคม")).toBe(join(root, "216", "เดือนพฤษภาคม"));
	});

	test("rejects a traversal attempt", () => {
		expect(resolveUnderRoot(root, "../../etc/passwd")).toBeNull();
	});
});

describe("decodeSegment", () => {
	test("decodes an ordinary Thai month name", () => {
		expect(decodeSegment(encodeURIComponent("เดือนพฤษภาคม"))).toBe("เดือนพฤษภาคม");
	});

	test("keeps names with spaces, dots and parentheses intact", () => {
		const name = "(พร้อมทดสอบ)_216 บจก.ชามหวาน";
		expect(decodeSegment(encodeURIComponent(name))).toBe(name);
	});

	// The whole point: `[^/]+` in the route patterns lets these through, and
	// they only become separators once decoded.
	test("rejects a percent-encoded forward slash", () => {
		expect(decodeSegment("..%2F..%2Fetc")).toBeNull();
	});

	test("rejects a percent-encoded backslash (a separator on Windows)", () => {
		expect(decodeSegment("..%5C..%5CWindows")).toBeNull();
	});

	test("rejects bare dot segments and empty input", () => {
		expect(decodeSegment(".")).toBeNull();
		expect(decodeSegment("..")).toBeNull();
		expect(decodeSegment("")).toBeNull();
	});

	test("rejects a NUL byte and malformed percent-encoding", () => {
		expect(decodeSegment("a%00b")).toBeNull();
		expect(decodeSegment("%E0%A4%A")).toBeNull();
	});

	// Win32 strips these when opening a path, so "monthA." and "monthA" are one
	// directory — an alias that walks past any lock held on the canonical name.
	test("rejects a trailing dot or space", () => {
		expect(decodeSegment("monthA.")).toBeNull();
		expect(decodeSegment("monthA%20")).toBeNull();
		expect(decodeSegment("monthA")).toBe("monthA");
	});

	test("rejects reserved Windows device names, with or without an extension", () => {
		expect(decodeSegment("CON")).toBeNull();
		expect(decodeSegment("nul")).toBeNull();
		expect(decodeSegment("COM1")).toBeNull();
		expect(decodeSegment("nul.txt")).toBeNull();
		// A name that merely starts with those letters is fine.
		expect(decodeSegment("console")).toBe("console");
		expect(decodeSegment("nulled")).toBe("nulled");
	});
});

describe("resolveUnderRoot component safety", () => {
	test("rejects a reserved device name in any component", () => {
		expect(resolveUnderRoot(root, "216/NUL/file.pdf")).toBeNull();
		expect(resolveUnderRoot(root, "216/x/CON")).toBeNull();
	});

	test("rejects a component with a trailing dot", () => {
		expect(resolveUnderRoot(root, "216/monthA./f.pdf")).toBeNull();
	});

	test("still resolves ordinary nested Thai paths", () => {
		expect(resolveUnderRoot(root, "216/เดือนพฤษภาคม/ข้อมูลระบบ/_pages/a.png")).toBe(
			join(root, "216", "เดือนพฤษภาคม", "ข้อมูลระบบ", "_pages", "a.png"),
		);
	});
});
