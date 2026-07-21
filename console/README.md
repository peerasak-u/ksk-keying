# KSK Console

A local web wrapper around headless Claude Code (`claude -p`) for running,
watching, and resuming `/ksk-keying` runs from a browser instead of a
terminal. Stage 1: localhost only, single user, one machine.

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

## Env vars

| var | default | meaning |
|---|---|---|
| `KSK_CONSOLE_PORT` | `4820` | port the server binds on `127.0.0.1` |
| `KSK_ENGINE` | `mock` | `mock` (token-free fake engine) or `claude` (spawns the real `claude` binary — costs money) |
| `KSK_WORKSPACE_ROOT` | mock: auto-created `console/demo-workspace/`; claude: **required**, server exits(1) if unset or not a directory | root folder whose level-1 dirs are treated as clients and level-2 dirs as months |
| `KSK_PERMISSION_MODE` | `acceptEdits` | passed to `claude -p --permission-mode` |
| `KSK_ENGINE_MODEL` | unset (omit `--model`) | passed to `claude -p --model` when set |
| `KSK_MAX_BUDGET_USD` | unset (omit `--max-budget-usd`) | passed to `claude -p --max-budget-usd` on **every** claude-engine spawn (initial, manual resume, and watchdog auto-continue) — a **per-invocation** ceiling enforced by the `claude` binary itself, re-applied fresh each time. It does *not* cap the run as a whole: worst-case exposure from this flag alone, across a full watchdog lifetime, is `(KSK_AUTO_CONTINUE_MAX + 1) × KSK_MAX_BUDGET_USD`. |
| `KSK_AUTO_CONTINUE` | `1` (on) | set to `0` to disable the auto-continue watchdog (claude engine only; see below) |
| `KSK_AUTO_CONTINUE_MAX` | `8` | max auto-continue resumes per run before the watchdog gives up and leaves the run `done`. This is a **whole-run-lifetime** cap on `autoResumes` — it never resets on a manual resume or across gates; once spent, the watchdog won't auto-continue that run again even after a human resumes it manually and hits another gate. (Intended.) |
| `KSK_RUN_BUDGET_USD` | `25` | the actual **run-level** spend guard: before each watchdog-triggered auto-continue, if the run's cumulative recorded cost (`costUsdFull ?? costUsd ?? 0`) has already reached this, the watchdog halts (settles `done`, `note: "auto-continue halted: run budget reached"`) instead of resuming. Watchdog-only — it never blocks a **manual** resume, which remains a human decision regardless of spend. |

## Headless mode vs. interactive Claude Code

In interactive Claude Code, the `/ksk-keying` orchestrator dispatches subagent waves in
the background, ends its turn, and gets re-invoked when they finish. `claude -p` has no
such re-invocation: the process exits the instant the model ends its turn, which would
kill any subagent wave still running in the background. Two things compensate for that:

1. **Headless directive at spawn.** Every claude-engine invocation (initial, manual
   resume, and auto-continue) is spawned with `--append-system-prompt` carrying a fixed
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
  resume manually. (Bare English "review"/"approve" are deliberately not matched here — see
  the comment on `GATE_RE` in `engine.ts` for why.)
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
  *automatic* watchdog — a human can still resume the run manually at any time regardless
  of accumulated spend.
- **Otherwise** the run finishes `done` as normal.

Auto-resume events append to the same run's `.jsonl`/SSE stream exactly like a manual
resume — from the browser's perspective a run that auto-continues just keeps streaming
log lines under the same run, with `autoResumes` ticking up. A manual **Stop** always
wins: it cancels a pending watchdog timer as well as killing an in-flight process. This
mechanism only ever runs for `KSK_ENGINE=claude`; the mock engine always finishes its
fake runs `done` and never sets `autoResumes` above `0`.

