# keying-core

Keying Core's `/v1` service — the neutral API the office platform and the CLI both call.

Two documents are authoritative, and neither is edited from here:

- `docs/plans/2026-08-07-keying-core-api-workflow-spec.md` — the implementer-level contract:
  every route with its schemas and status codes, one error model with a closed code list, the
  run state machine with numbered transitions, and the CLI.
- `docs/plans/2026-08-06-keying-core-modular-monolith-plan.md` (revision 4) — the architecture
  above it. Where the two appear to disagree, the plan wins.

**The existing runtime is the reference for behaviour.** `console/` holds the working sequencer
and orchestrator; this package describes and reads what that runtime does and changes nothing
under it. `src/workflow/runtime-parity.test.ts` is the only place `keying-core` reaches into
`console/`, it is a test, and it reads only — it holds the stage list, the terminal statuses and
the status enum here to the sequencer's own, so the contract cannot drift from the machine
silently.

## Commands

```bash
cd keying-core
bun install
bun test          # 264 tests, colocated *.test.ts, same layout as console/
bun run typecheck # tsc --noEmit
bun run start     # Bun.serve on KSK_CORE_PORT
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `KSK_WORKSPACE_ROOT` | **required** | The office workspace: many client folders, each holding `YY-MM` month folders. Same meaning as `console/app/config.ts` |
| `KSK_CORE_SERVICE_TOKEN` | **required** | The service-to-service bearer token (§1.1 **[C-01]**). A service with no token has no boundary, so there is no default |
| `KSK_CORE_PORT` | `4910` | Distinct from the console app's `4900`, so both run on one host during the migration |
| `KSK_CORE_HOST` | `127.0.0.1` | Loopback unless deliberately pointed at a private interface |
| `KSK_APP_CONCURRENCY` | `1` | Unchanged meaning (§4.1): the number of client-months whose drive loop may execute at one instant |
| `KSK_BUDDHIST_CENTURY_BASE` | `2500` | Core **refuses to start** if this is not a multiple of 100 (plan §9.2 **[r3]**), and logs the resolved window at boot |
| `KSK_CORE_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

## What this slice implements

| § | Route | Notes |
|---|---|---|
| 5.1 | `GET /v1/health/live` | No auth. Answers while everything else is still coming up |
| 5.2 | `GET /v1/health/ready` | Carries `warnings[]` naming **every** skipped non-matching month directory, verbatim. Warnings never make the service un-ready |
| 5.3 | `GET /v1/jobs` | Filters, cursor pagination, `(clientKey, monthId)` Thai-collated sort **[C-16]** |
| 5.4 | `POST /v1/jobs` | The operator's door: `{ clientKey, monthId }` **[C-17]** |
| 5.5 | `GET /v1/jobs/{jobId}` | Plus `queuePosition` and `allowedCommands` (§3.4's row on every read) |
| 5.13 | `POST /v1/jobs/resolve` | The platform's only door: `{ clientKey, monthKey }`, with `register` **[C-20]** |

Plus the pieces every later route lands on:

- **The error model, whole** (`src/errors/`) — §2's body shape and all thirty codes of §2.3's
  closed list, with the §2.2 status mapping. It is the only way this service reports a failure:
  every route throws a `CoreError` and the HTTP adapter is the single place one becomes a
  response.
- **Identity and validation** (`src/identity/`) — the `monthId` `YY-MM` format, the
  `monthKey` ↔ `monthId` mapping in both directions including the century-base rule and its
  dated expiry, and the path guard that rejects traversal, URL-encoded traversal, symlink
  escape, absolute host paths and unknown client/months. This is a trust boundary (plan §9.2,
  §9.4); the tests are written so that removing a rejection fails one.
- **The state machine** (`src/workflow/state-machine.ts`) — §3.1's states, §3.2's T1–T25 as a
  data table with a pure `transition()`, §3.3's illegal set (which is "no row matched", not a
  check somebody remembered), and §3.4's command-legality matrix. No I/O.
- **The stop conditions** (`src/workflow/human-stop.ts`) — §3.6's closed three-value
  enumeration **[C-36]** with Core's Thai `message`/`remedy`, and **[C-37]**'s handling of an
  unrecognised condition: the run stays visible, `conditionRaw` is carried verbatim, and one
  `warn` line names the drift.
- **The run projection** (`src/workflow/run-contract.ts`) — §1.7's `run` object, read from the
  same artifacts the runtime reads: `run-state.yaml`, `ledger.yaml`, `CLIENT.md`, and the
  `_doc_groups` tree.

