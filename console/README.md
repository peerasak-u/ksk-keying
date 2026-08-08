# KSK App

A local web app that drives `/ksk-keying` stage by stage and turns each stage's output
into a review surface a human can actually check in a browser. One machine, one operator,
no auth of its own.

> **Note on the folder name.** This lives in `console/` for historical reasons. An older
> app — `ksk-console`, which wrapped the *entire* `/ksk-keying` pipeline in a single long
> `claude -p` run and showed it as a 3-lane kanban board on port 4820 — used to sit
> alongside this one in the same folder. It has been removed; nothing here depends on it.
> Only `sequencer/process-supervisor.ts` was ever shared, and it belongs to this app.

## Run it

```bash
cd console && bun install     # once
KSK_WORKSPACE_ROOT=/path/to/client/workspace bun run app/server.ts
```

Then open `http://127.0.0.1:4900`.

**There is no mock mode.** Every stage shells out to a real `claude -p` (see
`sequencer/spawn-stage.ts`), so a run costs real tokens from the first stage onward. The
workspace root is required and validated at boot — the server exits(1) if it is unset or
is not an existing directory, rather than guessing a default.

`KSK_WORKSPACE_ROOT`'s shape is two levels: level-1 directories are clients, level-2
directories are months (`216/เดือนพฤษภาคม`).

## How a run works

`sequencer/logic.ts` is a state machine over 7 stages:

| stage | gate |
|---|---|
| `profile` — Stage 0 | shape check |
| `segment` — Stage 1 | Ledger Gate |
| `interpret` — Stage 2 | Ledger Gate |
| `link` — Stage 3 | shape check |
| `group` — Stage 4 | shape check |
| `categorize` — Stage 5 | categorize check |
| `final` — Completion | Ledger Gate (spawns no process) |

Each stage that spawns a process runs `claude -p /ksk-stage-<id> <dir>` under
`sequencer/process-supervisor.ts`, which owns the process group, deadlines, and cleanup.
Two things are deliberately kept apart:

- **Did the process finish cleanly?** Answered from stream-json's own structured `result`
  event (`is_error`) plus the exit code — never by regexing the model's prose.
- **Did the stage actually do its work?** Answered afterward by
  `sequencer/completion-check.ts` against evidence on disk. That external check, not the
  agent's self-report, is this architecture's trust boundary.

`app/orchestrator.ts` queues runs at `KSK_APP_CONCURRENCY` (default 1, a de facto global
FIFO). A run holds a slot only while a stage is actively running: the moment it pauses —
blocked, `env-error`, stopped for a human, or done — the slot is released, so one stuck
client-month can never block everything queued behind it.

Run state persists to each client-month's own
`ข้อมูลระบบ/_pages/run-state.yaml`, inside the workspace itself. There is no central run
database and no `runs/` directory — a client-month with no `run-state.yaml` simply has no
run on record.

## The review UI

Server-rendered HTML from Bun, no framework and no client-side build. PDF rendering uses a
vendored `pdf.js` under `app/public/vendor/` — nothing is fetched from a CDN at runtime.

| page | what it is |
|---|---|
| `/` | dashboard — clients as sections, months as rows, with status, workload size, ETA, and per-month actions |
| `/clients/:client/:month/review` | review hub — the entry point after a run settles |
| `/clients/:client/:month/review/(expense\|income)/(vat\|non_vat\|mixed)` | document review for one of the 5 real buckets |
| `/clients/:client/:month/review/bank_statement` | bank statement review, row by row |
| `/clients/:client/:month/excluded-review` | exclusion claims — confirm each one, or bring it back |

Edits made in these pages write back through `app/review-edit.ts` and
`app/dispositions-writer.ts`; `app/peak-export.ts` builds the PEAK import workbook from the
reviewed result.

## API

