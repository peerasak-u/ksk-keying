import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../observability/logger";
import { createFixture, type Fixture } from "../test-support/workspace-fixture";
import {
	measureRepairImpact,
	readCompanyName,
	readGroupTotals,
	readLedgerCounts,
	scanWorkspace,
} from "./workspace-repository";

let fixture: Fixture;

beforeEach(() => {
	fixture = createFixture();
});

afterEach(() => fixture.cleanup());

describe("scanWorkspace (plan §9.2 [r3])", () => {
	test("walks two levels and returns months in Thai collation order", () => {
		fixture.addMonth("ศรีชัย", "69-08");
		fixture.addMonth("216", "69-08");
		fixture.addMonth("216", "69-07");
		const scan = scanWorkspace(fixture.root);
		expect(scan.clientMonths.map((cm) => cm.workspaceRelPath)).toEqual(["216/69-07", "216/69-08", "ศรีชัย/69-08"]);
		expect(scan.clients).toBe(2);
		expect(scan.months).toBe(3);
	});

	test("a missing root is an empty scan, not a throw", () => {
		expect(scanWorkspace(join(fixture.root, "nope"))).toEqual({ clientMonths: [], warnings: [], clients: 0, months: 0 });
	});

	test("a skipped folder is not registered, not scanned, and not resolvable — but it IS reported", () => {
		fixture.addMonth("216", "69-08");
		fixture.addMonth("216", "69-8");
		const scan = scanWorkspace(fixture.root);
		expect(scan.clientMonths.map((cm) => cm.monthId)).toEqual(["69-08"]);
		expect(scan.warnings).toEqual([
			{
				code: "month_folder_ignored",
				clientKey: "216",
				name: "69-8",
				message: "ชื่อโฟลเดอร์เดือนไม่ตรงรูปแบบ YY-MM จึงข้ามไป",
			},
		]);
	});

	test("writes one structured log line per offending directory, name verbatim", () => {
		fixture.addMonth("216", "69-08 ");
		const lines: string[] = [];
		scanWorkspace(fixture.root, createLogger({ sink: (line) => lines.push(line), level: "debug" }));
		expect(lines.length).toBe(1);
		const line = JSON.parse(lines[0]);
		expect(line.event).toBe("workspace.month_folder_ignored");
		expect(line.level).toBe("warn");
		// The trailing space survives into the log rather than being normalised.
		expect(line.name).toBe("69-08 ");
	});

	test("dot-directories are excluded at both levels and warn about nothing", () => {
		fixture.addMonth(".git", "69-08");
		fixture.addMonth("216", ".claude");
		fixture.addMonth("216", "69-08");
		const scan = scanWorkspace(fixture.root);
		expect(scan.clients).toBe(1);
		expect(scan.months).toBe(1);
		expect(scan.warnings).toEqual([]);
	});

	test("node_modules is not a client", () => {
		fixture.addMonth("node_modules", "69-08");
		fixture.addMonth("216", "69-08");
		expect(scanWorkspace(fixture.root).clients).toBe(1);
	});

	test("a file at the client level is not a client, and a file at the month level is not a month", () => {
		fixture.addMonth("216", "69-08");
		fixture.addClientFile("216", "coa.csv", "code,name\n");
		writeFileSync(join(fixture.root, "notes.txt"), "x");
		const scan = scanWorkspace(fixture.root);
		expect(scan.clients).toBe(1);
		expect(scan.months).toBe(1);
		expect(scan.warnings).toEqual([]);
	});
});

