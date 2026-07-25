import { describe, expect, test } from "bun:test";
import { summarizeRebuild } from "./rebuild-review-data";

// Verbatim shapes of build-review-data.ts's main() output — if that script
// changes its wording these tests are what catches the summary going silent.
const CLEAN = `built 38 review-data.json file(s)
next: bun run --cwd .claude/skills/ksk-keying/scripts review-groups -- --force "<client-dir>"`;

const CARRIED = `built 38 review-data.json file(s)
carried forward 10 human edit(s)
next: bun run --cwd .claude/skills/ksk-keying/scripts review-groups -- --force "<client-dir>"`;

const LOST = `built 38 review-data.json file(s)
carried forward 9 human edit(s)
⚠ 2 group(s) had review edits dropped or degraded on rebuild:
  - bank_statement/seg-001: 1 edit(s) dropped, 0 "skipped" flag(s) lost [dropped] — see bank_statement/seg-001/dropped-edits.json
  - expense/vat/seg-005: 0 edit(s) dropped, 1 "skipped" flag(s) lost [degraded] — see expense/vat/seg-005/dropped-edits.json
next: bun run --cwd .claude/skills/ksk-keying/scripts review-groups -- --force "<client-dir>"`;

const SKIPPED = `built 36 review-data.json file(s)
skipped 2 group(s) with missing inputs:
  - expense/vat/seg-009: no categorize.json
  - income/vat/seg-031: no interpretation.json
re-run the populate/categorize stage for those groups, then re-run this command`;

describe("summarizeRebuild", () => {
	test("a clean rebuild reports only the count", () => {
		const s = summarizeRebuild(CLEAN);
		expect(s).toMatchObject({ built: 38, carried: 0, lostGroups: 0, skippedGroups: 0 });
		expect(s.message).toBe("สร้างข้อมูลรีวิวใหม่ 38 กลุ่ม");
	});

	test("carried edits are counted and named in the message", () => {
		const s = summarizeRebuild(CARRIED);
		expect(s.carried).toBe(10);
		expect(s.message).toContain("ยกรายการที่แก้ไว้มา 10 รายการ");
		expect(s.message).not.toContain("⚠");
	});

	test("dropped edits surface as a warning, not a silent success", () => {
		const s = summarizeRebuild(LOST);
		expect(s).toMatchObject({ built: 38, carried: 9, lostGroups: 2 });
		expect(s.message).toContain("⚠ 2 กลุ่ม");
		expect(s.message).toContain("dropped-edits.json");
	});

	test("groups with missing inputs are counted separately from built ones", () => {
		const s = summarizeRebuild(SKIPPED);
		expect(s).toMatchObject({ built: 36, skippedGroups: 2, carried: 0 });
		expect(s.message).toContain("ข้าม 2 กลุ่ม");
	});

	test("unrecognised output degrades to zeros instead of throwing", () => {
		const s = summarizeRebuild("bun: command not found");
		expect(s).toMatchObject({ built: 0, carried: 0, lostGroups: 0, skippedGroups: 0 });
		expect(s.message).toBe("สร้างข้อมูลรีวิวใหม่ 0 กลุ่ม");
	});

	test("a count that isn't a finite number can't leak into the message", () => {
		// Defensive: the regex only matches digits, so this is really asserting
		// the guard stays in place if the pattern is ever loosened.
		expect(summarizeRebuild("built 99999999999999999999 review-data.json file(s)").built).not.toBeNaN();
	});
});
