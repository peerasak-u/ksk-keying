# KSK Console — Stage 1 Specification

A local web UI that wraps **headless Claude Code** (`claude -p`) so `/ksk-keying` runs can
be launched, watched live, and reviewed (the pipeline's generated HTML) from a browser
instead of a terminal. There is no resume-with-a-message feature: once a run settles into
a terminal status, the only way to continue work on that client-month is a brand new run
for the same path.

**Stage 1 scope:** localhost only, single user, one machine. No auth, no HTTPS, no
multi-user. A real global FIFO queue exists: at most one run is active across ALL
client/month paths at a time, additional requests queue and auto-start in order as the
active run finishes.

## Stack

- **Server:** Bun + TypeScript, zero npm dependencies (use `Bun.serve`, `Bun.spawn`,
  `node:fs/promises`, `node:path` only). No build step: `Bun.serve` runs directly against
  the TypeScript source and serves every request straight from it.
- **Frontend, at serve time:** vanilla HTML/JS served statically from `console/public/`,
  plus a plain, already-compiled CSS file (`console/public/style.css`). No framework, no
  bundler, no CDN script — `Bun.serve` hands these files back exactly as they sit on disk,
  the same as any other static asset, with one deliberate exception: `index.html`'s Google
  Fonts `<link>` tags (`fonts.googleapis.com` / `fonts.gstatic.com`) mirror the pipeline's
  `review-template.ts` exactly, for visual consistency with the generated review pages the
  console links out to, and degrade gracefully offline (falls back to the system
  font stack). This was a deliberate product decision — do not remove these links.
- **Frontend CSS, at development time only:** `console/public/style.css` is authored with
  Tailwind and compiled **once, locally, ahead of time** — not on every server boot and
  not on every request. The Tailwind source is `console/public/style.src.css` (Tailwind
  v4's CSS-first entry point, `@import "tailwindcss";`, followed by the same custom
  properties and component-level rules the plain CSS always had), committed to the repo
  alongside the served CSS; a Tailwind CLI compile (run by hand whenever a class changes,
  not wired into `bun console/server.ts` or any other runtime path) turns that source into
  the plain, already-expanded `style.css` that actually ships (currently built with
  Tailwind v4.3.3 — see the `/*! tailwindcss v… */` banner at the top of the compiled
  file). The distinction that matters: **zero** build step when the app runs or serves a
  request — it just hands back the already-compiled `style.css` like any other static file
  — versus a **one-time, local, development-time** compile step whenever the CSS itself
  needs to change.

## File layout (all under `console/`)

```
console/
├── SPEC.md            # this file
├── README.md          # how to run, env vars, security & cost notes
├── config.ts          # env-driven config, exported as a plain object
├── engine.ts          # run registry + claude -p spawn + stream-json capture + watchdog
├── mock-engine.ts     # token-free fake engine emitting the same event shapes
├── server.ts          # Bun.serve: API routes + static + SSE + /files
├── public/
│   ├── index.html
│   ├── app.js
│   ├── style.css      # compiled, served output — do not hand-edit
│   └── style.src.css  # Tailwind source, compiled into style.css at dev time (see Stack)
├── runs/              # runtime state, gitignored, mkdir'd on boot
└── demo-workspace/    # runtime demo data, gitignored (mock mode only)
```

Add to the repo root `.gitignore`: `console/runs/` and `console/demo-workspace/`.

## Config (`config.ts`)

All from env, with defaults:

| key | env | default |
|---|---|---|
| `port` | `KSK_CONSOLE_PORT` | `4820` |
| `engineMode` | `KSK_ENGINE` | `mock` (`mock` \| `claude`) |
| `workspaceRoot` | `KSK_WORKSPACE_ROOT` | mock: auto-create `console/demo-workspace/`; claude: **required**, exit(1) with a clear message if unset or not a directory |
| `permissionMode` | `KSK_PERMISSION_MODE` | `acceptEdits` |
| `model` | `KSK_ENGINE_MODEL` | unset (omit `--model`) |
| `maxBudgetUsd` | `KSK_MAX_BUDGET_USD` | unset (omit `--max-budget-usd`) — **per-invocation** ceiling, re-applied to every spawn (initial, watchdog auto-continue); not a run-level cap (see below) |
| `autoContinue` | `KSK_AUTO_CONTINUE` | `true` (`'0'` disables) |
| `autoContinueMax` | `KSK_AUTO_CONTINUE_MAX` | `8` — cap on `autoResumes` scoped to one run's own lifetime (creation to first terminal settle); never resets within it. There is no way to resume a run's session past a terminal settle at all, so this never spans gates. |
| `runBudgetUsd` | `KSK_RUN_BUDGET_USD` | `25` — cumulative per-run spend guard, watchdog-only (see "Auto-continue watchdog" below) — halts only the watchdog's own automatic nudging; there is no manual-resume path for it to restrict |

Server binds `127.0.0.1` only — never `0.0.0.0`.

## Engine (`engine.ts`)

### Run state

```ts
type RunState = {
  id: string            // "r" + base36 timestamp + 4 random chars
  path: string          // POSIX rel path of target folder under workspaceRoot
  prompt: string
  status: 'queued' | 'running' | 'done' | 'error' | 'stopped'
  sessionId: string | null
  queuedAt: string       // ISO, set once at creation, always present — list ordering
                          // (newest first) and "queued at HH:MM" display while queued
  startedAt: string | null  // ISO timestamp of the queued -> running transition; null
                             // while status === 'queued'. Equals queuedAt when a run
                             // starts immediately (nothing else active).
  endedAt: string | null
  costUsd: number | null  // summed across the initial run + all resumes (parent loop only)
  costUsdFull: number | null  // costUsd + summed modelUsage[*].costUSD (subagent waves included)
  numEvents: number
  engine: 'claude' | 'mock'
  autoResumes: number   // count of watchdog-triggered auto-continues, default 0
  note?: string         // e.g. orphan explanation, or watchdog run-budget halt reason
}
```

Older persisted run JSON may lack `costUsdFull`/`autoResumes`; `boot()` backfills
`costUsdFull: null` and `autoResumes: 0` on load.

**Global queue.** At most one `RunState` may have `status === 'running'` at any moment,
across *all* client/month paths — not just duplicate requests for the same path. A `POST
/api/runs` for a new path made while a different run is already `running` creates the run
immediately with `status: 'queued'` (no engine spawned yet) rather than being rejected.
When the active run reaches a terminal state (`done`/`error`/`stopped`, including via a
manual stop), the earliest-queued run (lowest `queuedAt`) automatically transitions to
`running` and starts, with no user action required — this also runs on server boot, so a
restart never leaves a populated queue stuck idle when nothing is actually running. A
queued run can also be cancelled directly, before it ever starts — see `POST
/api/runs/:id/stop` in the HTTP API table below.

Persistence: `console/runs/<id>.json` (state, rewritten on every change) and
`console/runs/<id>.jsonl` (every event, one JSON per line, append-only — resumes append
to the same file). On boot, load all `*.json`; any run still marked `running` becomes
`error` with `note: "orphaned by server restart"`.

### Spawning (engineMode = claude)

```
claude -p <prompt> \
  --append-system-prompt <HEADLESS_DIRECTIVE> \
  --output-format stream-json --verbose \
  --permission-mode <permissionMode> \
  [--model <model>] [--max-budget-usd <maxBudgetUsd>] \
  [--resume <sessionId>]          # watchdog auto-continue only — the internal mechanism
                                    # that keeps one run's own Claude session going across
                                    # multiple headless turns; unrelated to (and all that
                                    # remains of) the removed user-facing resume feature
```

`HEADLESS_DIRECTIVE` is a fixed constant (see "Auto-continue watchdog" below) telling the
model this process exits at end-of-turn, so subagent waves must be dispatched
synchronously and the turn must not end until the pipeline is done or at a human review
gate. Always present on claude-engine spawns, including watchdog auto-continues.

- `cwd` = `workspaceRoot`, stdin ignored/closed.
- Every claude-engine spawn (initial, watchdog auto-continue) clears any
  in-memory `result` text left over from a prior turn on that run **before** launching the
  process, so an invocation that exits code 0 without emitting its own `result` event reads
  empty (→ settles `done`) rather than being judged against the previous turn's text.
- stdout: line-buffered; each non-empty line is parsed as JSON **defensively** (a
  non-JSON line becomes `{type:'raw', text}`). Every event is appended to the jsonl,
  `numEvents` incremented, and broadcast to SSE subscribers.
- stderr: captured per line as `{type:'stderr', text}` events (persisted + broadcast).
- From the first event bearing `session_id`, store it on the run.
- From each `{type:'result'}` event: add `total_cost_usd` (if numeric **and finite**) to
  `costUsd`; add the sum of `modelUsage[*].costUSD` (if present, defensively) to
  `costUsdFull`; and keep the event's `result` text in memory (per run) for the
  auto-continue watchdog to inspect.
- Process exit, claude engine: nonzero → `error` (unless already `stopped`); code 0 →
  the auto-continue watchdog decides (below) whether to settle `done` or resume.
- Process exit, mock engine: code 0 → `done`; nonzero → `error` (unless already
  `stopped`) — unaffected by the watchdog, which never runs for mock.
- `stopRun(id)` → branches on the run's current status: `running` SIGTERMs the child,
  cancels any pending watchdog timer, settles `stopped`, then calls
  `maybeStartNextQueued()` to free the active slot for whatever's next in the queue;
  `queued` has no process to kill yet, so it settles `stopped` directly, with no
  `maybeStartNextQueued()` call (a queued run never occupied the active slot). Any other
  status is rejected `409` — see the HTTP API table. There is no way to resume a stopped
  run's Claude session — the only way to continue work on that client-month afterward is a
  brand new run via `POST /api/runs`.

### Auto-continue watchdog (claude engine only)

`claude -p` exits the process the moment the model ends its turn — unlike interactive
Claude Code, there is no re-invocation when a backgrounded subagent wave finishes. Two
mechanisms compensate:

1. Every claude-engine spawn carries `--append-system-prompt HEADLESS_DIRECTIVE` (see
   above) telling the model to dispatch waves synchronously and not end its turn early.
2. If the model still ends its turn mid-work, the engine notices and nudges it forward:
   on a clean (code 0) claude-engine exit, look at the last `result` event's text —
   - **Gate check:** matches `/ledger\s*gate|ตรวจทาน|อนุมัติ|รอ(การ)?ตรวจ/i` → genuine human
     stop; settle `done`, no auto-continue. (Bare English "review"/"approve" are
     deliberately excluded — a false-positive gate match here would silently settle `done`
     mid-work, which is the unsafe direction; a false negative just costs a redundant,
     self-correcting watchdog ping, since `WATCHDOG_MESSAGE` forbids treating it as
     approval and the model's restated gate text matches on the next pass.)
   - **Unfinished check:** else matches
     `/wait|in.?flight|running|wave|subagent|background|task|dispatch|กำลัง|ค้าง/i` **and**
     `config.autoContinue` **and** `run.autoResumes < config.autoContinueMax` **and**
     `run.sessionId` is set → candidate for auto-continue, subject to the run-budget check
     below.
   - **Run budget check:** if the run is a candidate for auto-continue per the previous
     step, but `(run.costUsdFull ?? run.costUsd ?? 0) >= config.runBudgetUsd` — halt
     instead of resuming: settle `done` with `run.note = "auto-continue halted: run budget
     reached"` (persisted + broadcast). This guards cumulative *run* spend, in contrast to
     `maxBudgetUsd`, which only ceilings each individual invocation (see config table
     above). This halt only stops the watchdog's own automatic nudging — there is no
     manual-resume path for it to interfere with in the first place, since resuming a
     run's session isn't possible at all anymore; the only way to continue work on that
     client-month, halted or not, is a brand new run (see `POST /api/runs`).
   - **Otherwise** (candidate, and under budget): do *not* settle `done`. Increment
     `autoResumes`, persist + broadcast state (status stays `running` throughout — no
     visible `done` flicker), then after ~3s spawn `--resume <sessionId>` with a fixed
     watchdog prompt (`WATCHDOG_MESSAGE`, which explicitly tells the model not to treat the
     automated nudge as gate approval).
   - **Otherwise** (not a candidate at all): settle `done` normally.
3. Auto-resume events append to the same run's `.jsonl`/SSE stream just like every other
   event on that run. A manual `stopRun()` (the UI's หยุดชั่วคราว/ยกเลิก button) cancels a
   pending watchdog timer as well as killing an in-flight process.
4. `run.autoResumes` vs. `config.autoContinueMax` is a comparison scoped to that one
   `RunState`'s lifetime — from creation to its first terminal settle — and never resets
   within it. Because there is no way to resume a run's session past that point (no
   `POST /api/runs/:id/resume` route exists), this cap only ever bounds the auto-continues
   inside a single run's own life: a later attempt at the same client-month is always a
   brand new run (`POST /api/runs`), which starts with its own fresh `RunState` and
   `autoResumes: 0`.

Known stream-json shapes (parse defensively; never crash on unknown types):

- `{"type":"system","subtype":"init","session_id":"…","model":"…",…}`
- `{"type":"assistant","message":{"content":[{"type":"text","text":"…"}|{"type":"tool_use","name":"…",…}]},…}`
- `{"type":"user","message":{…tool results…},…}`
- `{"type":"result","subtype":"success"|…,"result":"…","total_cost_usd":0.42,"num_turns":…,…}`

### Mock engine (`mock-engine.ts`, engineMode = mock — the default)

Emits the same event shapes through the same registry/persistence/SSE path, with zero
API cost: an `init` event (session_id `"mock-" + runId`), ~6 spaced-out (300–800 ms)
`assistant` events whose text mentions stage progress (e.g. "Stage 1 Segment — เริ่ม
สแกนโฟลเดอร์…", a `tool_use` block or two, "Ledger Gate: รอการตรวจทาน — เปิด
ตรวจทาน/index.html"), then a `result` event with a small fake `total_cost_usd`
(e.g. 0.0123). Implemented with timers in-process; `stop()` cancels them. (`spawnMock`
still accepts a `resumeSessionId` parameter and has a shorter internal branch for it, kept
only because the watchdog auto-continue mechanism reuses the same spawn function
signature as the claude engine — it is never reached in mock mode today, since the
watchdog only ever runs for `engineMode === 'claude'`.)

Demo workspace (only when mock + no `KSK_WORKSPACE_ROOT`): create
`console/demo-workspace/บจ.ตัวอย่าง จำกัด/มิ.ย. 2569/` containing two placeholder files
(`ใบกำกับภาษี_001.pdf` — any small text content is fine) and
`ตรวจทาน/index.html` (a tiny valid Thai HTML page) so the review link is demoable.

## HTTP API (`server.ts`)

All JSON responses `content-type: application/json; charset=utf-8`. All `path` values
are POSIX-style, relative to `workspaceRoot`, URL-encoded in query strings (Thai names
must round-trip).

| method & route | behavior |
|---|---|
| `GET /api/config` | `{workspaceRoot, engineMode, permissionMode, model, port}` |
| `GET /api/clients` | `{clients:[{name, companyName, path, months:[{name, path}]}]}` — level-1 dirs of workspaceRoot are clients, their level-2 dirs are months. `companyName` is `string \| null`: read from that client folder's `CLIENT.md` (one level above the month folders), matched against the `client_name: "…"` line inside its YAML frontmatter block with a small regex — no YAML parsing dependency, since only this one field is needed. `null` if `CLIENT.md` is missing or the field can't be found/parsed; the frontend must handle that gracefully (folder id alone, no placeholder text). Skip entries starting with `.` and `node_modules`. Sorted with `localeCompare(…, 'th')`. |
| `POST /api/runs` body `{path, prompt?}` | Validate `path` is an existing dir under root (traversal-checked) → `400` otherwise. `409` if a `running` **or** `queued` run has the same `path` (duplicate check now covers both). Default prompt: `/ksk-keying <path>`. If some other run is currently `running`, the new run is created with `status: 'queued'` and the engine is **not** started; otherwise it starts immediately. Either way → `201 {run}`. Also the mechanism behind "เริ่มใหม่" (start fresh) on a finished run in the UI: the same route, called again with just `{path}`, creates a brand new `RunState` for that path — there is no dedicated restart endpoint. |
| `GET /api/runs` | `{runs:[RunState]}` newest first |
| `GET /api/runs/:id` | `{run}` or `404` |
| `GET /api/runs/:id/events` | SSE (below) |
| `POST /api/runs/:id/stop` | Widened to also cancel a queued run, not just stop a running one — this single route branches on the run's current status: `running` → SIGTERM the process, cancel any pending watchdog timer, → `stopped`, `endedAt` set, persist, broadcast, then `maybeStartNextQueued()`, `200 {run}`. `queued` → no process exists yet, so just → `stopped` directly (`endedAt` set, persist, broadcast, no `maybeStartNextQueued()` call — a queued run never held the active slot), `200 {run}`. Any other status (already `done`/`error`/`stopped`) → unchanged, `409` with the existing Thai "งานนี้ไม่ได้กำลังทำงานอยู่" message. **`POST /api/runs/:id/resume` has been removed entirely** — there is no route, no `resumeRun` function, and no way to continue a finished run's Claude session with a follow-up message anywhere in this system; the only path forward for a finished run is a brand new run via `POST /api/runs`. |
| `GET /files/<rel…>` | Serve a file under workspaceRoot **read-only**. Decode, resolve, and require the resolved path to stay under workspaceRoot → else `403`. Content-type by extension (html/css/js/json/txt with `charset=utf-8`, png/jpg/pdf binary, else `application/octet-stream`). |
| `GET /`, `/app.js`, `/style.css` | static from `console/public/` |

### SSE contract

`GET /api/runs/:id/events`:
1. On connect, replay the full `.jsonl` — each stored line sent as a `data:` message.
2. Then stream live events as they arrive.
3. On every status change, send `event: state\ndata: <RunState JSON>`.
4. Comment heartbeat (`: ping`) every 15 s; clean up subscriber on disconnect.

## Frontend (`public/`)

Thai-language UI, **mobile-first**: designed and built for a phone screen as the primary
target, with desktop simply a wider rendering of the same single navigation model — there
is no separate desktop-only interaction model (e.g. no persistent sidebar that only
appears above some breakpoint). No framework and no client-side router: the two views are
plain JS show/hide, keyed off the URL hash, so the browser/phone back button moves
naturally between them.

Two views:

- **Task list (`#tasks`, the default — an empty hash also lands here).** The main page,
  laid out as a Trello-style 3-lane board driven off `GET /api/runs`, left to right:
  - **รอคิว (queue)** — runs with `status === 'queued'`, ordered by `queuedAt`.
  - **กำลังทำงาน (progress)** — the single run currently `status === 'running'`, if any.
    While it's live, this card also shows a current-sub-agent line: sourced from `Agent`
    tool_use blocks in the SSE stream (`subagent_type` + `description`, "ksk-" prefix
    stripped, first letter capitalized), updated as new events arrive. This indicator
    only applies to the one live running card.
  - **เสร็จสิ้น (end)** — finished runs (`done`/`error`/`stopped`), newest first.
  All 3 lanes stay visible once at least one run has ever existed (the page-level "ยังไม่มี
  การรัน" empty state only applies before that); a lane with zero cards shows its own "ว่าง"
  hint in place rather than the lane disappearing, matching a real Trello board's empty
  column. On mobile the board is a horizontal scroll-snap carousel — one lane per
  screen-width swipe; at desktop widths (≥760px, the same breakpoint the per-card action
  buttons already used) it becomes 3 equal-width columns side by side, with the page
  scrolling normally (no independent per-lane scroll region).
  Every card's status is shown two ways: a background tint + left accent border in a soft,
  non-saturated color per status (queued/running/done/error/stopped each get a distinct
  hue) as the primary at-a-glance signal, plus a small text `.chip` (reusing the same
  status label) as the color-blind-safe secondary signal — the color is never the only
  carrier of the status.
  The 10s poll of `GET /api/runs` and the SSE subscription to whichever run is currently
  `running` are unchanged — this redesign changes structure, navigation, styling, and
  per-card buttons, not that underlying live-tracking behavior.
  Each card's action buttons depend on the run's status:
  - **running** → one button, "หยุดชั่วคราว" → `POST /api/runs/:id/stop`.
  - **queued** → one button, "ยกเลิก" → the same `POST /api/runs/:id/stop`, now widened to
    cancel a queued run in place (see the HTTP API table).
  - **done** (status exactly `"done"`, not `error`/`stopped`) → three buttons:
    "เริ่มใหม่" (`POST /api/runs` with `{path: <that run's path>}`, no `prompt` — a brand
    new run for the same client/month), "ตรวจทาน" (opens `<run.path>/ตรวจทาน/index.html`
    directly via `/files/…` in a new tab — no discovery fetch, no file list; the pipeline
    always writes that one gate page), and "เรียนรู้" (a disabled, visibly greyed-out
    placeholder for a future feature — no click handler, no backend behind it).
  - **error or stopped** → one button, "เริ่มใหม่" alone (same behavior as the done card's
    เริ่มใหม่ button) — no ตรวจทาน or เรียนรู้ on these.
  Any action that changes run state (เริ่มใหม่, หยุดชั่วคราว, ยกเลิก) updates the visible
  list immediately from the response's returned run object, rather than waiting up to 10s
  for the next poll.
  Button layout inside a card's action area: buttons stack vertically and are full width
  on mobile; at desktop widths they sit side by side, each taking equal width (not
  left-aligned/shrink-to-content) — a one-button card is full-width either way, a
  three-button (done) card is three equal columns on desktop and three full-width stacked
  rows on mobile.
- **Customer page (`#customers`)**, reached via a hamburger (☰) button in the task list's
  header. Lists clients exactly as `GET /api/clients` returns them (already sorted): each
  client shown as its folder id together with its company name (e.g. "216 — บริษัท…"),
  falling back to just the folder id when `companyName` is `null`; months nested
  underneath, the same expandable tree grouping as before. Selecting a month does not
  immediately start a run — it shows a confirm/Run affordance first, the same one-run
  safety margin that existed before via a separate Run button — and this page keeps the
  "รันได้ทีละ 1 ลูกค้าเท่านั้น" helper copy. On a successful `POST /api/runs`, the app
  navigates back to `#tasks` so the new task is immediately visible.
  The header reflects which view is showing: the ☰ button on the task list, a way back to
  the task list (e.g. a back arrow or "‹ กลับ") on the customer page instead.

There is **no free-text input anywhere** in this UI — the old resume textarea and its
submit button are gone entirely, along with the resume feature itself (see the HTTP API
table: `POST /api/runs/:id/resume` no longer exists).

Review pages are still not embedded in an iframe — ตรวจทาน always opens a real link
(`<run.path>/ตรวจทาน/index.html`) directly in a new tab, no discovery fetch. Everything
server- or pipeline-derived is still rendered via `textContent` only (never `innerHTML`),
and all URL building for `/files/` and `POST /api/runs` still goes through the same
path-traversal-safe `encodeRelPath`/`joinRel` helpers.

## Hard constraints

- **Never** invoke the real `claude` binary unless `engineMode === 'claude'`. All
  development and all automated testing use mock mode — a real invocation spends money.
- No secrets, no telemetry, no external network calls anywhere.
- Path traversal must be impossible via `/files/` or `POST /api/runs` (including
  URL-encoded `..%2f` forms — decode first, then resolve + prefix-check).

## Acceptance (what validation must actually exercise)

1. `KSK_ENGINE=mock KSK_CONSOLE_PORT=4821 bun console/server.ts` boots; `GET /` serves
   the UI; `/api/config` and `/api/clients` return sane JSON (demo workspace listed).
2. `POST /api/runs` starts a mock run; SSE delivers init → assistant… → result; run
   ends `done` with a `costUsd`. A second `POST /api/runs` for the same `path` (the
   "เริ่มใหม่" flow) creates and starts a brand new, independent run.
3. `GET /files/../../etc/passwd` (raw and URL-encoded) → `403`; a legit demo file and
   the demo `ตรวจทาน/index.html` serve correctly with Thai names in the URL.
4. Frontend ↔ server contract holds: every route/field the JS uses exists as specced.
