// Regression tests for ledger.ts's real client-345 failure modes. ledger.ts
// runs `main()` unconditionally at module load (no import.meta.main guard),
// so it can't be imported as a library — these run the actual CLI as a
// subprocess, same pattern as inventory.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { buildReviewDataStalePath, docGroupsDir, pagesDir } from "../paths";

const SCRIPT = join(import.meta.dir, "..", "ledger.ts");

const tmps: string[] = [];
function tempClientDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ksk-ledger-"));
	tmps.push(dir);
	return dir;
}
afterAll(() => {
	for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

function writeInventory(clientDir: string, files: { path: string; page_count: number }[]) {
	mkdirSync(pagesDir(clientDir), { recursive: true });
	writeFileSync(
		join(pagesDir(clientDir), "inventory.yaml"),
		yamlStringify({
			schema: "ksk_inventory.v1",
			files: files.map((f) => ({ path: f.path, kind: "pdf", page_count: f.page_count, sheets: null })),
		}),
	);
}

function writeDispositions(clientDir: string, entries: Record<string, unknown>[]) {
	mkdirSync(pagesDir(clientDir), { recursive: true });
	writeFileSync(
		join(pagesDir(clientDir), "dispositions.yaml"),
		yamlStringify({ schema: "ksk_dispositions.v1", entries }),
	);
}

function writeReviewGroupData(clientDir: string, groupPath: string, pages: Record<string, unknown>[]) {
	const dir = join(docGroupsDir(clientDir), groupPath);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "review-data.json"),
		JSON.stringify({ schema: "ksk_review_group_data.v1", group_id: groupPath, label: groupPath, pages }, null, 2),
	);
}

function runLedger(clientDir: string, gate: "segment" | "interpret" | "final") {
	return spawnSync("bun", ["run", SCRIPT, "--gate", gate, clientDir], { encoding: "utf8" });
}

