// Only readHumanStop is unit-tested here — runCompletionCheck shells out to
// real scripts in .claude/skills/ksk-keying/scripts/, already exercised by
// the real end-to-end run this module's promotion is based on.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHumanStop } from "./completion-check";

let targetDir: string;

beforeEach(() => {
	targetDir = mkdtempSync(join(tmpdir(), "ksk-completion-check-test-"));
});

afterEach(() => {
	rmSync(targetDir, { recursive: true, force: true });
});

describe("readHumanStop", () => {
	test("returns [] when human-stop.yaml doesn't exist", async () => {
		expect(await readHumanStop(targetDir)).toEqual([]);
	});

	test("parses decision-policy.md's documented schema, including a reason with a colon", async () => {
		const dir = join(targetDir, "ข้อมูลระบบ", "_pages");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "human-stop.yaml"),
			[
				"schema: ksk_human_stop.v1",
				"entries:",
				"  - stage: interpret",
				"    unit: seg-004",
				"    condition: unreadable_required_source",
				'    reason: "invoice.pdf page 6 is corrupted: pdfinfo cannot read it"',
			].join("\n"),
			"utf8",
		);
		const entries = await readHumanStop(targetDir);
		expect(entries).toEqual([
			{
				stage: "interpret",
				unit: "seg-004",
				condition: "unreadable_required_source",
				reason: "invoice.pdf page 6 is corrupted: pdfinfo cannot read it",
			},
		]);
	});

	test("a client-wide entry has unit: null", async () => {
		const dir = join(targetDir, "ข้อมูลระบบ", "_pages");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "human-stop.yaml"),
			["schema: ksk_human_stop.v1", "entries:", "  - stage: profile", "    unit: null", "    condition: no_coa_source", "    reason: no ผังบัญชี found anywhere"].join(
				"\n",
			),
			"utf8",
		);
		const entries = await readHumanStop(targetDir);
		expect(entries[0].unit).toBeNull();
	});
});
