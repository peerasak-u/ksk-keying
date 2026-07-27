import { describe, expect, test } from "bun:test";
import { isClientProfilePath, lintClientMd } from "../client-md-lint";

const VALID = `---
schema: ksk_client_profile.v1
client_name: "Test Co"
---

# Client profile — Test Co

Prose body.
`;

describe("lintClientMd — structure", () => {
	test("a well-formed profile has no offenses", () => {
		expect(lintClientMd(VALID)).toEqual([]);
	});

	test("the real 345 failure: frontmatter opened and never closed", () => {
		// Exactly the shape that BLOCKED Stage 0 on 2026-07-27 — an agent
		// editing an existing profile dropped the closing delimiter.
		const broken = VALID.replace('client_name: "Test Co"\n---\n', 'client_name: "Test Co"\n');
		expect(broken.startsWith("---\n")).toBe(true); // opening delimiter still intact
		const offenses = lintClientMd(broken);
		expect(offenses).toHaveLength(1);
		expect(offenses[0]).toContain("never closes it");
	});

	test("the unterminated message points at the line where the body starts", () => {
		const [offense] = lintClientMd(`---\na: 1\nb: 2\n\n# Client profile — Test Co\n\nbody\n`);
		// Heading is the 5th line; the agent needs the closing --- above it.
		expect(offense).toContain("line 5");
		expect(offense).toContain("# Client profile");
	});

	test("no frontmatter at all is reported as a missing opening delimiter", () => {
		const [offense] = lintClientMd("# Client profile\n\nJust prose, no YAML block.\n");
		expect(offense).toContain("must open with a YAML frontmatter block");
	});

	test("a body line merely starting with --- does not count as the close", () => {
		// The old regex accepted any "---" prefix, so a horizontal rule or an
		// em-dash bullet could be mistaken for the end of the block.
		const offenses = lintClientMd(`---\na: 1\n----- not a delimiter\n\n# Body\n`);
		expect(offenses[0]).toContain("never closes it");
	});

	test("unparseable YAML between the delimiters is reported, not thrown", () => {
		const [offense] = lintClientMd(`---\nkey: "unterminated\n  - [\n---\n\n# Body\n`);
		expect(offense).toContain("not valid YAML");
	});

	test("frontmatter that parses to a non-mapping is rejected", () => {
		const [offense] = lintClientMd(`---\n- one\n- two\n---\n\n# Body\n`);
		expect(offense).toContain("not a YAML mapping");
	});

	test("CRLF line endings are accepted", () => {
		expect(lintClientMd(VALID.replace(/\n/g, "\r\n"))).toEqual([]);
	});
});

describe("lintClientMd — requireSchema divergence", () => {
	const noSchema = `---\nclient_name: "Legacy Co"\n---\n\n# Body\n`;

	test("the gate (default) tolerates a profile with no schema field", () => {
		// The gate can halt a run. Tightening it would invent a new way for a
		// previously-fine client folder to block — see client-md-lint.ts.
		expect(lintClientMd(noSchema)).toEqual([]);
	});

	test("the hook (requireSchema) asks for the schema field", () => {
		const [offense] = lintClientMd(noSchema, { requireSchema: true });
		expect(offense).toContain("ksk_client_profile.v1");
		expect(offense).toContain("missing");
	});

	test("a wrong schema value names what was found", () => {
		const [offense] = lintClientMd(`---\nschema: something_else.v9\n---\n\n# Body\n`, { requireSchema: true });
		expect(offense).toContain("something_else.v9");
	});

	test("structural offenses short-circuit before the schema check", () => {
		expect(lintClientMd("# no frontmatter\n", { requireSchema: true })).toHaveLength(1);
	});
});

describe("isClientProfilePath", () => {
	test("matches CLIENT.md in any directory, including client roots with spaces", () => {
		expect(isClientProfilePath("/workspace/345/CLIENT.md")).toBe(true);
		expect(isClientProfilePath("/workspace/_345 หจก.ประเสริฐเมืองเลย/CLIENT.md")).toBe(true);
	});

	test("does not match other files — an over-broad hook matcher stays harmless", () => {
		expect(isClientProfilePath("/workspace/345/coa.csv")).toBe(false);
		expect(isClientProfilePath("/workspace/CLIENT.md.bak")).toBe(false);
	});
});
