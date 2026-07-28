// Stage-2 immutability check (real incident, client 345, month 04-69,
// 2026-07-28 — see segments-integrity.ts's top-of-file comment). Two things
// under test:
//   1. segments-integrity.ts's own stamp/verify functions in isolation.
//   2. ledger.ts actually calls stampSegmentsManifest the moment `--gate
//      interpret` passes — the wiring that makes re-dispatching Stage 2 the
//      one legitimate way to move the manifest forward.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { pagesDir, segmentsDir, segmentsManifestHistoryPath, segmentsManifestPath } from "../paths";
import { stampSegmentsManifest, verifySegmentsIntegrity, type ManifestHistory } from "../segments-integrity";

const LEDGER_SCRIPT = join(import.meta.dir, "..", "ledger.ts");

function tempClientDir(): string {
	return mkdtempSync(join(tmpdir(), "ksk-segments-integrity-"));
}

function writeSegmentFile(clientDir: string, relPath: string, content: string) {
	const full = join(segmentsDir(clientDir), relPath);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content, "utf8");
}

describe("segments-integrity.ts — stamp/verify", () => {
	test("verify on a fresh client dir with no manifest degrades to no-manifest, never a failure", () => {
		const dir = tempClientDir();
		const result = verifySegmentsIntegrity(dir);
		expect(result.status).toBe("no-manifest");
	});

	test("verify passes right after a stamp with no changes", () => {
		const dir = tempClientDir();
		writeSegmentFile(dir, "seg-001/interpretation-u001.json", JSON.stringify({ usable_for_booking: true }));
		writeSegmentFile(dir, "seg-002/interpretation-u001.json", JSON.stringify({ usable_for_booking: true }));
		stampSegmentsManifest(dir);
		const result = verifySegmentsIntegrity(dir);
		expect(result.status).toBe("pass");
	});

	test("verify names the exact file changed after a Stage-2 artifact is edited post-stamp", () => {
		const dir = tempClientDir();
		writeSegmentFile(dir, "seg-001/interpretation-u001.json", JSON.stringify({ usable_for_booking: true }));
		writeSegmentFile(dir, "seg-002/interpretation-u001.json", JSON.stringify({ usable_for_booking: true }));
		stampSegmentsManifest(dir);

		// Simulate the exact incident: a later stage hand-edits an approved
		// Stage-2 file instead of reporting its own block.
		writeSegmentFile(dir, "seg-002/interpretation-u001.json", JSON.stringify({ usable_for_booking: false }));

		const result = verifySegmentsIntegrity(dir);
		expect(result.status).toBe("tampered");
		if (result.status === "tampered") {
			expect(result.changed).toEqual(["seg-002/interpretation-u001.json"]);
			expect(result.missing).toEqual([]);
			expect(result.added).toEqual([]);
		}
	});

	test("verify flags a missing file and a file added without a re-stamp", () => {
		const dir = tempClientDir();
		writeSegmentFile(dir, "seg-001/interpretation-u001.json", "{}");
		writeSegmentFile(dir, "seg-002/interpretation-u001.json", "{}");
		stampSegmentsManifest(dir);

		rmSync(join(segmentsDir(dir), "seg-001/interpretation-u001.json"));
		writeSegmentFile(dir, "seg-003/interpretation-u001.json", "{}"); // never stamped

		const result = verifySegmentsIntegrity(dir);
		expect(result.status).toBe("tampered");
		if (result.status === "tampered") {
			expect(result.missing).toEqual(["seg-001/interpretation-u001.json"]);
			expect(result.added).toEqual(["seg-003/interpretation-u001.json"]);
		}
	});

	test("re-stamping after a legitimate change clears the check", () => {
		const dir = tempClientDir();
		writeSegmentFile(dir, "seg-001/interpretation-u001.json", JSON.stringify({ v: 1 }));
		stampSegmentsManifest(dir);

		// Legitimate re-dispatch of Stage 2 for this unit: the file changes...
		writeSegmentFile(dir, "seg-001/interpretation-u001.json", JSON.stringify({ v: 2 }));
		expect(verifySegmentsIntegrity(dir).status).toBe("tampered");

		// ...and the proper path re-stamps, same as ledger.ts does when
		// `--gate interpret` passes again.
		stampSegmentsManifest(dir);
		expect(verifySegmentsIntegrity(dir).status).toBe("pass");
	});

	// A validator found the re-stamp itself was launderable: nothing recorded
	// that _segments/ had changed since the previous stamp, so a blocked agent
	// could erase the evidence of its own tampering just by re-triggering
	// Stage 2's gate. stampSegmentsManifest must leave a durable, attributable
	// trail of exactly what changed — without turning a legitimate re-dispatch
	// into a hard block.
	describe("stampSegmentsManifest — re-stamp history", () => {
		test("the very first stamp writes no history file (nothing to diff against yet)", () => {
			const dir = tempClientDir();
			writeSegmentFile(dir, "seg-001/interpretation-u001.json", JSON.stringify({ v: 1 }));
			const result = stampSegmentsManifest(dir);
			expect(result.restamped).toBe(false);
			expect(existsSync(segmentsManifestHistoryPath(dir))).toBe(false);
		});

		test("re-stamping an unchanged tree stays silent and idempotent — no history entry", () => {
			const dir = tempClientDir();
			writeSegmentFile(dir, "seg-001/interpretation-u001.json", JSON.stringify({ v: 1 }));
			stampSegmentsManifest(dir);
			const result = stampSegmentsManifest(dir); // nothing changed in between
			expect(result.restamped).toBe(false);
			expect(existsSync(segmentsManifestHistoryPath(dir))).toBe(false);
		});

		test("re-stamping a changed tree appends exactly which file changed to a durable history file", () => {
			const dir = tempClientDir();
			writeSegmentFile(dir, "seg-001/interpretation-u001.json", JSON.stringify({ v: 1 }));
			writeSegmentFile(dir, "seg-002/interpretation-u001.json", JSON.stringify({ v: 1 }));
			stampSegmentsManifest(dir);

			// Real incident shape: this could be a legitimate Stage-2 re-dispatch
			// OR a tamper-then-re-stamp attempt to launder it — stampSegmentsManifest
			// cannot tell which, so it must record either case the same way rather
			// than silently accepting the new state as if nothing happened.
			writeSegmentFile(dir, "seg-002/interpretation-u001.json", JSON.stringify({ v: 2 }));
			const result = stampSegmentsManifest(dir);
			expect(result.restamped).toBe(true);

			const historyPath = segmentsManifestHistoryPath(dir);
			expect(existsSync(historyPath)).toBe(true);
			const history = yamlParse(readFileSync(historyPath, "utf8")) as ManifestHistory;
			expect(history.entries).toHaveLength(1);
			expect(history.entries[0].changed).toEqual(["seg-002/interpretation-u001.json"]);
			expect(history.entries[0].missing).toEqual([]);
			expect(history.entries[0].added).toEqual([]);

			// The manifest itself still moves forward — a legitimate re-dispatch
			// must remain possible without a human unblocking it by hand.
			expect(verifySegmentsIntegrity(dir).status).toBe("pass");
		});

		test("a second re-stamp with a further change appends a second entry, not a replacement of the first", () => {
			const dir = tempClientDir();
			writeSegmentFile(dir, "seg-001/interpretation-u001.json", JSON.stringify({ v: 1 }));
			stampSegmentsManifest(dir);
			writeSegmentFile(dir, "seg-001/interpretation-u001.json", JSON.stringify({ v: 2 }));
			stampSegmentsManifest(dir);
			writeSegmentFile(dir, "seg-001/interpretation-u001.json", JSON.stringify({ v: 3 }));
			stampSegmentsManifest(dir);

			const history = yamlParse(readFileSync(segmentsManifestHistoryPath(dir), "utf8")) as ManifestHistory;
			expect(history.entries).toHaveLength(2);
		});
	});
});

