import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

const base = mkdtempSync(join(tmpdir(), "keying-core-config-"));
const root = join(base, "workspace");
mkdirSync(root, { recursive: true });
writeFileSync(join(base, "a-file"), "x");

afterAll(() => rmSync(base, { recursive: true, force: true }));

const MINIMAL = { KSK_WORKSPACE_ROOT: root, KSK_CORE_SERVICE_TOKEN: "token" };

describe("loadConfig", () => {
	test("defaults everything but the two values that have no safe guess", () => {
		expect(loadConfig(MINIMAL)).toEqual({
			port: 4910,
			host: "127.0.0.1",
			workspaceRoot: root,
			concurrency: 1,
			buddhistCenturyBase: 2500,
			serviceToken: "token",
		});
	});

	test("refuses to start without a workspace root, or with one that is not a directory", () => {
		expect(() => loadConfig({ KSK_CORE_SERVICE_TOKEN: "token" })).toThrow(/KSK_WORKSPACE_ROOT is required/);
		expect(() => loadConfig({ ...MINIMAL, KSK_WORKSPACE_ROOT: join(base, "a-file") })).toThrow(/not an existing directory/);
		expect(() => loadConfig({ ...MINIMAL, KSK_WORKSPACE_ROOT: join(base, "nope") })).toThrow(/not an existing directory/);
	});

	test("refuses to start without a service token — a service with no token has no boundary", () => {
		expect(() => loadConfig({ KSK_WORKSPACE_ROOT: root })).toThrow(/KSK_CORE_SERVICE_TOKEN is required/);
	});

	test("plan §9.2 [r3]: refuses to start on a century base that is not a multiple of 100", () => {
		expect(() => loadConfig({ ...MINIMAL, KSK_BUDDHIST_CENTURY_BASE: "2543" })).toThrow();
		expect(loadConfig({ ...MINIMAL, KSK_BUDDHIST_CENTURY_BASE: "2600" }).buddhistCenturyBase).toBe(2600);
	});

	test("plan §9.2 [r3]: a PRESENT but unparseable integer refuses to boot rather than falling back", () => {
		// Number("") is a finite 0, so a blank variable — the shape an unset value
		// takes in docker-compose and CI — must be refused explicitly. A base of 0
		// would otherwise pass the multiple-of-100 rule and make monthIdToMonthKey
		// produce "69-08", a value MONTH_KEY_PATTERN itself rejects.
		expect(() => loadConfig({ ...MINIMAL, KSK_BUDDHIST_CENTURY_BASE: "" })).toThrow(/must be an integer/);
		expect(() => loadConfig({ ...MINIMAL, KSK_BUDDHIST_CENTURY_BASE: "abc" })).toThrow(/must be an integer/);
		expect(() => loadConfig({ ...MINIMAL, KSK_BUDDHIST_CENTURY_BASE: "0" })).toThrow(/multiple of 100 within/);
		expect(() => loadConfig({ ...MINIMAL, KSK_CORE_PORT: "" })).toThrow(/must be an integer/);
		expect(() => loadConfig({ ...MINIMAL, KSK_CORE_PORT: "4910x" })).toThrow(/must be an integer/);
		expect(() => loadConfig({ ...MINIMAL, KSK_CORE_PORT: "70000" })).toThrow(/within 0\.\.65535/);
	});

	test("KSK_APP_CONCURRENCY keeps its existing meaning and floor of 1", () => {
		expect(loadConfig({ ...MINIMAL, KSK_APP_CONCURRENCY: "3" }).concurrency).toBe(3);
		expect(loadConfig({ ...MINIMAL, KSK_APP_CONCURRENCY: "0" }).concurrency).toBe(1);
		expect(loadConfig({ ...MINIMAL, KSK_APP_CONCURRENCY: "nonsense" }).concurrency).toBe(1);
	});

	test("a present-but-ignored KSK_APP_CONCURRENCY warns instead of silently falling back", () => {
		const warnings: Array<[string, Record<string, unknown>]> = [];
		const warn = (event: string, fields: Record<string, unknown>) => warnings.push([event, fields]);

		loadConfig({ ...MINIMAL, KSK_APP_CONCURRENCY: "four" }, warn);
		expect(warnings).toEqual([["config.concurrency_ignored", { value: "four", using: 1 }]]);

		warnings.length = 0;
		loadConfig({ ...MINIMAL, KSK_APP_CONCURRENCY: "0" }, warn);
		expect(warnings.length).toBe(1);

		// A value that IS honoured, and an ABSENT variable, stay silent — the
		// default is documented, not a mistake.
		warnings.length = 0;
		loadConfig({ ...MINIMAL, KSK_APP_CONCURRENCY: "3" }, warn);
		loadConfig(MINIMAL, warn);
		expect(warnings).toEqual([]);
	});

	test("port and host are overridable", () => {
		const config = loadConfig({ ...MINIMAL, KSK_CORE_PORT: "5000", KSK_CORE_HOST: "0.0.0.0" });
		expect(config.port).toBe(5000);
		expect(config.host).toBe("0.0.0.0");
	});
});
