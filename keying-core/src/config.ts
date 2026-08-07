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

function intOr(raw: string | undefined, fallback: number): number {
	const value = Number(raw);
	return Number.isFinite(value) ? Math.floor(value) : fallback;
}

export function loadConfig(env: Env = process.env): CoreConfig {
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
	const buddhistCenturyBase = assertCenturyBase(intOr(env.KSK_BUDDHIST_CENTURY_BASE, DEFAULT_BUDDHIST_CENTURY_BASE));

	const concurrencyRaw = Number(env.KSK_APP_CONCURRENCY);
	const concurrency = Number.isFinite(concurrencyRaw) && concurrencyRaw >= 1 ? Math.floor(concurrencyRaw) : 1;

	return {
		// A port of its own, so Core and the legacy console app can run side by
		// side on one host during the migration (plan §15).
		port: intOr(env.KSK_CORE_PORT, 4910),
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
