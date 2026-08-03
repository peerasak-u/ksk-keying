// Env-driven config for the review app (wayfinder ticket #38).
// KSK_WORKSPACE_ROOT keeps its original meaning — many client-company folders
// under one office workspace.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const port = Number(process.env.KSK_APP_PORT) || 4900;

// No auth layer exists, so bind to loopback unless the operator deliberately
// points this at an already-authenticated private interface (a tailnet IP, or
// 0.0.0.0 behind the Cloudflare Access-gated tunnel — see docker-compose.yml).
const host = process.env.KSK_APP_HOST || "127.0.0.1";

// Ticket #31: configurable concurrency, default 1 (de facto global FIFO).
const concurrencyRaw = Number(process.env.KSK_APP_CONCURRENCY);
const concurrency = Number.isFinite(concurrencyRaw) && concurrencyRaw >= 1 ? Math.floor(concurrencyRaw) : 1;

const raw = process.env.KSK_WORKSPACE_ROOT;
if (!raw) {
	console.error("KSK_WORKSPACE_ROOT is required (no default is safe to guess).");
	process.exit(1);
}
const workspaceRoot = resolve(raw);
if (!existsSync(workspaceRoot) || !statSync(workspaceRoot).isDirectory()) {
	console.error(`KSK_WORKSPACE_ROOT "${raw}" is not an existing directory.`);
	process.exit(1);
}

export const config = { port, host, concurrency, workspaceRoot };
export type Config = typeof config;
