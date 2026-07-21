# Handoff: KSK Console — run queue, Thai UI, mobile-first redesign

**Date:** 2026-07-21
**Status:** Round 1 committed and deployed live. Round 2 (mobile-first redesign) built,
Opus-reviewed, and manually browser-verified this session — **not yet committed, not yet
deployed.**
**Goal:** A local web console (`console/`) wrapping headless `claude -p` so `/ksk-keying`
runs can be launched, watched, and reviewed from a phone or browser instead of a terminal.

## Background

Built from scratch this session in worktree `web-console` (branch `worktree-web-console`),
on top of the architecture in `console/SPEC.md` / `console/README.md` — read those first,
they are kept truthful and are the actual spec, not duplicated here. Two rounds of work
happened, both via an Agent Team (`Workflow` tool: parallel Sonnet builders + one Opus
review pass), following the project's model-tier policy in the root `CLAUDE.md`.

**Round 1 — run queue + Thai UI.** Global one-run-at-a-time FIFO queue (`RunStatus` gained
`"queued"`; `RunState.queuedAt`/`startedAt` semantics), a fully Thai mobile-aware-ish UI,
live current-sub-agent tracking sourced from the pipeline's own `Agent` tool_use blocks, and
review pages that open as real links instead of an iframe. **Committed** as `197e273
feat(console): add local web console for /ksk-keying runs`. A follow-up WebKit/Safari
layout bug (stacked mobile sections overlapping — a `min-height:0` + `overflow:auto` +
fixed-viewport-height interaction) was diagnosed and fixed directly in `style.css`, verified
live in-browser at iPhone width — but that fix was never separately committed; it's been
superseded by round 2's full CSS rebuild (see below), so there's nothing to recover there.

**Round 2 — mobile-first redesign.** Built this session per the product owner's explicit
brief (design mobile-first, not desktop-with-a-breakpoint), refined over several rounds of
clarifying questions before implementation. **Currently uncommitted** — `git status --
console/` shows `README.md`, `SPEC.md`, `engine.ts`, `server.ts`, `public/app.js`,
`public/index.html`, `public/style.css` modified, plus a new untracked
`public/style.src.css`.

## What round 2 actually changed

- **Two-view navigation, no router dependency:** URL hash drives visibility — `''`/`#tasks`
  is the task list (default), `#customers` is a new client/company picker page. A single
  header button toggles between ☰ (open customers) and ‹ (back to tasks), so the phone/
  browser back button works naturally.
- **Company names:** `GET /api/clients` now includes `companyName: string | null` per
  client, read from that client folder's `CLIENT.md` frontmatter (`client_name` field, regex-
  extracted, no YAML dependency — see `readCompanyName()` in `server.ts`). Falls back to
  just the folder id when `CLIENT.md` is missing/unparseable.
- **Four-state button matrix on task cards** (the core of the redesign):
  - running → **หยุดชั่วคราว** alone → `POST /api/runs/:id/stop`
  - queued → **ยกเลิก** alone → same endpoint, now widened to cancel a queued run in place
    (no process to kill, straight to `"stopped"`) instead of only stopping a running one
  - done (status exactly `"done"`) → **เริ่มใหม่** + **ตรวจทาน** + **เรียนรู้** (disabled)
  - error / stopped → **เริ่มใหม่** alone
  - Buttons stack vertically full-width on mobile, sit equal-width side by side on desktop.
- **Resume is gone entirely.** `POST /api/runs/:id/resume` and `resumeRun()` are deleted, not
  just hidden — there is no free-text input anywhere in the UI anymore. A finished run's only
  path forward is **เริ่มใหม่**, which just re-POSTs `/api/runs` for the same path (a brand
  new run, reusing the existing create-run/queue flow — no new backend concept).
- **เรียนรู้ is a placeholder only** — rendered disabled, no handler, no backend. It exists so
  the three-button layout is already correct once the real feature lands. **That real
  feature is the Change_Log worksheet work already scoped in
  [`docs/handoffs/2026-07-05-change-log-worksheet.md`](./2026-07-05-change-log-worksheet.md)**
  (record agent-proposed vs human-corrected values as an extra sheet in the exported PEAK
  xlsx, then optionally feed corrections back into `coa_usage.json`). That handoff was
  written independently of this session's console work but is the natural next step behind
  this button — read it before building เรียนรู้ for real.
