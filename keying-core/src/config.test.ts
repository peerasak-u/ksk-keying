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

	test("KSK_APP_CONCURRENCY keeps its existing meaning and floor of 1", () => {
		expect(loadConfig({ ...MINIMAL, KSK_APP_CONCURRENCY: "3" }).concurrency).toBe(3);
		expect(loadConfig({ ...MINIMAL, KSK_APP_CONCURRENCY: "0" }).concurrency).toBe(1);
		expect(loadConfig({ ...MINIMAL, KSK_APP_CONCURRENCY: "nonsense" }).concurrency).toBe(1);
	});

	test("port and host are overridable", () => {
		const config = loadConfig({ ...MINIMAL, KSK_CORE_PORT: "5000", KSK_CORE_HOST: "0.0.0.0" });
		expect(config.port).toBe(5000);
		expect(config.host).toBe("0.0.0.0");
	});
});