describe("the artifact reads the run projection needs", () => {
	beforeEach(() => fixture.addMonth("216", "69-08"));

	test("readCompanyName pulls client_name out of CLIENT.md, or null", async () => {
		expect(await readCompanyName(join(fixture.root, "216"))).toBeNull();
		fixture.addClientFile("216", "CLIENT.md", '---\nclient_name: "บริษัท สองหนึ่งหก จำกัด"\ntax_id: "0105500000000"\n---\n');
		expect(await readCompanyName(join(fixture.root, "216"))).toBe("บริษัท สองหนึ่งหก จำกัด");
	});

	test("readCompanyName is null when the field is absent", async () => {
		fixture.addClientFile("216", "CLIENT.md", "---\ntax_id: \"0105500000000\"\n---\n");
		expect(await readCompanyName(join(fixture.root, "216"))).toBeNull();
	});

	test("readLedgerCounts is null until the final gate wrote them, and null on a broken file", async () => {
		const dir = fixture.monthDir("216", "69-08");
		expect(await readLedgerCounts(dir)).toBeNull();

		fixture.writeLedgerCounts("216", "69-08", { units: 41, reviewed: 33, excluded: 8 });
		expect(await readLedgerCounts(dir)).toEqual({ totalUnits: 41, reviewed: 33, excluded: 8 });

		writeFileSync(join(dir, "ข้อมูลระบบ", "_pages", "ledger.yaml"), "counts: [not: a mapping\n");
		expect(await readLedgerCounts(dir)).toBeNull();
	});

	test("readGroupTotals counts every bucket's groups and every needs_attention page", async () => {
		const dir = fixture.monthDir("216", "69-08");
		expect(await readGroupTotals(dir)).toEqual({ groupCount: 0, attention: 0 });

		fixture.addGroup("216", "69-08", "expense/vat", "g-001", {
			pages: [{ initial_status: "needs_attention" }, { initial_status: "reviewed" }],
		});
		fixture.addGroup("216", "69-08", "income/non_vat", "g-002", { pages: [{ initial_status: "reviewed" }] });
		fixture.addGroup("216", "69-08", "bank_statement", "kbank", { pages: [{ initial_status: "needs_attention" }] });
		expect(await readGroupTotals(dir)).toEqual({ groupCount: 3, attention: 2 });
	});

	test("a group whose review-data.json is unreadable contributes 0 attention rather than failing the read", async () => {
		const dir = fixture.monthDir("216", "69-08");
		fixture.addGroup("216", "69-08", "expense/vat", "g-001", { pages: [{ initial_status: "needs_attention" }] });
		writeFileSync(join(dir, "ข้อมูลระบบ", "_doc_groups", "expense", "vat", "g-001", "review-data.json"), "{ broken");
		expect(await readGroupTotals(dir)).toEqual({ groupCount: 1, attention: 0 });
	});

	test("the `assets` directory is not a group", async () => {
		const dir = fixture.monthDir("216", "69-08");
		fixture.addGroup("216", "69-08", "expense/vat", "assets");
		fixture.addGroup("216", "69-08", "expense/vat", "g-001");
		expect((await readGroupTotals(dir)).groupCount).toBe(1);
	});
});

describe("[C-38] measureRepairImpact", () => {
	beforeEach(() => fixture.addMonth("216", "69-08"));

	test("a month with no groups has nothing to lose", async () => {
		expect(await measureRepairImpact(fixture.monthDir("216", "69-08"))).toEqual({
			destroys: false,
			editedGroups: 0,
			groupCount: 0,
			lastHumanEditAt: null,
		});
	});

	test("a freshly built group is not an edited group", async () => {
		fixture.addGroup("216", "69-08", "expense/vat", "g-001");
		fixture.addGroup("216", "69-08", "expense/vat", "g-002");
		const impact = await measureRepairImpact(fixture.monthDir("216", "69-08"));
		expect(impact).toEqual({ destroys: false, editedGroups: 0, groupCount: 2, lastHumanEditAt: null });
	});

	test("a review-data.json newer than its pristine sidecar is an edited group", async () => {
		fixture.addGroup("216", "69-08", "expense/vat", "g-001");
		fixture.addGroup("216", "69-08", "expense/vat", "g-002", { humanEdited: true });
		fixture.addGroup("216", "69-08", "bank_statement", "kbank", { humanEdited: true });
		const impact = await measureRepairImpact(fixture.monthDir("216", "69-08"));
		expect(impact.destroys).toBe(true);
		expect(impact.editedGroups).toBe(2);
		expect(impact.groupCount).toBe(3);
		expect(impact.lastHumanEditAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test("a group with neither sidecar nor categorize.json is not counted as edited", async () => {
		const dir = join(fixture.monthDir("216", "69-08"), "ข้อมูลระบบ", "_doc_groups", "expense", "vat", "g-001");
		fixture.addGroup("216", "69-08", "expense/vat", "g-001", { humanEdited: true });
		rmSync(join(dir, "review-data.ai.json"), { force: true });
		const impact = await measureRepairImpact(fixture.monthDir("216", "69-08"));
		expect(impact).toMatchObject({ destroys: false, editedGroups: 0, groupCount: 1 });
	});
});