describe("segments-integrity.ts CLI — verify", () => {
	function runVerify(clientDir: string) {
		return spawnSync("bun", ["run", join(import.meta.dir, "..", "segments-integrity.ts"), "verify", clientDir], {
			encoding: "utf8",
		});
	}

	test("exit 0 and a warning when no manifest exists", () => {
		const dir = tempClientDir();
		const result = runVerify(dir);
		expect(result.status).toBe(0);
		expect(result.stderr).toMatch(/WARNING: no segments-manifest/);
	});

	test("exit 1 naming the changed file, with the report-the-block instruction", () => {
		const dir = tempClientDir();
		writeSegmentFile(dir, "seg-012/interpretation-u001.json", JSON.stringify({ usable_for_booking: true }));
		stampSegmentsManifest(dir);
		writeSegmentFile(dir, "seg-012/interpretation-u001.json", JSON.stringify({ usable_for_booking: false }));

		const result = runVerify(dir);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/seg-012\/interpretation-u001\.json/);
		expect(result.stderr).toMatch(/report this block/);
		expect(result.stderr).toMatch(/Re-dispatch Stage 2/);
	});
});

describe("ledger.ts — stamps the segments manifest exactly when --gate interpret passes", () => {
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

	function writeSegments(clientDir: string, segmentId: string, file: string, pages: [number, number]) {
		mkdirSync(segmentsDir(clientDir), { recursive: true });
		const manifestPath = join(segmentsDir(clientDir), "manifest.yaml");
		const existing = existsSync(manifestPath)
			? (yamlParse(readFileSync(manifestPath, "utf8")) as any)
			: { schema: "ksk_segments.v1", segments: [] };
		existing.segments.push({ segment_id: segmentId, sources: [{ file, pages }] });
		writeFileSync(manifestPath, yamlStringify(existing));
	}

	function writeDispositions(clientDir: string, entries: Record<string, unknown>[]) {
		mkdirSync(pagesDir(clientDir), { recursive: true });
		writeFileSync(
			join(pagesDir(clientDir), "dispositions.yaml"),
			yamlStringify({ schema: "ksk_dispositions.v1", entries }),
		);
	}

	function runLedger(clientDir: string, gate: "segment" | "interpret" | "final") {
		return spawnSync("bun", ["run", LEDGER_SCRIPT, "--gate", gate, clientDir], { encoding: "utf8" });
	}

	test("a passing interpret gate stamps the manifest; a blocked one does not", () => {
		const dir = tempClientDir();
		writeInventory(dir, [{ path: "invoice.pdf", page_count: 1 }]);
		writeSegments(dir, "seg-001", "invoice.pdf", [1, 1]);
		writeSegmentFile(dir, "seg-001/interpretation-u001.json", JSON.stringify({ usable_for_booking: true }));

		// No disposition yet -> interpret gate is blocked -> no stamp.
		const blocked = runLedger(dir, "interpret");
		expect(blocked.status).toBe(1);
		expect(existsSync(segmentsManifestPath(dir))).toBe(false);

		// Record the disposition -> interpret gate passes -> manifest appears.
		writeDispositions(dir, [{ file: "invoice.pdf", page: 1, sheet: null, disposition: "used" }]);
		const passed = runLedger(dir, "interpret");
		expect(passed.status).toBe(0);
		expect(existsSync(segmentsManifestPath(dir))).toBe(true);
		expect(passed.stdout).toMatch(/segments-manifest stamped: \d+ files/);

		const result = verifySegmentsIntegrity(dir);
		expect(result.status).toBe("pass");
	});

	test("re-running a passing interpret gate after a legitimate Stage-2 re-dispatch re-stamps (no false tamper)", () => {
		const dir = tempClientDir();
		writeInventory(dir, [{ path: "invoice.pdf", page_count: 1 }]);
		writeSegments(dir, "seg-001", "invoice.pdf", [1, 1]);
		writeSegmentFile(dir, "seg-001/interpretation-u001.json", JSON.stringify({ usable_for_booking: true, v: 1 }));
		writeDispositions(dir, [{ file: "invoice.pdf", page: 1, sheet: null, disposition: "used" }]);
		expect(runLedger(dir, "interpret").status).toBe(0);
		expect(verifySegmentsIntegrity(dir).status).toBe("pass");

		// Real re-dispatch path: Stage 2 re-runs for this unit and legitimately
		// rewrites its own interpretation file...
		writeSegmentFile(dir, "seg-001/interpretation-u001.json", JSON.stringify({ usable_for_booking: true, v: 2 }));
		expect(verifySegmentsIntegrity(dir).status).toBe("tampered");

		// ...then the executor's Audit/merge/gate phase ends, same as a first
		// run, by calling `ledger --gate interpret` again.
		const restamped = runLedger(dir, "interpret");
		expect(restamped.status).toBe(0);
		expect(verifySegmentsIntegrity(dir).status).toBe("pass");
		// The re-stamp still must not be silent about what happened — the note
		// (and the durable history file it points at) is what makes a re-stamp
		// attributable instead of a way to erase evidence of tampering.
		expect(restamped.stdout).toMatch(/_segments\/ changed since the previous interpret stamp/);
		expect(existsSync(segmentsManifestHistoryPath(dir))).toBe(true);
	});
});