`autoResumes` is a **whole-run-lifetime** counter against `KSK_AUTO_CONTINUE_MAX` — it
never resets, not on a manual resume, not across gates. A run that has already used up its
auto-continue budget on the road to its first gate will not get any more auto-continues
after a human resumes it past that gate; only `KSK_RUN_BUDGET_USD` and
`KSK_AUTO_CONTINUE_MAX` interact with the watchdog, and neither ever restricts a manual
resume. This is intended, not an oversight.

## Queueing

Only one client/month runs at a time, across the whole console — not just per path.
Starting a run while another is already active doesn't reject it: the new run is
created immediately with `status: 'queued'` and takes its place in a FIFO queue, ordered
by when it was requested (`queuedAt`). When the currently active run finishes — however
it finishes, `done`, `error`, `stopped`, or a manual stop — the earliest-queued run
starts automatically, no user action needed. This also applies across a server restart:
the server checks for a queued run to promote on boot, so a populated queue never sits
idle just because nothing happened to be running at the moment of restart. A resume
(`POST /api/runs/:id/resume`) is blocked (`409`) only while some *other* run is actively
`running` — a run that's merely waiting in the queue elsewhere does not block a resume.

## The resume-at-gate loop

`/ksk-keying` pauses at Ledger Gates for human review (segmentation, exclusion
claims, etc.) — the pipeline writes a review HTML page (e.g.
`ตรวจทาน/index.html`) and stops rather than guessing. The console's job is to
make that pause visible and make resuming it a browser action instead of a
terminal one:

1. **Run** a client-month → the server spawns `claude -p /ksk-keying <path>
   --output-format stream-json`, capturing every event to
   `console/runs/<id>.jsonl` and streaming it live over SSE.
2. When the pipeline reaches a gate, it says so in its assistant text and the
   process exits — the run's `status` becomes `done` (gates exit cleanly;
   they aren't errors) with a `sessionId` retained from the run's `init`
   event. The finished run then shows up in the console's history section.
3. From there, the reviewer opens the generated review page — a direct link
   (from `GET /api/html?path=…` for that run's path) that opens in a new tab,
   not an embedded iframe — checks it, and decides whether to approve or
   request changes.
4. The reviewer types their decision/instructions into the **resume box** and
   submits — `POST /api/runs/:id/resume {message}` spawns `claude -p <message>
   --resume <sessionId>`, appending to the *same* `.jsonl` and run record so
   the whole history — pre-gate and post-gate — stays in one place.
5. Repeat 2–4 for however many gates the run has; the console never needs to
   know how many stages or gates a client will hit, it just always offers
   "resume when not running and a sessionId exists."

Resume is only enabled when a run is not `running` and has a `sessionId` —
there is no way to resume a run that never got far enough to start a Claude
session, and no way to resume one that's still in flight.

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
  initial, manual resume, and each watchdog auto-continue — so it caps what a
  single invocation can spend, not the run as a whole. Left to the watchdog
  alone, worst-case exposure from this flag across a run's full auto-continue
  lifetime is `(KSK_AUTO_CONTINUE_MAX + 1) × KSK_MAX_BUDGET_USD`. The actual
  run-level guard is **`KSK_RUN_BUDGET_USD`** (default 25): the watchdog checks
  the run's cumulative recorded cost against it before every auto-continue and
  halts (settles `done`) once it's reached — see "The auto-continue watchdog"
  above. Set both when running against the real engine unattended; note that
  `KSK_RUN_BUDGET_USD` only gates the *watchdog* — a human can always resume a
  run manually regardless of accumulated spend.
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
├── engine.ts           # run registry, persistence, real claude -p spawn, resume/stop
├── mock-engine.ts      # token-free fake engine, same event shapes
├── server.ts           # Bun.serve: API routes + SSE + /files + static
├── public/             # frontend (owned separately)
├── runs/                # gitignored — run state (*.json) + event log (*.jsonl)
└── demo-workspace/      # gitignored — mock-mode auto-created demo client folder
```
