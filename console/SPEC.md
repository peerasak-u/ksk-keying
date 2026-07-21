# KSK Console — Stage 1 Specification

A local web UI that wraps **headless Claude Code** (`claude -p`) so `/ksk-keying` runs can
be launched, watched live, resumed at review gates, and reviewed (the pipeline's generated
HTML) from a browser instead of a terminal.

**Stage 1 scope:** localhost only, single user, one machine. No auth, no HTTPS, no
multi-user. A real global FIFO queue exists: at most one run is active across ALL
client/month paths at a time, additional requests queue and auto-start in order as the
active run finishes.

## Stack

- **Server:** Bun + TypeScript, zero npm dependencies (use `Bun.serve`, `Bun.spawn`,
  `node:fs/promises`, `node:path` only). No build step.
- **Frontend:** vanilla HTML/JS/CSS served statically from `console/public/`. No
  frameworks, no build step, no CDN — with one deliberate exception: `index.html`'s Google
  Fonts `<link>` tags (`fonts.googleapis.com` / `fonts.gstatic.com`) mirror the pipeline's
  `review-template.ts` exactly, for visual consistency with the generated review pages the
  console links out to, and degrade gracefully offline (falls back to the system
  font stack). This was a deliberate product decision — do not remove these links.

## File layout (all under `console/`)

```
console/
├── SPEC.md            # this file
├── README.md          # how to run, env vars, security & cost notes
├── config.ts          # env-driven config, exported as a plain object
├── engine.ts          # run registry + claude -p spawn + stream-json capture + resume
├── mock-engine.ts     # token-free fake engine emitting the same event shapes
├── server.ts          # Bun.serve: API routes + static + SSE + /files
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
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
| `maxBudgetUsd` | `KSK_MAX_BUDGET_USD` | unset (omit `--max-budget-usd`) — **per-invocation** ceiling, re-applied to every spawn (initial, resume, watchdog); not a run-level cap (see below) |
| `autoContinue` | `KSK_AUTO_CONTINUE` | `true` (`'0'` disables) |
| `autoContinueMax` | `KSK_AUTO_CONTINUE_MAX` | `8` — whole-run-lifetime cap on `autoResumes`; never resets on manual resume or across gates (intended) |
| `runBudgetUsd` | `KSK_RUN_BUDGET_USD` | `25` — cumulative per-run spend guard, watchdog-only (see "Auto-continue watchdog" below); does not restrict manual resume |

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
resume (`POST /api/runs/:id/resume`) is rejected `409` only if some *other* run currently
has `status === 'running'` — a run that is merely `queued` elsewhere does not block a
resume.

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
  [--resume <sessionId>]          # resume only (manual or watchdog-triggered)
```

`HEADLESS_DIRECTIVE` is a fixed constant (see "Auto-continue watchdog" below) telling the
model this process exits at end-of-turn, so subagent waves must be dispatched
synchronously and the turn must not end until the pipeline is done or at a human review
gate. Always present on claude-engine spawns, including resumes.

- `cwd` = `workspaceRoot`, stdin ignored/closed.
- Every claude-engine spawn (initial, manual resume, watchdog auto-continue) clears any
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
- `stop()` → SIGTERM the child, cancel any pending watchdog timer → status `stopped`.
- `resume(runId, message)` → allowed only when status ≠ `running` and `sessionId` is set;
  spawns with `--resume <sessionId>` and the message as prompt; status back to `running`;
  events append to the same run.

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
     above). It never blocks a manual resume — that remains a human decision regardless of
     accumulated cost.
   - **Otherwise** (candidate, and under budget): do *not* settle `done`. Increment
     `autoResumes`, persist + broadcast state (status stays `running` throughout — no
     visible `done` flicker), then after ~3s spawn `--resume <sessionId>` with a fixed
     watchdog prompt (`WATCHDOG_MESSAGE`, which explicitly tells the model not to treat the
     automated nudge as gate approval).
   - **Otherwise** (not a candidate at all): settle `done` normally.
3. Auto-resume events append to the same run's `.jsonl`/SSE stream exactly like a manual
   resume. A manual `stop()` cancels a pending watchdog timer as well as killing an
   in-flight process.