- **Tailwind, precompiled.** `console/public/style.src.css` is the Tailwind v4 source
  (`@import "tailwindcss"`); `console/public/style.css` is the compiled, self-contained
  output (no CDN, no runtime dependency — `Bun.serve` still just serves it as a static file).
  No exact regenerate command is documented in the repo yet (the building agent used a
  throwaway `bun add -d tailwindcss @tailwindcss/cli` + CLI invocation in a scratch dir, not
  committed) — worth pinning down a real reproducible command before this drifts.

## Verification performed this session

- Opus review pass (via the Agent Team): verdict `ready`, two minor/cosmetic findings only
  (empty "กำลังทำงาน" header when nothing is running; ตรวจทาน button legitimately absent
  until its lazy `GET /api/html` fetch resolves or if a run genuinely produced no HTML) —
  neither is a real defect.
- Manual follow-up in a real browser (`agent-browser` skill, iPhone 14 viewport + 1400×900
  desktop), against a disposable mock-engine instance on a scratch port — **not** the live
  server: confirmed company-name display and its null-fallback, hamburger/back navigation,
  confirm-before-run safety step, the full button matrix per status, and vertical-mobile /
  equal-width-desktop button layout. Screenshots were not kept (scratchpad, cleaned up).
- Not verified: dark-mode rendering (if any), tablet-width breakpoint behavior, and the
  exact Tailwind regenerate command (see above).

## Live deployment state — read before touching the running server

- The **real console server is running on port 4820** (`KSK_ENGINE=claude`, real
  `samples/clients` workspace, real money) and is still serving **round-1 code** — round 2 is
  not deployed. Static files (`index.html`/`app.js`/`style.css`) are re-read from disk per
  request with no caching (see `serveStatic` in `server.ts`), so *those* would go live
  instantly with no restart; but round 2 also changed `engine.ts`/`server.ts` (widened
  `/stop`, removed `/resume`, added `companyName`), which **do** require a process restart
  to take effect, since Bun doesn't hot-reload.
- **As of this writing, a real run (`216/เดือนเมษายน`) is `status: "running"`** on that live
  server — do not restart it while that's true. Check `curl -s
  http://127.0.0.1:4820/api/runs` before restarting; only restart when nothing is `running`
  or `queued`. This has been the standing rule all session (the product owner explicitly
  asked to wait once already).
- `console/runs/` holds real production run history (event logs against the paid engine,
  megabytes of jsonl). It is a **hardcoded path** in `engine.ts` (not configurable per port/
  workspace), so *any* local test server — even a throwaway mock instance on a different
  port — writes into this same directory. Never read/edit/delete pre-existing files there;
  clean up only the exact new run-id files a test session itself created. This directory was
  wiped by accident once before this session (unrelated cleanup task) — treat it carefully.
- Tailnet exposure already configured from earlier in the session: `tailscale serve` maps
  `https://alfred.taile9d591.ts.net:10000` → `127.0.0.1:4820`. Port 443 belongs to the
  `collie` herdr plugin (never touch it); port 8443 is an unrelated occupied service.

## Suggested next steps

1. Review the round-2 diff (`git diff -- console/`), then `/commit` it (repo convention:
   Conventional Commits, scoped e.g. `feat(console): ...` — see `git log` for style; the
   `commit` skill documents the house rules).
2. When no run is active on port 4820: restart it with the same real-engine env vars used
   earlier this session (`KSK_ENGINE=claude`, `KSK_WORKSPACE_ROOT=.../samples/clients`,
   `KSK_ENGINE_MODEL=opus`, `KSK_PERMISSION_MODE=bypassPermissions`,
   `KSK_MAX_BUDGET_USD=15`, `KSK_RUN_BUDGET_USD=25`) to deploy round 2 live.
3. Pin down and document the real Tailwind regenerate command (see above) so
   `style.src.css` → `style.css` isn't a one-off, unreproducible artifact.
4. When ready to build เรียนรู้ for real, start from
   `docs/handoffs/2026-07-05-change-log-worksheet.md`, not from scratch.

## Suggested skills

- `commit` — read before committing the round-2 diff.
- `agent-browser` — for any further visual verification; use
  `--executable-path /usr/bin/chromium` (no system Chrome installed) and never click a
  run-starting button against the real engine (port 4820) — always test against a
  disposable mock instance on a scratch port instead.
- `ksk-keying` — background on the pipeline this console wraps, useful context for anyone
  unfamiliar with `/ksk-keying`, Ledger Gates, or the subagent roster (Watson, Marple,
  Sherlock, Poirot, Lestrade, …) referenced in the console's live sub-agent tracking.
