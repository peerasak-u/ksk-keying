// Env-driven config for the KSK console. Plain object, no side effects besides
// the mock-mode workspaceRoot default (a path string; mock-engine creates it).
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";

const engineMode = (process.env.KSK_ENGINE === "claude" ? "claude" : "mock") as
  | "mock"
  | "claude";

const port = Number(process.env.KSK_CONSOLE_PORT) || 4820;

// Bind target — 127.0.0.1 by default (see server.ts: no auth layer exists because the
// console was never meant to be reachable off-box). Override only to a private,
// already-authenticated interface (e.g. a Tailscale IP), never "0.0.0.0" — this app has
// no login of its own, and every exposed interface can trigger real claude-engine runs.
const host = process.env.KSK_CONSOLE_HOST || "127.0.0.1";

const permissionMode = process.env.KSK_PERMISSION_MODE || "acceptEdits";

const model = process.env.KSK_ENGINE_MODEL || undefined;

const maxBudgetUsd = process.env.KSK_MAX_BUDGET_USD
  ? Number(process.env.KSK_MAX_BUDGET_USD)
  : undefined;

// Auto-continue watchdog (claude engine only — see engine.ts). Default on;
// only the literal string "0" disables it.
const autoContinue = process.env.KSK_AUTO_CONTINUE !== "0";
// `|| 8` would treat an explicit "0" (disable auto-continue entirely) as falsy and
// silently override it back to 8 — parse explicitly so 0 is honored.
const autoContinueMaxRaw = Number(process.env.KSK_AUTO_CONTINUE_MAX);
const autoContinueMax =
  Number.isFinite(autoContinueMaxRaw) && autoContinueMaxRaw >= 0 ? autoContinueMaxRaw : 8;

// Cumulative per-run spend guard for the auto-continue watchdog only (USD). Unlike
// KSK_MAX_BUDGET_USD (a per-invocation ceiling re-applied to every spawn), this is
// checked against the run's running total before each watchdog-triggered resume — see
// maybeAutoContinue in engine.ts. Manual resumes are never blocked by this; it only
// stops the *automatic* nudging.
const runBudgetUsd = Number(process.env.KSK_RUN_BUDGET_USD) || 25;

let workspaceRoot: string;

if (engineMode === "claude") {
  const raw = process.env.KSK_WORKSPACE_ROOT;
  if (!raw) {
    console.error(
      "KSK_WORKSPACE_ROOT is required when KSK_ENGINE=claude (no default is safe to guess).",
    );
    process.exit(1);
  }
  const resolved = resolve(raw);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    console.error(`KSK_WORKSPACE_ROOT "${raw}" is not an existing directory.`);
    process.exit(1);
  }
  workspaceRoot = resolved;
} else {
  workspaceRoot = process.env.KSK_WORKSPACE_ROOT
    ? resolve(process.env.KSK_WORKSPACE_ROOT)
    : resolve(import.meta.dir, "demo-workspace");
}

export const config = {
  port,
  host,
  engineMode,
  workspaceRoot,
  permissionMode,
  model,
  maxBudgetUsd,
  autoContinue,
  autoContinueMax,
  runBudgetUsd,
};

export type Config = typeof config;
