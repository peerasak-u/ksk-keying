// Only readHumanStop, plus one real subprocess run of the new segments-
// integrity gate, are unit-tested here — runCompletionCheck otherwise shells
// out to real scripts in .claude/skills/ksk-keying/scripts/, already
// exercised by the real end-to-end run this module's promotion is based on.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHumanStop, runCompletionCheck } from "./completion-check";
import { STAGES } from "./logic";

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

// Real incident (client 345, month 04-69, 2026-07-28): Stage 4 hand-edited
// approved ข้อมูลระบบ/_segments/** files instead of reporting its own
// completeness-guard block. runCompletionCheck must now catch that BEFORE
// even running the "group" stage's own shape check — a real subprocess call
// into segments-integrity.ts, not mocked, same as this module's other gates.
describe("runCompletionCheck — Stage-2 immutability gate", () => {
	let targetDir: string;
	const groupStage = STAGES.find((s) => s.id === "group")!;

	beforeEach(() => {
		targetDir = mkdtempSync(join(tmpdir(), "ksk-completion-check-integrity-test-"));
	});
	afterEach(() => {
		rmSync(targetDir, { recursive: true, force: true });
	});

	test("a stage after interpret blocks loudly, naming the tampered file, when Stage-2 evidence was hand-edited", async () => {
		const segFile = join(targetDir, "ข้อมูลระบบ", "_segments", "seg-012", "interpretation-u001.json");
		mkdirSync(join(targetDir, "ข้อมูลระบบ", "_segments", "seg-012"), { recursive: true });
		writeFileSync(segFile, JSON.stringify({ usable_for_booking: true }), "utf8");

		const stampProc = Bun.spawnSync([
			"bun",
			"run",
			"--cwd",
			join(import.meta.dir, "../..", ".claude/skills/ksk-keying/scripts"),
			"segments-integrity",
			"--",
			"stamp",
			targetDir,
		]);
		expect(stampProc.exitCode).toBe(0);

		// The incident, reproduced: a later stage edits Stage 2's approved
		// output instead of reporting its own block.
		writeFileSync(segFile, JSON.stringify({ usable_for_booking: false }), "utf8");

		const result = await runCompletionCheck(groupStage, targetDir);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toMatch(/seg-012\/interpretation-u001\.json/);
		expect(result.stdout).toMatch(/report this block/);
		expect(result.stdout).toMatch(/Re-dispatch Stage 2/);
	});

	test("a run with no manifest at all (pre-upgrade) is not blocked, but the degrade warning still reaches the stage's own stdout", async () => {
		// No _segments/ tree and no manifest — degrade path. The "group" stage's
		// OWN shape check still runs and still fails on its own terms (no
		// links.yaml etc.) — the integrity gate never turns this into an exit-2
		// usage error — but the degrade warning must ALSO be present in the same
		// result, not silently dropped the way it used to be (segments-integrity
		// prints it, then this function threw the whole GateResult away on the
		// exit-0 path and returned only the stage's own result — see
		// completion-check.ts's `withIntegrityNote`). Every pre-upgrade customer
		// run degraded with nothing a human saw until this was fixed.
		const result = await runCompletionCheck(groupStage, targetDir);
		expect(result.stdout).toMatch(/no segments-manifest/);
	});
});
