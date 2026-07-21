# KSK Console

A local web wrapper around headless Claude Code (`claude -p`) for running and
watching `/ksk-keying` runs from a browser instead of a terminal. Localhost
only, single user, one machine.

## Run it

```bash
bun console/server.ts
```

Defaults to **mock mode** — no `claude` binary is invoked, no API cost, and a
demo workspace (`console/demo-workspace/`) is auto-created so the UI has
something to show. Open `http://127.0.0.1:4820`.

To point it at a real client workspace and the real `claude` binary:

```bash
KSK_ENGINE=claude \
KSK_WORKSPACE_ROOT=/path/to/client/workspace \
bun console/server.ts
```

## Frontend build (Tailwind CSS)

`public/style.src.css` is the Tailwind v4 source (`@import "tailwindcss"`, plus the
app's own hand-written CSS below it); `public/style.css` is the compiled,
self-contained output the server actually serves as a static file — no CDN, no
runtime Tailwind dependency. Never hand-edit `style.css` directly; it's
regenerated output and any manual edit is lost on the next build.

```bash
cd console && bun install   # once, installs the Tailwind CLI as a devDependency
bun run build:css           # public/style.src.css -> public/style.css
```

## The UI: task list and customer page

Mobile-first, two views, navigated by URL hash so the phone/browser back button moves
naturally between them:

- **Task list (`#tasks`, the default)** — a Trello-style 3-lane board: รอคิว (queue) →
  กำลังทำงาน (in progress) → เสร็จสิ้น (done/error/stopped), left to right. All 3 lanes
  stay visible once at least one run has ever existed; an empty lane shows its own "ว่าง"
  hint rather than disappearing. On mobile the board is a horizontal scroll-snap carousel
  (swipe between lanes); at desktop widths (≥760px) it's 3 equal columns side by side. Card
  color is the primary status signal — a soft background tint + left accent border per
  status (queued/running/done/error/stopped), never full-saturation, so the board reads at
  a glance without feeling loud — backed by a small text `.chip` on every card so the
  signal never depends on color alone. Same live-tracking behavior as before underneath: a
  10s poll of `GET /api/runs`, plus an SSE-driven current-sub-agent line on whichever run
  is currently live.
- **Customer page (`#customers`)** — reached via a ☰ button in the task list's header.
  Lists clients from `GET /api/clients` by folder id together with their company name
  (read from each client's `CLIENT.md`, e.g. "216 — บริษัท เจบีคูลเทค จำกัด"; falls back
  to just the folder id when no name is on file), with months nested underneath. Picking a
  month shows a confirm/Run step before anything actually starts — the same one-client
  safety margin as before, just relocated to this page.

There is no free-text input anywhere in the UI.

## Env vars

| var | default | meaning |
|---|---|---|
| `KSK_CONSOLE_PORT` | `4820` | port the server binds on `127.0.0.1` |
| `KSK_ENGINE` | `mock` | `mock` (token-free fake engine) or `claude` (spawns the real `claude` binary — costs money) |
| `KSK_WORKSPACE_ROOT` | mock: auto-created `console/demo-workspace/`; claude: **required**, server exits(1) if unset or not a directory | root folder whose level-1 dirs are treated as clients and level-2 dirs as months |
| `KSK_PERMISSION_MODE` | `acceptEdits` | passed to `claude -p --permission-mode` |
| `KSK_ENGINE_MODEL` | unset (omit `--model`) | passed to `claude -p --model` when set |
| `KSK_MAX_BUDGET_USD` | unset (omit `--max-budget-usd`) | passed to `claude -p --max-budget-usd` on **every** claude-engine spawn (the initial invocation and every watchdog auto-continue) — a **per-invocation** ceiling enforced by the `claude` binary itself, re-applied fresh each time. It does *not* cap the run as a whole: worst-case exposure from this flag alone, across a full watchdog lifetime, is `(KSK_AUTO_CONTINUE_MAX + 1) × KSK_MAX_BUDGET_USD`. |
| `KSK_AUTO_CONTINUE` | `1` (on) | set to `0` to disable the auto-continue watchdog (claude engine only; see below) |
| `KSK_AUTO_CONTINUE_MAX` | `8` | max watchdog auto-continues per run before it gives up and leaves the run `done`. This cap is scoped to one run's own lifetime — from creation to its first terminal settle — and never resets within it; since a finished run's session can't be resumed at all (a later attempt at the same client-month is always a brand new run), this never spans across gates. |
| `KSK_RUN_BUDGET_USD` | `25` | the actual **run-level** spend guard: before each watchdog-triggered auto-continue, if the run's cumulative recorded cost (`costUsdFull ?? costUsd ?? 0`) has already reached this, the watchdog halts (settles `done`, `note: "auto-continue halted: run budget reached"`) instead of resuming. Watchdog-only — it stops the automatic nudging, nothing else; there is no manual-resume path for it to block in the first place, since a finished run's session can't be continued at all — the only way to keep working on that client-month is a brand new run (`POST /api/runs`, or "เริ่มใหม่" in the UI). |

## Headless mode vs. interactive Claude Code

In interactive Claude Code, the `/ksk-keying` orchestrator dispatches subagent waves in
the background, ends its turn, and gets re-invoked when they finish. `claude -p` has no
such re-invocation: the process exits the instant the model ends its turn, which would
kill any subagent wave still running in the background. Two things compensate for that:

1. **Headless directive at spawn.** Every claude-engine invocation (the initial run and
   every watchdog auto-continue) is spawned with `--append-system-prompt` carrying a fixed
   directive telling the model it's headless: dispatch subagent waves synchronously
   (`run_in_background: false`), and never end the turn while work is still in flight —
   only stop when the pipeline is complete or at a human review gate.
2. **Auto-continue watchdog.** If the model still ends its turn mid-work anyway (e.g. it
   forgets, or a wave partially completes), the console needs to be able to notice and
   nudge it forward automatically rather than leaving the run silently `done` while a
   pipeline stage was actually left hanging.

## The auto-continue watchdog

When a claude-engine invocation exits cleanly, the engine looks at the text of the last
`result` event before deciding what `status` to settle on:

- **Gate check first.** If that text looks like a genuine human stop — mentions a Ledger
  Gate, "ตรวจทาน", "อนุมัติ", "รอ(การ)ตรวจ" — the run finishes `done` normally. This is the
  expected, correct way for a run to pause: a human is meant to look at the review page and
  decide what happens next. (Bare English "review"/"approve" are deliberately not matched
  here — see the comment on `GATE_RE` in `engine.ts` for why.)
- **Unfinished check.** Otherwise, if the text looks like the turn ended while work was
  still in flight (mentions waiting, running, a wave, a subagent, a background task,
  dispatch, "กำลัง", "ค้าง") **and** `KSK_AUTO_CONTINUE` is on **and** the run hasn't hit
  `KSK_AUTO_CONTINUE_MAX` resumes yet **and** the run has a `sessionId` **and** the run's
  cumulative recorded cost (`costUsdFull ?? costUsd ?? 0`) hasn't yet reached
  `KSK_RUN_BUDGET_USD` — the engine does *not* settle the run as `done`. Instead it bumps
  `autoResumes`, waits ~3s, then spawns a `--resume <sessionId>` invocation whose prompt is
  a fixed watchdog message: continue any pending waves/stages, but if you're actually at a
  review gate, don't treat this automated message as approval — restate what needs review
  and stop.
- **Run budget reached.** If every other condition above holds except the cost has already
  reached `KSK_RUN_BUDGET_USD`, the watchdog halts instead of resuming: the run settles
  `done` with `note: "auto-continue halted: run budget reached"`. This only stops the
  *automatic* watchdog's own nudging — there is no manual-resume path for it to interfere
  with, since a finished run's Claude session can't be continued at all anymore; the only
  way to keep working on that client-month afterward is a brand new run.
- **Otherwise** the run finishes `done` as normal.

Auto-resume events append to the same run's `.jsonl`/SSE stream just like every other
event on that run — from the browser's perspective a run that auto-continues just keeps
streaming log lines under the same run, with `autoResumes` ticking up. A manual stop
(หยุดชั่วคราว on a running card, ยกเลิก on a queued one) always wins: it cancels a pending
watchdog timer as well as killing an in-flight process. This mechanism only ever runs for
`KSK_ENGINE=claude`; the mock engine always finishes its fake runs `done` and never sets
`autoResumes` above `0`.

`autoResumes` is scoped to one run's own lifetime — from creation to its first terminal
settle — against `KSK_AUTO_CONTINUE_MAX`, and never resets within that lifetime. There is
no way to resume a run past that point at all (no `POST /api/runs/:id/resume` route
exists), so this cap only ever bounds the auto-continues inside a single run's own life;
a later attempt at the same client-month is always a brand new run (started via
"เริ่มใหม่" in the UI, or `POST /api/runs`), which starts with its own fresh `autoResumes`
counter at `0`.

## Queueing

Only one client/month runs at a time, across the whole console — not just per path.
Starting a run while another is already active doesn't reject it: the new run is
created immediately with `status: 'queued'` and takes its place in a FIFO queue, ordered
by when it was requested (`queuedAt`). When the currently active run finishes — however
it finishes, `done`, `error`, `stopped`, or a manual stop — the earliest-queued run
starts automatically, no user action needed. This also applies across a server restart:
the server checks for a queued run to promote on boot, so a populated queue never sits
idle just because nothing happened to be running at the moment of restart. A run can also
be cancelled before it ever gets its turn: `POST /api/runs/:id/stop` on a `queued` run
settles it `stopped` directly — no process exists yet to kill, and cancelling a queued run
never frees an active slot, since it was never occupying one.

## Ledger Gates and starting fresh

`/ksk-keying` pauses at Ledger Gates for human review (segmentation, exclusion
claims, etc.) — the pipeline writes a review HTML page (e.g.
`ตรวจทาน/index.html`) and stops rather than guessing. The console's job is to
make that pause visible from a browser instead of a terminal:

1. **Run** a client-month → the server spawns `claude -p /ksk-keying <path>
   --output-format stream-json`, capturing every event to
   `console/runs/<id>.jsonl` and streaming it live over SSE.
2. When the pipeline reaches a gate, it says so in its assistant text and the
   process exits — the run's `status` settles `done` (gates exit cleanly;
   they aren't errors), with a `sessionId` retained from the run's `init`
   event even though that session can no longer be continued (see below). The
   finished run shows up in the console's ประวัติ (history) section.
3. From there, the reviewer opens the generated review page via that run's
   "ตรวจทาน" button — a direct link (from `GET /api/html?path=…` for that
   run's path) that opens in a new tab, not an embedded iframe — checks it,
   and decides what to do next.
4. A finished run's Claude session ends at the gate for good — there is no
   way to resume it with a follow-up message. To continue work on that
   client-month, the reviewer uses "เริ่มใหม่" (start fresh) on that run's
   card: `POST /api/runs {path}` creates a brand new run for the same path,
   with its own new `id` and its own `sessionId`, appearing in กำลังทำงาน or
   รอคิว depending on whether anything else is currently active. It re-runs
   `/ksk-keying <path>` from scratch — it is not a continuation of the
   previous attempt's session.

"ตรวจทาน" is offered only on a `done` run; "เริ่มใหม่" is offered on any
finished run — `done`, `error`, or `stopped` alike.

## Security & cost notes

- **Localhost-only.** `Bun.serve` binds `127.0.0.1` explicitly, never
  `0.0.0.0` — the console is never reachable from another machine, let alone
  the internet. There is no auth layer because there is no network exposure
  to authenticate against.
- **No secrets, no telemetry.** The server makes zero outbound network calls
  of its own; the only network activity is the `claude` binary's own API
  calls when `KSK_ENGINE=claude`.
- **Permission modes are real.** `KSK_PERMISSION_MODE` is passed straight
  through to `claude -p --permission-mode`; it governs what the spawned
  Claude Code session may do to the filesystem without asking. Choose it as
  carefully here as you would on the command line — the console doesn't
  add its own sandboxing on top.
- **`KSK_MAX_BUDGET_USD` is a per-invocation ceiling, not a per-run one.** It's
  passed to `claude`'s own `--max-budget-usd` flag fresh on *every* spawn —
  the initial invocation and each watchdog auto-continue — so it caps what a
  single invocation can spend, not the run as a whole. Left to the watchdog
  alone, worst-case exposure from this flag across a run's full auto-continue
  lifetime is `(KSK_AUTO_CONTINUE_MAX + 1) × KSK_MAX_BUDGET_USD`. The actual
  run-level guard is **`KSK_RUN_BUDGET_USD`** (default 25): the watchdog checks
  the run's cumulative recorded cost against it before every auto-continue and
  halts (settles `done`) once it's reached — see "The auto-continue watchdog"
  above. Set both when running against the real engine unattended; note that
  `KSK_RUN_BUDGET_USD` only gates the *watchdog*'s own automatic nudging —
  there is no manual-resume path for either setting to interfere with, since a
  finished run's session can't be continued at all (only started fresh).
- **`costUsdFull` is the honest total; `costUsd` alone undercounts.** Each
  `result` event's `total_cost_usd` only covers the parent conversation loop —
  it misses whatever subagent waves cost. `result` events also carry
  `modelUsage: { <model>: { costUSD, ... } }`, which does include subagent-wave
  spend; the engine sums that into `costUsdFull` alongside the existing
  `costUsd` accumulation, and both are tracked on every `RunState` (used by the
  auto-continue watchdog's run-budget check above). The UI itself does not
  currently display either figure.
- **Mock mode is the safe default and the only mode used in development and
  automated testing.** `engine.ts` never invokes the real `claude` binary
  unless `KSK_ENGINE=claude` is explicitly set — there is no code path where
  mock mode accidentally spends money.
- **Path traversal is guarded, not merely discouraged.** `/files/`,
  `/api/html`, and `POST /api/runs` all decode the incoming path, resolve it
  against `workspaceRoot`, and reject (403/400) anything that resolves
  outside it — including URL-encoded `..%2f` forms. Client data is served
  read-only; the console has no route that writes into a client folder.

## Files

```
console/
├── config.ts          # env-driven config
├── engine.ts           # run registry, persistence, real claude -p spawn, watchdog/stop
├── mock-engine.ts      # token-free fake engine, same event shapes
├── server.ts           # Bun.serve: API routes + SSE + /files + static
├── public/             # frontend (owned separately)
├── runs/                # gitignored — run state (*.json) + event log (*.jsonl)
└── demo-workspace/      # gitignored — mock-mode auto-created demo client folder
```
