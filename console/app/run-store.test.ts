import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { initialState } from "../sequencer/logic";
import { listAllRunRecords, loadRunRecord, newRunRecord, saveRunRecord } from "./run-store";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ksk-run-store-test-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("loadRunRecord", () => {
	test("returns null when no run-state.yaml exists yet", async () => {
		expect(await loadRunRecord(root)).toBeNull();
	});
});

describe("save + load round trip", () => {
	test("preserves state, timestamps, and Thai/multiline text intact", async () => {
		const record = newRunRecord();
		record.state = {
			...record.state,
			stageIndex: 2,
			status: "blocked",
			retryCount: 1,
			lastGateStdout: "หน้า 6 อ่านไม่ได้: pdfinfo error\nline two",
			humanStopEntries: [
				{ stage: "interpret", unit: "seg-004", condition: "unreadable_required_source", reason: "corrupt: pdf" },
			],
			log: ["interpret: starting", "interpret: completion check exit 1 — BLOCKED"],
		};
		record.finishedAt = null;
		saveRunRecord(root, record);

		const loaded = await loadRunRecord(root);
		expect(loaded).toEqual(record);
	});

	test("a fresh record round-trips to the same shape as initialState()", async () => {
		const record = newRunRecord();
		saveRunRecord(root, record);
		const loaded = await loadRunRecord(root);
		expect(loaded?.state).toEqual(initialState());
		expect(loaded?.finishedAt).toBeNull();
	});

	test("a fresh record stamps stageStartedAt at creation (dashboard ticket #2)", async () => {
		const record = newRunRecord();
		expect(record.stageStartedAt).toBe(record.startedAt);
		saveRunRecord(root, record);
		const loaded = await loadRunRecord(root);
		expect(loaded?.stageStartedAt).toBe(record.startedAt);
	});
});

describe("backward compatibility — run-state.yaml written before stageStartedAt existed", () => {
	test("a doc with no stage_started_at key loads without error, and the field is null", async () => {
		// Hand-written, deliberately WITHOUT stage_started_at — reproduces a
		// real run-state.yaml on disk right now that predates the field, and
		// one a live run could still be writing. loadRunRecord must not throw,
		// and the dashboard card is expected to simply omit its "ขั้นนี้ N นาที"
		// clause when this comes back null (see dashboard.test.ts).
		const doc = {
			schema: "ksk_run_state.v1",
			started_at: "2026-07-01T00:00:00.000Z",
			updated_at: "2026-07-01T00:05:00.000Z",
			finished_at: null,
			state: initialState(),
		};
		const path = join(root, "ข้อมูลระบบ", "_pages", "run-state.yaml");
		mkdirSync(join(root, "ข้อมูลระบบ", "_pages"), { recursive: true });
		writeFileSync(path, yamlStringify(doc), "utf8");

		const loaded = await loadRunRecord(root);
		expect(loaded).not.toBeNull();
		expect(loaded?.stageStartedAt).toBeNull();
		expect(loaded?.startedAt).toBe("2026-07-01T00:00:00.000Z");
		expect(loaded?.state).toEqual(initialState());
	});
});

describe("listAllRunRecords", () => {
	test("finds records only for client-months that have actually run", async () => {
		// client A / month 1 — has run-state.yaml
		const a1 = join(root, "A", "month-1");
		mkdirSync(a1, { recursive: true });
		saveRunRecord(a1, newRunRecord());

		// client A / month 2 — never run
		mkdirSync(join(root, "A", "month-2"), { recursive: true });

		// client B / month 1 — has run-state.yaml
		const b1 = join(root, "B", "month-1");
		mkdirSync(b1, { recursive: true });
		const doneRecord = newRunRecord();
		doneRecord.state = { ...doneRecord.state, status: "done" };
		saveRunRecord(b1, doneRecord);

		const records = await listAllRunRecords(root);
		const byRelPath = Object.fromEntries(records.map((r) => [r.relPath, r]));
		expect(records.length).toBe(2);
		expect(byRelPath["A/month-1"].state.status).toBe("idle");
		expect(byRelPath["B/month-1"].state.status).toBe("done");
		expect(byRelPath["A/month-2"]).toBeUndefined();
	});
});