## Explicitly not here

The four run commands (`start`/`retry`/`repair`/`stop`), SSE and the event envelope, the review
and exclusions routes, the export and document routes, the CLI, and SQLite persistence. Those
routes are **absent rather than stubbed**: a route that answers is a contract, and answering
wrongly is worse than not answering.

Three seams are in place for them, each a port with an honest adapter rather than a fake:

| Seam | Port | Today | Later |
|---|---|---|---|
| Queue and active slots | `SchedulerView` | `unscheduledSchedulerView` — this process schedules nothing and says so | An adapter over `Orchestrator`, landing with the run commands |
| Job rows | `JobRepository` | In-memory, enforcing plan §8.2's unique `workspace_rel_path` | SQLite `keying_jobs` |
| Run projections | `RunProjectionStore` | In-memory, `version` 0 with no run record, then +1 per real change | SQLite `run_projections`, one row per job |

One consequence worth stating rather than discovering: `GET /v1/health/ready` reports
`checks.sqlite: { ok: false, reason: "sqlite_not_implemented" }` — the spec's key, with content
that does not claim a healthy SQLite this process does not have. `schemaVersion` and
`journalMode` are **absent**, not nulled, per §1.3's rule that a missing key means "this route
does not carry that fact". Job registrations do not survive a restart until the SQLite adapter
lands. See finding 8 for why that failing check does not make the service un-ready yet.

## Findings against the spec

Recorded rather than quietly resolved. None of them changed a decision either document has
already made.

1. **No code for an unknown route.** §2.3 is closed — "Nothing outside this table" — and carries
   no code for a request to a path `/v1` does not define, nor for a method mismatch on one it
   does. This implementation maps that onto **`400 validation_failed`** with
   `details.fields[0].problem = "unknown_route"`, on the reading that §2.2's first row ("the
   request is not a valid request") covers a request malformed against the `/v1` contract, and
   because `validation_failed` is the one code §2.3 assigns to "every route". A `404` was
   rejected because every 404 code names a specific resource and none of them is honest here.
   If the spec would rather carry a `route_not_found`, that is a one-row addition.

2. **§3.3's `allowedCommands` example disagrees with §3.4's matrix.** §3.3's row for `start` on
   `blocked`/`env-error` shows `allowedCommands: ["retry","repair","stop"]`; §3.4's `blocked`
   row has `stop` as ❌, and §5.5's own example shows `["retry", "repair"]`. §2.4 says
   `allowedCommands[]` **is** the §3.4 row, and the runtime agrees (`stopRun` on a run that is
   neither queued nor active is `409 run_not_running`, `orchestrator.ts:296`). Implemented as
   §3.4/§5.5; §3.3's inline example looks like a slip.

3. **§3.4's `queued` row and its `blocked` row both describe a re-queued retry.** A `retry`
   leaves the persisted status at `blocked` and adds the run to the queue, so a run can be
   `blocked` and `queued` at once. §3.4's `queued` row marks `retry` ❌; §5.7's own table
   answers this exact case with "`202`, `alreadyQueued: true`, nothing enqueued", and §3.3 keys
   retry-legality on the status alone ("retry on anything but `blocked`/`env-error`"). The
   runtime sides with §5.7 (`orchestrator.ts:245-248` checks `isRetryable` on the status, then
   `:186` de-duplicates). Implemented as §5.7 + §3.3, so `allowedCommands` for that one state
   is `["start","retry","stop"]` rather than §3.4's literal `queued` row. Unreachable in this
   slice — nothing is ever queued until the command routes land — but it is the command slice's
   first decision.

4. **§3.4's `fatal-cleanup` row conflates the status with the latch.** The row annotates
   `start`/`retry`/`repair` with "❌ 503", but §5.8 is explicit that the latch clears on a
   process restart while the run's persisted `fatal-cleanup` does not, "so after the restart
   `repair` is exactly the command that clears it". Implemented with the latch as an input:
   latched → `503` for all three; unlatched, a persisted `fatal-cleanup` behaves like the other
   terminal statuses and `repair` is legal. `stop` is never refused for the latch (§5.9).

5. **A malformed `run-state.yaml` has no route-level code.** §2.3 lists `artifact_malformed` as
   raised by §5.15, §5.16, §5.18 and §5.21, and §5.5/§5.14's status lists do not include `422`.
   §2.2's mapping rule is stated as applying "without exception", and a corrupted state file is
   exactly its 422 row, so the job reads raise `422 artifact_malformed`. Reporting "this month
   never ran" instead would hide a real run behind a silence — the failure mode §3.7 exists to
   prevent. The runtime's own behaviour here is an unhandled throw, i.e. a `500`.