describe("ledger.ts — client-345 regressions", () => {
	// Bug 2's exact failure mechanism, at the ledger's own level: a claim keyed
	// by a pipeline ARTIFACT path (an interpretation.json under ข้อมูลระบบ/) can
	// never match the Inventory, which keys every unit by the SOURCE DOCUMENT
	// path — so the page it was meant to cover stays unaccounted (non-terminal)
	// even though a review-data.json claim genuinely exists for it, and the
	// mismatch itself only ever WARNS (m1), never blocks — the final gate's
	// "unaccounted" list is silent about WHY. This is the ledger-side proof of
	// why build-review-data.ts must reject an artifact-path claim before it
	// ever reaches dispositions/review-data on disk (see preflightBuiltGroups
	// in build-review-data.test.ts for the upstream guard).
	test("a claim keyed by a pipeline artifact path never matches the Inventory — the real page stays unaccounted, only a warning fires", () => {
		const dir = tempClientDir();
		writeInventory(dir, [{ path: "บิลเงินสด PSL.pdf", page_count: 1 }]);
		// review-data.json cites the interpretation ARTIFACT instead of the real
		// source document — exactly the client-345 seg-010-46-txn-113 shape.
		writeReviewGroupData(dir, "expense/non_vat/seg-010-46-txn-113", [
			{
				ref: "seg-010-46-txn-113/interpretation-u002.json p.29",
				source_src: "ข้อมูลระบบ/_segments/seg-010/interpretation-u002.json",
				source_page: 29,
				source_pages: [29],
				facts: {},
				lines: [],
				initial_status: "reviewed",
				skipped: false,
			},
		]);
		const result = runLedger(dir, "final");
		expect(result.status).toBe(1); // blocked
		expect(result.stdout).toContain("unaccounted: 1");
		expect(result.stdout).toContain("บิลเงินสด PSL.pdf#p1");
		expect(result.stdout).toMatch(/claimed unit "ข้อมูลระบบ\/_segments\/seg-010\/interpretation-u002\.json#p29" not in inventory/);
	});

	// stateOf() lets reviewed win over excluded for DISPLAY, but a unit that is
	// genuinely both must still surface as a warning — silence here would hide
	// a real conflict between an agent's exclusion proposal and a review claim
	// on the exact same page (the run-A warning: "บิลเงินสด PSL.pdf#p32 and #p33
	// are BOTH reviewed and excluded").
	test("a page that is both reviewed (a claim) and excluded (a disposition) is flagged, never silently resolved", () => {
		const dir = tempClientDir();
		writeInventory(dir, [{ path: "invoice.pdf", page_count: 2 }]);
		writeDispositions(dir, [
			{ file: "invoice.pdf", page: 1, disposition: "excluded", reason: "duplicate", duplicate_of: "invoice.pdf#p2", declared_by: "agent" },
			{ file: "invoice.pdf", page: 2, disposition: "used" },
		]);
		writeReviewGroupData(dir, "expense/non_vat/g1", [
			{
				ref: "g1/invoice.pdf p.1",
				source_src: "invoice.pdf",
				source_page: 1,
				source_pages: [1, 2],
				facts: {},
				lines: [],
				initial_status: "reviewed",
				skipped: false,
			},
		]);
		const result = runLedger(dir, "final");
		expect(result.stdout).toMatch(/unit "invoice\.pdf#p1" is both reviewed and excluded/);
		// reviewed wins for display/counting purposes — both pages terminal, pass
		expect(result.status).toBe(0);
	});

	// The Thai-path NFC/NFD case: the Inventory census always writes NFC (see
	// paths.ts / inventory.ts's own convention), but an agent's review-data.json
	// or dispositions.yaml entry could carry an NFD-normalized copy of the
	// identical visual filename (different upstream tool/OS — macOS in
	// particular is well known for writing decomposed filenames). Plain Thai
	// script text has no canonical NFC/NFD difference of its own (Thai vowel/
	// tone marks have no canonical decomposition mapping — normalize("NFD") is
	// a no-op on pure Thai), so this fixture uses a realistic mixed Thai+Latin
	// filename (a foreign counterparty name) where the Latin "é" genuinely
	// differs between the two forms — proving unitId matching (norm(), now
	// shared via unit-key.ts) unifies the two byte-different strings into the
	// same unit rather than treating them as two different files.
	test("a Thai/Latin-mixed filename written in NFD still matches its NFC Inventory entry", () => {
		const nfc = "ใบเสร็จ café.pdf".normalize("NFC");
		const nfd = "ใบเสร็จ café.pdf".normalize("NFD");
		expect(nfc).not.toBe(nfd); // fixture sanity: genuinely different bytes
		const dir = tempClientDir();
		writeInventory(dir, [{ path: nfc, page_count: 1 }]);
		writeReviewGroupData(dir, "expense/non_vat/g1", [
			{
				ref: "g1/receipt p.1",
				source_src: nfd,
				source_page: 1,
				source_pages: [1],
				facts: {},
				lines: [],
				initial_status: "reviewed",
				skipped: false,
			},
		]);
		const result = runLedger(dir, "final");
		expect(result.status).toBe(0); // pass — the claim matched despite the NFD bytes
		expect(result.stdout).toContain("reviewed:    1");
		expect(result.stdout).not.toMatch(/not in inventory/);
	});

	// Fix 3: build-review-data.ts's preflight failure writes this sentinel and
	// leaves the PREVIOUS successful build's review-data.json on disk (never
	// discards a human's saved edit that way) — so a client-month can look
	// entirely clean (every unit Reviewed) purely from a stale prior build.
	// The final gate must refuse regardless, closing the fail-open path a
	// misread exit code (or a wrapper collapsing 3 into the generic "not 0/1"
	// bucket, e.g. the console sequencer) could otherwise open.
	test("final gate blocks unconditionally while build-review-data-stale.yaml is present, even with an otherwise fully-Reviewed inventory", () => {
		const dir = tempClientDir();
		writeInventory(dir, [{ path: "invoice.pdf", page_count: 1 }]);
		writeReviewGroupData(dir, "expense/non_vat/g1", [
			{
				ref: "g1/invoice p.1",
				source_src: "invoice.pdf",
				source_page: 1,
				source_pages: [1],
				facts: {},
				lines: [],
				initial_status: "reviewed",
				skipped: false,
			},
		]);
		// Sanity: without the sentinel, this exact fixture passes clean.
		expect(runLedger(dir, "final").status).toBe(0);

		mkdirSync(pagesDir(dir), { recursive: true });
		writeFileSync(
			buildReviewDataStalePath(dir),
			yamlStringify({
				schema: "ksk_build_review_data_stale.v1",
				written_at: new Date().toISOString(),
				reason: "preflight-failed",
				detail: "1 group(s) failed preflight validation",
			}),
		);

		const result = runLedger(dir, "final");
		expect(result.status).toBe(1); // blocked
		expect(result.stdout).toMatch(/Stale categorize build/);
		expect(result.stdout).toMatch(/build-review-data-stale\.yaml/);
		expect(result.stdout).toMatch(/RESULT: BLOCKED/);
	});

	// The segment/interpret gates run BEFORE build-review-data even exists in
	// a real pipeline — the sentinel must not leak into gates it has nothing
	// to do with.
	test("the sentinel does not affect the segment/interpret gates", () => {
		const dir = tempClientDir();
		writeInventory(dir, [{ path: "invoice.pdf", page_count: 1 }]);
		mkdirSync(pagesDir(dir), { recursive: true });
		writeFileSync(
			buildReviewDataStalePath(dir),
			yamlStringify({ schema: "ksk_build_review_data_stale.v1", written_at: new Date().toISOString(), reason: "preflight-failed", detail: "x" }),
		);
		// segment gate: no segments manifest written -> every unit unsegmented,
		// still blocked, but for the segmentation reason, not the sentinel.
		const result = runLedger(dir, "segment");
		expect(result.stdout).not.toMatch(/Stale categorize build/);
	});
});