4. `run.autoResumes` vs. `config.autoContinueMax` is a **whole-run-lifetime** comparison —
   `autoResumes` never resets, not on a manual resume, not across gates. Once a run has
   spent its auto-continue budget, the watchdog will not auto-continue it again even after
   a human resumes it manually and it hits another gate later. This is intended.

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
(e.g. 0.0123). `resume()` emits 2 assistant events + a `result`. Implemented with
timers in-process; `stop()` cancels them.

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
| `GET /api/clients` | `{clients:[{name, path, months:[{name, path}]}]}` — level-1 dirs of workspaceRoot are clients, their level-2 dirs are months. Skip entries starting with `.` and `node_modules`. Sorted with `localeCompare(…, 'th')`. |
| `POST /api/runs` body `{path, prompt?}` | Validate `path` is an existing dir under root (traversal-checked) → `400` otherwise. `409` if a `running` **or** `queued` run has the same `path` (duplicate check now covers both). Default prompt: `/ksk-keying <path>`. If some other run is currently `running`, the new run is created with `status: 'queued'` and the engine is **not** started; otherwise it starts immediately. Either way → `201 {run}`. |
| `GET /api/runs` | `{runs:[RunState]}` newest first |
| `GET /api/runs/:id` | `{run}` or `404` |
| `GET /api/runs/:id/events` | SSE (below) |
| `POST /api/runs/:id/resume` body `{message}` | `409` if this run is running, `409` if some **other** run currently has `status === 'running'` (Thai message), `400` if no sessionId or empty message → else resume, `200 {run}` |
| `POST /api/runs/:id/stop` | stop if running → `200 {run}` |
| `GET /api/html?path=<rel>` | `{files:[{name, relPath}]}` — all `*.html` under that folder, depth ≤ 3, skipping hidden dirs / `node_modules`. Used to discover review pages (ตรวจทาน/index.html etc.). |
| `GET /files/<rel…>` | Serve a file under workspaceRoot **read-only**. Decode, resolve, and require the resolved path to stay under workspaceRoot → else `403`. Content-type by extension (html/css/js/json/txt with `charset=utf-8`, png/jpg/pdf binary, else `application/octet-stream`). |
| `GET /`, `/app.js`, `/style.css` | static from `console/public/` |

### SSE contract

`GET /api/runs/:id/events`:
1. On connect, replay the full `.jsonl` — each stored line sent as a `data:` message.
2. Then stream live events as they arrive.
3. On every status change, send `event: state\ndata: <RunState JSON>`.
4. Comment heartbeat (`: ping`) every 15 s; clean up subscriber on disconnect.

## Frontend (`public/`)

Thai-language UI, two-pane layout, mobile-responsive via a CSS media query (single
column on narrow viewports; the two panes stack instead of sitting side by side):

- **Left pane — client tree.** Clients → months, mirroring `/api/clients`. Selecting a
  month enables starting a run and loads its review links from `/api/html?path=…`.
- **Right pane — three sections, driven off `/api/runs`:**
  - **กำลังทำงาน (running)** — the single run currently `status === 'running'`, if any.
    While it's live, this card also shows the current sub-agent indicator: sourced from
    `Agent` tool_use blocks in the SSE stream (their `subagent_type` + `description`),
    updated as new events arrive. This indicator only applies to the one live running
    card — there is no equivalent for queued or finished runs.
  - **รอคิว (queued)** — runs with `status === 'queued'`, ordered by `queuedAt` (earliest
    next). Reflects the global FIFO queue: only one run is ever `running` at a time
    across all client/month paths; everything else waits here and auto-starts in order
    as the active run finishes.
  - **ประวัติ (history)** — finished runs (`done`/`error`/`stopped`), newest first.
- No live log pane and no stage chips — both removed as cosmetic-only, unreliable
  additions; nothing in the current UI replaces them (mock and claude runs alike are
  followed via the run's status and, for the live run, the sub-agent indicator above).
- Review pages are not embedded in an iframe. Each finished run in ประวัติ offers a real
  link (or set of links, from `GET /api/html?path=…` resolved per that run's path) that
  opens the generated review HTML (e.g. `ตรวจทาน/index.html`) in a new tab, on demand.
- Starting a run → `POST /api/runs`; the resulting `RunState.status` (`queued` or
  `running`) determines which section it lands in immediately, no separate polling
  needed to place it correctly.
- Resume is offered when a run is not `running` and has a `sessionId`; if the request is
  rejected `409` because another run is actively running elsewhere, the UI surfaces that
  Thai message rather than silently failing.

## Hard constraints

- **Never** invoke the real `claude` binary unless `engineMode === 'claude'`. All
  development and all automated testing use mock mode — a real invocation spends money.
- No secrets, no telemetry, no external network calls anywhere.
- Path traversal must be impossible via `/files/`, `/api/html`, or `POST /api/runs`
  (including URL-encoded `..%2f` forms — decode first, then resolve + prefix-check).

## Acceptance (what validation must actually exercise)

1. `KSK_ENGINE=mock KSK_CONSOLE_PORT=4821 bun console/server.ts` boots; `GET /` serves
   the UI; `/api/config` and `/api/clients` return sane JSON (demo workspace listed).
2. `POST /api/runs` starts a mock run; SSE delivers init → assistant… → result; run
   ends `done` with a `costUsd`; `resume` then appends events and completes again.
3. `GET /files/../../etc/passwd` (raw and URL-encoded) → `403`; a legit demo file and
   the demo `ตรวจทาน/index.html` serve correctly with Thai names in the URL.
4. Frontend ↔ server contract holds: every route/field the JS uses exists as specced.