6. **[C-38]'s "edited since categorize produced it" needed a marker.** The comparison is mtime,
   as **[C-38]** says, but it needs something to compare against. `review-data.ai.json` — the
   pristine AI-output sidecar `build-review-data.ts` writes immediately *after*
   `review-data.json` in the same pass, and which the console's edit path never touches
   (`review-edit.ts:185-217` writes `review-data.json` alone) — is that marker: a freshly built
   group has the sidecar newer, and any later human save makes `review-data.json` strictly
   newer. `categorize.json` is the fallback for a group built before the sidecar existed.
   No new bookkeeping, and no tolerance to guess at.

7. **Every MULTI-SUBJECT response degrades instead of hard-failing; `GET /v1/jobs/{jobId}` still
   hard-fails.** *(A `[C-nn]` choice number is to be assigned to this when the spec is next
   revised — the spec owns that sequence, so no number is claimed here.)* One client-month's
   unreadable `run-state.yaml` must not blank a list covering every client, nor deny the platform
   an identity mapping that never reads the run record. `GET /v1/jobs` (§5.3), `POST /v1/jobs`
   (§5.4) and `POST /v1/jobs/resolve` (§5.13) therefore all answer normally and mark the affected
   subject with an additive `artifactProblem: { code: "artifact_malformed", reason }` beside their
   documented fields — distinguishable from `hasRunRecord: false` ("this month never ran"), which
   is the silence §3.7 exists to prevent, and inventing no `status` outside §3.1's ten. It is the
   spec's own answer twice over: none of those three routes' status lists contains `422` (§5.3's
   is `200`/`400 validation_failed`, §5.4's `201`/`200`/`400`/`404`, §5.13's
   `200`/`201`/`400`/`404`/`409 idempotency_key_*`) and §2's error table scopes
   `artifact_malformed` to §5.15/§5.16/§5.18/§5.21; and §3.6's rationale rejects exactly this
   shape ("Returning `422 artifact_malformed` hides a run that has genuinely stopped behind an
   error on the read route — the run becomes invisible exactly when a person is needed"), which at
   fleet scale is one corrupt file hiding every customer — and on §5.13, "the office platform's
   ONLY way to turn office identity into keying identity", a `422` is a dead end: the platform
   never gets the `jobId` it needs to repair the artifact that caused it. The degrade lives in the
   one shared projection helper, not at each call site. A degraded row also survives the
   run-shaped filters (`status`, `hasRunRecord`), because its projection is not evidence about the
   run. The single-subject read keeps finding 5's hard `422`: there the run IS the subject and the
   read has nothing else to return.

8. **`checks.sqlite` reports `ok: false`, and that does not make the service un-ready.** §5.2
   names the store check `sqlite`, so the key is the spec's rather than one renamed to match a
   temporary implementation — but its content must not assert a healthy SQLite that does not
   exist, so it is `{ ok: false, reason: "sqlite_not_implemented" }` with `schemaVersion` and
   `journalMode` omitted (§1.3). SQLite was cut from this slice's scope to keep the first slice
   small; neither document defers it, and it is the next task. Deliberately, and stated here
   rather than left silent: the readiness condition is over `checks.workspace` and
   `checks.orchestrator` **only** for now, because letting `checks.sqlite` fail readiness would
   make every route permanently `503` and the working slice unrunnable. When the SQLite adapter
   lands, `checks.sqlite.ok` joins that condition, per plan §8.4 step 1.

## Layout

`src/` follows plan §14.1's proposed shape, one directory down (the captain asked for a
top-level `keying-core/` rather than `console/core/`):

```text
src/
├── application/     # the use-case facade every adapter calls (plan §7.1), plus its ports
├── config.ts        # env → CoreConfig; throws rather than exits, so it is testable
├── errors/          # §2 — the closed code list and the one error body
├── http/            # the /v1 adapter: parsing, auth, status mapping, presentation only
├── identity/        # monthId/monthKey, clientKey, and the workspace path guard
├── jobs/            # plan §7.2's job module and its repository port
├── observability/   # structured JSON logging (plan §18)
├── test-support/    # a real on-disk workspace fixture for the adapter tests
├── workflow/        # plan §7.3's contract half: stages, state machine, stop conditions, run DTO
└── workspace/       # the filesystem adapter: the client/month walk and the artifact reads
```