| route | |
|---|---|
| `GET /api/config`, `GET /api/clients` | config + client/month listing |
| `GET /api/events`, `GET /api/runs/:client/:month/events` | SSE — global and per-run |
| `GET /api/runs`, `POST /api/runs` | list runs, start one |
| `POST /api/runs/:client/:month/{retry,stop,repair,rebuild-review-data}` | run control |
| `POST /api/runs/:client/:month/claims/{confirm,bring-back}` | exclusion decisions |
| `POST /api/learn/:client[/apply]` | propose, then apply, learned COA conventions |
| `PUT/POST /api/review/...` | page/row/statement edits |
| `GET /api/export/...` | PEAK workbook download |
| `GET /files/:client/:month/*` | source documents, read-only, traversal-guarded |

## Env vars

| var | default | meaning |
|---|---|---|
| `KSK_WORKSPACE_ROOT` | **required** — exits(1) if unset or not a directory | root whose level-1 dirs are clients and level-2 dirs are months |
| `KSK_APP_PORT` | `4900` | port to bind (docker-compose sets `8940`) |
| `KSK_APP_HOST` | `127.0.0.1` | interface to bind. See the security note below before changing it |
| `KSK_APP_CONCURRENCY` | `1` | how many client-months may hold a running stage at once |
| `KSK_INTERPRET_CONCURRENCY` | `2` | parallel leaf invocations inside Stage 2 |
| `KSK_STAGE_TIMEOUT_MS` | per-stage fallback | operator escape hatch for one unusually long client |
| `KSK_STAGE_IDLE_TIMEOUT_MS` | per-stage fallback | same, for the no-output deadline |

The last three are read directly from the process environment and are **not** listed in
`docker-compose.yml`'s `environment:` block, so under Docker they only take effect if you
add them there.

## Docker

```bash
cp .env.example .env    # fill in HOST_HOME + the two KSK_APP_*_HOST paths
docker compose up -d --build
```

Two services: `ksk-app` itself, and a `cloudflared` sidecar exposing it at
`ksk-keying.peerasak.com` behind a Cloudflare Access email allowlist. Both use
`network_mode: host`.

`docker-compose.yml` carries long comments on the mounts, and they are worth reading before
changing any of them — each one records a failure that actually happened (the credential
mount must be the `~/.claude` **directory**, not `.credentials.json` alone; the container
gets its own `.claude.json` rather than sharing the host's; the container is memory-capped
because the Pi host has been OOM-killed in practice).

## Security & cost notes

- **No auth layer of its own.** Under Docker this binds `0.0.0.0` and the Cloudflare Access
  policy on the tunnel is the *only* thing gating it. On a bare host it binds `127.0.0.1`;
  a tailnet IP is a reasonable override, a LAN or public interface is not.
- **Every run spends real money.** No mock engine exists. `KSK_APP_CONCURRENCY` bounds how
  many client-months run at once, and the per-stage deadlines bound a runaway stage, but
  nothing here imposes a dollar ceiling.
- **Stages run with `--permission-mode bypassPermissions`**, hardcoded. Nothing approves
  tool use in a headless spawn, so any other value turns every stage into a hang followed
  by a timeout. The external completion check is what makes this safe, not the agent's own
  tool permissions.
- **Path traversal is guarded, not merely discouraged.** `/files/` and every client/month
  route decode, resolve against `workspaceRoot`, and reject anything landing outside it —
  including URL-encoded `..%2f` forms.

## Files

```
console/
├── app/                  # the web app: server, dashboard, review pages, export, edits
│   └── public/vendor/     # vendored pdf.js — no CDN at runtime
├── sequencer/             # stage state machine, process supervision, spawn, gate checks
├── docker-compose.yml     # ksk-app + cloudflared
├── Dockerfile             # Bun + the native `claude` CLI, non-root, host-matched UID/GID
└── state/                 # gitignored — the container's own ~/.claude.json
```

Tests are colocated (`*.test.ts`); run them with `cd console && bun test`.
