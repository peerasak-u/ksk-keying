import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveContextFile } from "../paths";

const tmps: string[] = [];
function tempClient(): string {
	const dir = mkdtempSync(join(tmpdir(), "ksk-paths-"));
	tmps.push(dir);
	return dir;
}
afterAll(() => {
	for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

// Context files (CLIENT.md, coa.csv, coa_usage.json) are client-level: a run
// rooted at <client>/<month>/ must find them one level up, while a legacy
// everything-at-client-root layout (and self-contained eval fixtures) must
// keep resolving at the run root itself — and win over the parent.
describe("resolveContextFile", () => {
	test("month-folder run root finds the file at the parent client root", () => {
		const client = tempClient();
		const month = join(client, "04-69");
		mkdirSync(month);
		writeFileSync(join(client, "coa.csv"), "account_code\n");
		expect(resolveContextFile(month, "coa.csv")).toBe(join(client, "coa.csv"));
	});

	test("run root wins over the parent when both exist", () => {
		const client = tempClient();
		const month = join(client, "04-69");
		mkdirSync(month);
		writeFileSync(join(client, "CLIENT.md"), "parent");
		writeFileSync(join(month, "CLIENT.md"), "local");
		expect(resolveContextFile(month, "CLIENT.md")).toBe(join(month, "CLIENT.md"));
	});

	test("returns null when the file exists nowhere", () => {
		const client = tempClient();
		const month = join(client, "04-69");
		mkdirSync(month);
		expect(resolveContextFile(month, "coa_usage.json")).toBeNull();
	});
});
