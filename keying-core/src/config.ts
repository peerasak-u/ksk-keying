// Env-driven config. `KSK_WORKSPACE_ROOT` and `KSK_APP_CONCURRENCY` keep their
// existing meanings (`console/app/config.ts`) because they describe the same
// workspace and the same queue; the `KSK_CORE_*` names are new and belong to
// this service.
//
// Loading throws rather than exiting, so a test can assert a bad value is
// refused. `main.ts` is the one place that turns a throw into an exit.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { assertCenturyBase, DEFAULT_BUDDHIST_CENTURY_BASE } from "./identity/month";

export type CoreConfig = {
	port: number;
	host: string;
	workspaceRoot: string;
	concurrency: number;
	buddhistCenturyBase: number;
	serviceToken: string;
};

export type Env = Record<string, string | undefined>;

/** Plan §9.2 [r3] requires refuse-to-start on a value Core cannot honour, so a
 * variable that is PRESENT but not an integer throws rather than falling back.
 * `Number("")` is a finite 0, which is why a blank value — the shape an unset
 * variable takes in docker-compose and in CI — must be refused explicitly and
 * not merely tested with `Number.isFinite`. An ABSENT variable still takes its
 * documented default. */
function intEnv(name: string, raw: string | undefined, fallback: number): number {
	if (raw === undefined) return fallback;
	if (!/^-?\d+$/.test(raw.trim())) {
		throw new Error(`${name} must be an integer; got ${JSON.stringify(raw)}`);
	}
	return Number(raw.trim());
}

/** A port of 0 means "let the kernel choose", which is a legitimate thing to
 * ask for and a very bad thing to arrive at by accident — so it must be typed
 * out rather than fallen into from a blank variable. */
function portEnv(raw: string | undefined): number {
	const port = intEnv("KSK_CORE_PORT", raw, 4910);
	if (port < 0 || port > 65535) throw new Error(`KSK_CORE_PORT must be within 0..65535; got ${port}`);
	return port;
}

/** Where a non-fatal configuration complaint goes. `main.ts` passes the real
 * logger's `warn`; a test passes a spy. `loadConfig` stays free of a logger
 * dependency and stays synchronous and pure apart from the filesystem check. */
export type ConfigWarn = (event: string, fields: Record<string, unknown>) => void;

export function loadConfig(env: Env = process.env, warn: ConfigWarn = () => {}): CoreConfig {
	const raw = env.KSK_WORKSPACE_ROOT;
	if (!raw) throw new Error("KSK_WORKSPACE_ROOT is required (no default is safe to guess).");
	const workspaceRoot = resolve(raw);
	if (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory()) {
		throw new Error(`KSK_WORKSPACE_ROOT "${raw}" is not an existing directory.`);
	}

	// §1.1: authentication is service-to-service only, and there is exactly one
	// caller identity. A service with no token is a service with no boundary, so
	// this follows KSK_WORKSPACE_ROOT's "no default is safe to guess" rule.
	const serviceToken = env.KSK_CORE_SERVICE_TOKEN;
	if (!serviceToken) throw new Error("KSK_CORE_SERVICE_TOKEN is required (service-to-service auth, plan §9.4).");

	// Plan §9.2 [r3]: Core must REFUSE TO START if this is not a multiple of 100,
	// and must log the resolved window at boot.
	const buddhistCenturyBase = assertCenturyBase(
		intEnv("KSK_BUDDHIST_CENTURY_BASE", env.KSK_BUDDHIST_CENTURY_BASE, DEFAULT_BUDDHIST_CENTURY_BASE),
	);

	// DELIBERATELY lenient, and deliberately NOT `intEnv`: this is byte-parity
	// with `console/app/config.ts:15-16`, which already runs in production with
	// whatever value is set there. Refusing to start on a value an existing
	// deployment has had for months is a behaviour change nobody would see
	// coming, so a bad value still falls back to the floor of 1 — but it is
	// warned about rather than swallowed, so an operator who typoed it is not
	// left believing they configured a parallel pipeline.
	const concurrencyRaw = Number(env.KSK_APP_CONCURRENCY);
	const concurrency = Number.isFinite(concurrencyRaw) && concurrencyRaw >= 1 ? Math.floor(concurrencyRaw) : 1;
	if (env.KSK_APP_CONCURRENCY !== undefined && concurrency !== Number(env.KSK_APP_CONCURRENCY)) {
		warn("config.concurrency_ignored", { value: env.KSK_APP_CONCURRENCY, using: concurrency });
	}

	return {
		// A port of its own, so Core and the legacy console app can run side by
		// side on one host during the migration (plan §15).
		port: portEnv(env.KSK_CORE_PORT),
		// No auth layer beyond the service token, so bind to loopback unless the
		// operator deliberately points this at a private interface — the same
		// judgement `console/app/config.ts:9-12` makes.
		host: env.KSK_CORE_HOST || "127.0.0.1",
		workspaceRoot,
		concurrency,
		buddhistCenturyBase,
		serviceToken,
	};
}
