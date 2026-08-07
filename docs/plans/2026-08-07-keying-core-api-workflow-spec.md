# Keying Core — `/v1` API, workflow state machine, and CLI specification

Status: proposed — implementable companion to the architecture plan
Date: 2026-08-07 · **revision 1** (2026-08-07): the stop conditions pinned as a closed
enumeration (§3.6, §3.7) and `repair`'s cost made visible at the API before it is paid
(§5.8, §5.17). Both changes come from the captain's review of the state machine; neither
adds a route and neither touches plan §21.
Baseline inspected: `main@927bb38` (architecture plan revision 4); runtime at
`console/sequencer/logic.ts`, `console/app/orchestrator.ts`, `console/app/server.ts`,
`console/app/run-store.ts`, `console/app/review-edit.ts`, `console/app/dispositions-writer.ts`
Companion document: `docs/plans/2026-08-06-keying-core-modular-monolith-plan.md` —
**the architecture plan, revision 4. It is authoritative. This document is not.**

---

## 0. What this document owns, and what it does not

The architecture plan decided the shape of the system. It stops one level above an
implementer: §9.1 lists 21 routes as *method, path, purpose*; §10 gives an event envelope and
a catalogue of event names; §11 sketches a CLI command surface. None of those can be built
from without inventing contracts.

**This document is that next level and nothing else.** It adds no capability, moves no
boundary, and reopens nothing.

| Question | Owned by |
|---|---|
| Which services exist, where the boundary sits, who calls whom | Plan §1, §6 |
| Who owns which entity, and which store is authoritative | Plan §2, §8.1 |
| Whether there is a run history, what a `personId` is, what `monthId` means, which database, which identity provider, which งวด reach Core | **Plan §21 — closed. Not reopened here.** |
| Persistence rules, SQLite runtime rules, command-consistency sequence | Plan §8 |
| Which routes exist at all | Plan §9.1 |
| Which events exist at all | Plan §10.3 |
| **Every route's parameters, body, response, status codes, idempotency** | **§5 of this document** |
| **One error body, one closed code list, one status-mapping rule** | **§2** |
| **The workflow state machine: states, transitions, triggers, events, illegal moves** | **§3** |
| **Concurrency, queue ordering, restart behaviour** | **§4** |
| **The SSE payloads behind §10.3's event names** | **§6** |
| **End-to-end sequences** | **§7** |
| **Every CLI command's arguments, output, exit codes, and route** | **§8** |
| The office platform's own UI, store, sessions, and screens | Plan §7.5, §8.5; the mock |

Where the plan and this document appear to disagree, the plan wins and this document has a
bug. Where the plan is silent, this document chooses, and **every such choice is marked
`[C-nn]`** and listed once more in §9 so a reviewer can find all of them without reading the
body. Nothing marked `[C-nn]` is a decision the captain has already made; nothing the captain
has already made is marked `[C-nn]`.

### 0.1 Grounding

The plan is a design document; this one has to be true about code that exists. Every claim
below about *current* behaviour is cited to a file and line, and the citation is the point:
an implementer must be able to check it, and a reviewer must be able to see that the state
machine in §3 is the machine in `console/sequencer/logic.ts`, not a redrawing of it.

Tags follow the plan's convention where useful: **[M]** grounded in the mock, **[P]** a
proposal in the plan, **[r3]/[r4]** settled in that revision. This document adds one:

| Tag | Meaning |
|---|---|
| **[C-nn]** | A choice made *here* because the architecture does not determine it. Each carries a one-line rationale. Overrulable in review; none of them is load-bearing for another choice unless it says so. |
| **[captain YYYY-MM-DD]** | A decision the **captain** made in review, on that date, with the cost stated to him before he made it. It is **settled**: this document records it and does not reopen it, and it is deliberately *not* a `[C-nn]`. One exists so far — `repair` as the resolution path for a human stop, §5.8. |

---

## 1. Wire conventions

### 1.1 Transport and trust

- Base URL: `http://keying-core:<port>/v1` on the private Compose network (plan §13.3). No
  public hostname, no `0.0.0.0` published port. The CLI reaches the same routes over
  loopback (plan §11).
- Authentication is service-to-service only (plan §9.4). **[C-01]** The service token is
  presented as `Authorization: Bearer <token>`. *Rationale: one standard header, no bespoke
  name, and it is the form an mTLS migration leaves untouched — the plan permits either.*
- A request with a missing or wrong token gets `401 unauthorized` (§2.3) with **no** body
  detail about which. Core has exactly one caller identity; there is nothing to disambiguate.
- Core authorizes **nothing** per human. Every mutating request may carry `requestedBy` (a
  `personId` string) and Core records it on the receipt and in logs, for audit only
  (plan §9.4). Core never resolves it, never validates it against anything, and never
  authorizes on it.

### 1.2 Content, encoding, and Thai

- Request and response bodies are `application/json; charset=utf-8` unless a route says
  otherwise (the two byte-serving routes, §5.19 and §5.21).
- **All text is UTF-8 and may be Thai.** Client ids, month labels, document filenames,
  `reason` strings, error `message` values and COA `name_th` are Thai in practice. No
  response field is ASCII-constrained; no error message is English-only.
- Strings are compared and stored **NFC-normalised** where they are used as keys
  (`unitKey`, `console/app/review-claims.ts:91-96` normalises for matching but never for
  display — this document keeps that split: match on NFC, echo verbatim).
- `Accept-Language` is ignored. **[C-02]** Error bodies carry both a stable machine `code`
  and a Thai `message`. *Rationale: the operator at `keying health` and the accountant behind
  the office UI both read Thai; the platform maps `code` when it wants its own copy.*

### 1.3 Scalars

| Kind | Wire form |
|---|---|
| Timestamp | ISO-8601 UTC with milliseconds and `Z` — `"2026-08-07T10:42:18.000Z"`. Matches `new Date().toISOString()`, which is what `run-store.ts` already writes |
| Duration | Integer milliseconds, field name ends `Ms` |
| Money | JSON number, THB, no currency field. This is what the artifacts hold (`console/app/review-data.ts:24`) |
| Absent vs empty | `null` means "known to be absent"; a **missing key** means "this route does not carry that fact". Never `""` for absence |
| Booleans | Never tri-state. `null` is not a boolean |

### 1.4 Identifiers

| Identifier | Form | Owner | Notes |
|---|---|---|---|
| `jobId` | `job_` + 22 chars `[0-9A-Za-z]` | Core SQLite | Opaque, stable, never reused. Plan §9.2 |
| `runRef` | **the same token as `jobId`** **[C-03]** | Core | See below |
| `clientKey` | The client directory name under `KSK_WORKSPACE_ROOT`; Thai allowed; no `/`, no leading `.` | Core (filesystem) | The platform stores it per customer as `keyingClientKey` (plan §9.2) |
| `monthId` | `^[0-9]{2}-(0[1-9]|1[0-2])$` — short Buddhist year (plan §9.2, **[r3]**) | Core | `69-08` |
| `monthKey` | `^[0-9]{4}-(0[1-9]|1[0-2])$` — full Buddhist year (mock `src/domain/dates.ts:15-18`) | Office platform | `2569-08`. The platform **never** truncates it (plan §9.2) |
| `workspaceRelPath` | `<clientKey>/<monthId>`, POSIX | Core | Returned as a logical reference only; never a host absolute path (plan §9.2) |
| `bucket` | one of `expense/vat`, `expense/non_vat`, `expense/mixed`, `income/vat`, `income/non_vat`, `bank_statement` (`console/app/review-data.ts:132-141`) | Core | Closed set |
| `groupId` | The group directory name under `ข้อมูลระบบ/_doc_groups/<bucket>/` | Core | Opaque to the platform |
| `unit` | `file` \| `file#p<N>` \| `file#s<Sheet>` (`console/app/review-claims.ts:91-96`) | Core | Contains `/`, `#`, and Thai. See §5.17 for encoding |

**[C-03] `runRef` is the same opaque token as `jobId`.** A route may be written with either
name; they take the identical value, and `GET /v1/runs/{x}` and `GET /v1/jobs/{x}` describe
the same thing from two angles (the run's execution state vs the job's metadata plus that
state). *Rationale: §21 settled that there is no run history — one `run-state.yaml` per
client/month, one `run_projections` row per job, a retry overwrites in place. A `runRef`
distinct from `jobId` would be an identifier for a member of a set that has exactly one
member and no history, and it would break plan §10.2's reconciliation, which requires a
platform-stored reference to stay resolvable across a retry.* Consequence, stated so it is
not discovered: **a run reference the platform stored before a re-run still resolves after
it, and now describes the new attempt.** That is the §2.4 cost, visible at the API.

Core exposes **no attempt counter**. The mock's `no` is a platform-side per-(project, phase,
workflow) ordinal (plan §2.4) and Core has nothing to populate it with. **[C-04]** *Rationale:
inventing one in Core would be the first field of a run history.*

### 1.5 Idempotency

Plan §8.4 requires a durable receipt with a unique idempotency key on every mutating command,
and requires the platform to derive the key from its own run intent.

- Header: `Idempotency-Key: <16..128 chars of [A-Za-z0-9_.:-]>`.
- **[C-05] Required** on `start`, `retry`, `repair`, `stop`, the exclusion decision, and the
  group `PATCH`. **Optional** on `POST /v1/jobs` and `POST /v1/jobs/resolve`, and on
  `repair` with `dryRun: true`, which is a read and executes nothing (**[C-39]**, §5.8).
  *Rationale:
  the two registration routes are already idempotent by the `unique workspace_rel_path`
  constraint (plan §8.2) — a replay creates nothing and returns the same job. The six others
  can each cause work or a write, so §8.4's rule binds.* A missing key on a required route is
  `400 idempotency_key_required`.
- Scope: a key is unique **globally within Core**, matching `workflow_requests`' unique index
  (plan §8.2). It is not scoped per job — the platform's key already includes the project and
  attempt.
- **[C-06] A receipt records the outcome of every request that named an existing job, whether
  it was accepted or rejected; a replay returns that recorded outcome byte-for-byte, with the
  original status code and `Idempotency-Replayed: true`.** A request that fails *schema*
  validation (`400 validation_failed`) or names an unknown job (`404`) writes **no** receipt
  and the key stays free. *Rationale: §8.4's sequence inserts the receipt after DTO validation
  and job lookup, before the orchestrator call; the orchestrator's own refusal is an outcome
  of an accepted intent, not a malformed request. Replaying a refusal is correct because the
  platform's key encodes `(projectId, phaseIndex, workflowKey, attempt)` — the same key is
  the same intent, and a new intent has a new attempt.*
- Same key, **different** route or body → `409 idempotency_key_conflict`. The comparison is
  over `(method, path, canonicalised body)`; `requestedBy` is excluded from the comparison so
  a retry from a different session cannot conflict.
- A key whose original request is still in flight → `409 idempotency_key_in_flight`, retryable.
- **[C-07] Retention: 30 days**, from `KSK_CORE_RECEIPT_TTL_DAYS` (default `30`). After
  expiry the key is free and a replay executes as a fresh command. *Rationale: unbounded
  receipt growth is the only alternative, and 30 days is far longer than any platform retry
  window; the value is configurable so an operator can raise it without a code change.*

### 1.6 Optimistic concurrency — two different counters, deliberately

| Counter | Scope | Purpose | Carried as |
|---|---|---|---|
| `version` | One job's run projection | **Ordering only.** Monotonic per job, increments on every projection update (plan §8.2, §10.1). The platform compares it before writing a run reference so a late SSE event cannot regress it | Response field `version`; SSE envelope `version` |
| `etag` | One group's `review-data.json` | **Preconditioning a write.** A strong ETag over the group document's bytes | `ETag` response header on §5.15; `If-Match` request header on §5.18 |

**[C-08] Group edits precondition on the group's `ETag`, not on the run's `version`.**
*Rationale: `version` is a per-job counter (plan §8.2). If two reviewers edit two different
groups of the same run, a `version` precondition makes one of them fail for no reason. The
group document is the unit of write (`console/app/review-edit.ts:216-238` writes exactly one
group's `review-data.json` atomically), so it is the unit of precondition.* A stale `If-Match`
is `409 stale_version` (§2.3) — the plan's "a stale `version`" case, landing in one place.

`version` is **never** a request precondition. It is not a way to say "apply this only if the
run has not moved"; §3.4's command-legality matrix is that.

### 1.7 Common response objects

Every route that describes a run returns the same `run` object. It is the neutral DTO plan
§9.3 requires: the raw sequencer status, `queued` and `active` as separate booleans, and one
additive derived category that never replaces the raw status.

```json
{
  "runRef": "job_7Qd2xK9mLp0aRt4Vb8Nc1Z",
  "jobId": "job_7Qd2xK9mLp0aRt4Vb8Nc1Z",
  "workspaceRelPath": "216/69-08",
  "clientKey": "216",
  "monthId": "69-08",
  "status": "blocked",
  "observedStatus": "blocked",
  "queued": false,
  "active": false,
  "hasRunRecord": true,
  "stage": { "id": "interpret", "index": 2, "label": "Stage 2 — interpret", "count": 7 },
  "retryCount": 1,
  "retriesRemaining": 1,
  "humanStop": [],
  "lastLogLine": "interpret: completion check exit 1 — BLOCKED (retry 1/2 used)",
  "failReason": "interpret: completion check exit 1 — BLOCKED (retry 1/2 used)",
  "counts": { "totalUnits": 41, "reviewed": 33, "excluded": 8, "groupCount": 12, "attention": 3 },
  "repairImpact": { "destroys": true, "editedGroups": 4, "groupCount": 12,
                    "lastHumanEditAt": "2026-08-07T13:20:11.004Z" },
  "startedAt": "2026-08-07T09:14:02.117Z",
  "stageStartedAt": "2026-08-07T09:41:55.902Z",
  "updatedAt": "2026-08-07T10:02:44.310Z",
  "finishedAt": null,
  "externalRef": { "projectId": "srichai-monthly-69-08", "phaseIndex": 1, "workflowKey": "ksk-keying" },
  "requestedBy": "prs_9f31c0",
  "version": 17
}
```

Field notes, all of them checkable against the runtime:

- `status` — one of the ten values in plan §9.3, taken verbatim from
  `console/sequencer/logic.ts:117-127`. It is the **persisted** sequencer status.
- `observedStatus` — `queued ? "queued" : active ? "stage-running" : status`. This is exactly
  `toDisplayStatus()` (`console/app/dashboard.ts:79-84`), lifted into the contract so the
  platform and the CLI do not each re-derive it. It is additive; `status`, `queued` and
  `active` are always present beside it (plan §9.3 forbids replacing the raw status).
- **`gate-running` is reserved and is not observable today.** `stage-running` and
  `gate-running` exist only transiently inside one in-flight `attempt()` call and are never
  persisted (`console/app/run-store.ts:7-17`); the orchestrator's registry holds the last
  rest point, so an in-flight run reports `status: "idle", active: true`. **[C-09] The DTO
  keeps both values in the enum and clients must accept them, but v1 emits `gate-running`
  only if the workflow module is later extended to publish intra-attempt transitions.**
  *Rationale: plan §9.3 requires every current sequencer status to survive in the neutral DTO,
  and silently dropping one would make a client that handles nine values look complete. Adding
  the notify hook is additive and changes no sequencer behaviour, so it stays available; this
  document does not require it.*
- `stage.count` — the number of stages (`7` today). Plan §9.3: **neither side may hardcode
  "7"**, so the count is on the wire.
- `retriesRemaining` — derived from the policy in `console/sequencer/logic.ts:184`
  (`blocked` = 2 retries, `env-error` = 1, `final` = 0). `null` when the current status is not
  retryable.
- `humanStop` — the entries read from `ข้อมูลระบบ/_pages/human-stop.yaml`
  (`console/sequencer/logic.ts:65-70`), each **enriched by §3.6**:
  `[{ "stage", "unit", "condition", "conditionRaw", "reason", "message", "remedy" }]`.
  `stage`, `unit` and `reason` are verbatim from the artifact; `condition` is the closed
  enumeration of §3.6 (**[C-36]**) and `conditionRaw`, `message`, `remedy` are Core's.
  Empty unless `status` is `stopped-for-human`.
- `failReason` — the last log line, or the joined human-stop conditions when there are any.
  Same derivation as `reasonText()` (`console/app/dashboard.ts:86-93`). `null` when the run
  has not failed or stopped. It is a **log-shaped** string: a screen shows `humanStop[].message`
  to a person, never this.
- `counts` — from `ข้อมูลระบบ/_pages/ledger.yaml`'s `counts` block
  (`console/app/workspace.ts:76-95`) plus the group/attention totals from the review data.
  **`null` until the `final` gate has written them.** These are the headline counts the
  platform caches (plan §2.4).
- `repairImpact` — what a `repair` would throw away right now (**[C-38]**, §5.8). Present on
  the single-subject reads `GET /v1/jobs/{jobId}` and `GET /v1/runs/{runRef}` and on both
  `repair` responses; **the key is absent** — §1.3's missing-key rule, not `null` — from the
  list routes `GET /v1/jobs` and `GET /v1/runs` and from every SSE payload, because computing
  it costs one filesystem read per group.
- `externalRef` — whatever the platform sent at `start`, echoed verbatim and never
  interpreted (plan §7.2, §10.1). `null` if the job was registered by the CLI.
- `version` — §1.6.

`hasRunRecord: false` means the job is registered but `run-state.yaml` does not exist yet. In
that case `status` is `"idle"`, `stage` is stage 0, `startedAt`/`updatedAt`/`finishedAt` are
`null`, `counts` is `null`, and `version` is `0`. See **[C-11]** in §5.14.

---

## 2. The error model

One shape, one closed list, one mapping rule, for every `/v1` route. Existing `/api/*` routes
keep their current `{ "error": "..." }` body during the compatibility period (plan §9.1) and
are out of scope here.

### 2.1 The body

```json
{
  "error": {
    "code": "run_not_startable",
    "message": "ลูกค้ารายนี้มีการรันค้างอยู่แล้ว ใช้ปุ่มลองใหม่แทน",
    "status": 409,
    "requestId": "req_01J8ZC4K7Q",
    "details": {
      "jobId": "job_7Qd2xK9mLp0aRt4Vb8Nc1Z",
      "currentStatus": "stage-running",
      "allowedCommands": ["stop"]
    }
  }
}
```

- `code` — a value from the closed list in §2.3. `snake_case`, stable, never removed, never
  reused for a different meaning. Adding a code is a `/v1` additive change; changing what one
  means is not.
- `message` — Thai, human, safe to show to an operator. It carries no host path, no token, no
  stack, no document content (plan §18).
- `status` — the HTTP status, repeated in the body so a client that only logs the body can
  still tell a `409` from a `503`.
- `requestId` — the same id in the structured log line (plan §18), so an operator can join a
  screenshot to a log.
- `details` — **optional, code-specific, and documented per code**. Never free-form. The three
  shapes that exist are in §2.4.

**[C-10] The error body is nested under `error` rather than flat.** *Rationale: a success
body may legitimately contain a field called `code` (a COA account code does), and a flat
error shape would make "is this an error?" a guess about which keys are present.*

### 2.2 The mapping rule

The class of failure decides the status. There is one rule and it is applied without
exception:

| Class | Status | Rule |
|---|---|---|
| The request is not a valid request | `400` | Shape, type, missing required field, unparseable id, a `monthId`/`monthKey` that fails its regex, a path that fails the traversal guard |
| The caller is not authenticated | `401` | Missing/invalid service token |
| The request is well-formed but names something that does not exist | `404` | Unknown `jobId`, unknown `clientKey`, unknown `groupId`, unknown `unit`, a month folder that is not on disk |
| The request is well-formed and the target exists, but the current state forbids it | `409` | Illegal command for the state, run busy, stale `If-Match`, idempotency-key conflict, export not ready |
| The request is well-formed but names a resource whose *body* is unusable | `422` | An artifact on disk is malformed — e.g. a group's `review-data.json` fails its schema |
| Core is up but cannot serve this yet | `503` | Not ready (migrations/boot reconcile incomplete), or the `fatal-cleanup` latch is set |
| Anything else | `500` | Never carries an internal message |

Two consequences worth stating because they are the ones people get wrong:

1. **A month folder that does not match `^[0-9]{2}-(0[1-9]|1[0-2])$` is a `400`, not a `404`.**
   The request is malformed — the platform sent a `monthKey` that cannot be a month. A folder
   that matches the format but is absent from disk is a `404` (`month_folder_not_found`,
   plan §9.2). These are different failures and the platform shows different things for them.
2. **An illegal command is never a `400`.** `POST /start` on a running job is a well-formed
   request against a real job; it is `409`. This matters because a platform that maps `400` to
   "my bug" and `409` to "the run moved" behaves correctly only if Core keeps the line.

### 2.3 The closed code list

Every code Core may return. Nothing outside this table.

| Code | Status | Meaning | Raised by |
|---|---|---|---|
| `validation_failed` | 400 | Body/query failed schema. `details.fields[]` | every route |
| `invalid_month_key` | 400 | `monthKey` is not `BBBB-MM` | §5.13 |
| `invalid_month_id` | 400 | `monthId` is not `YY-MM` (plan §9.2) | §5.4, §5.13, CLI register |
| `invalid_client_key` | 400 | Empty, contains `/`, starts with `.`, or fails the path guard | §5.4, §5.13, §5.20 |
| `invalid_path` | 400 | Traversal, encoded traversal, symlink escape, absolute host path (plan §9.2) | §5.4, §5.19 |
| `invalid_unit` | 400 | `unit` is not a `file`/`file#pN`/`file#sSheet` key, or the path and body disagree | §5.17, §5.19 |
| `idempotency_key_required` | 400 | Required header absent | §1.5 |
| `idempotency_key_invalid` | 400 | Header fails the charset/length rule | §1.5 |
| `unsupported_field` | 400 | A body field Core has no artifact to persist (§5.18) | §5.18 |
| `unauthorized` | 401 | Missing/invalid service token | every route |
| `job_not_found` | 404 | No job with that `jobId`/`runRef` | every job/run route |
| `client_not_found` | 404 | No such client directory under the workspace root | §5.13, §5.20 |
| `month_folder_not_found` | 404 | The `monthId` is valid but the directory does not exist. `details.expectedMonthId` (plan §9.2) | §5.13 |
| `group_not_found` | 404 | No such `groupId` in that bucket | §5.18 |
| `unit_not_found` | 404 | No disposition entry / no source document for that `unit` | §5.17, §5.19 |
| `run_not_startable` | 409 | `start` on a job whose state forbids it. `details.currentStatus`, `details.allowedCommands[]` | §5.6 |
| `run_not_retryable` | 409 | `retry` on a run that is not `blocked`/`env-error` | §5.7 |
| `run_not_repairable` | 409 | `repair` while queued or active | §5.8 |
| `repair_not_acknowledged` | 409 | `repair` (or a `keep` decision) that would destroy human review work, sent without `acknowledgeDiscard: true`. `details.repairImpact` (**[C-40]**) | §5.8, §5.17 |
| `run_not_running` | 409 | `stop` on a run that is neither queued nor active | §5.9 |
| `run_busy` | 409 | A review write while the run is queued or active | §5.17, §5.18 |
| `stale_version` | 409 | `If-Match` does not match the group's current `ETag`. `details.currentEtag` | §5.18 |
| `idempotency_key_conflict` | 409 | Same key, different request | §1.5 |
| `idempotency_key_in_flight` | 409 | Same key, original still executing | §1.5 |
| `export_not_ready` | 409 | Export requested before the run reached `done`, or no committable rows | §5.21 |
| `decision_not_pending` | 409 | The unit is not an agent-proposed exclusion awaiting review (already decided) | §5.17 |
| `artifact_malformed` | 422 | An on-disk artifact failed its schema. `details.artifact` | §5.15, §5.16, §5.18, §5.21 |
| `not_ready` | 503 | Boot/migration/reconcile incomplete (plan §8.4) | every route except §5.1 |
| `halted_fatal_cleanup` | 503 | The process-cleanup latch is set; no work may start (plan §17) | §5.6, §5.7, §5.8 |
| `internal_error` | 500 | Anything unhandled | every route |

Thirty codes. A client may switch exhaustively on this list.

### 2.4 The four `details` shapes

```jsonc
// 1. validation_failed
"details": { "fields": [ { "path": "monthKey", "problem": "pattern", "expected": "^[0-9]{4}-(0[1-9]|1[0-2])$" } ] }

// 2. any command refused by state (run_not_startable / _retryable / _repairable / _running / run_busy)
"details": { "jobId": "job_...", "currentStatus": "stage-running", "queued": false, "active": true,
             "allowedCommands": ["stop"] }

// 3. stale_version
"details": { "currentEtag": "\"9f2c1a...\"", "groupId": "g-004", "bucket": "expense/vat" }

// 4. repair_not_acknowledged  — §5.8 [C-40]
"details": { "jobId": "job_...", "repairImpact": { "destroys": true, "editedGroups": 4,
             "groupCount": 12, "lastHumanEditAt": "2026-08-07T13:20:11.004Z" } }
```

`allowedCommands[]` is the row of §3.4's matrix for the run's current state. It exists so a
platform can grey a button without re-implementing the matrix.

### 2.5 What an error never contains

No host absolute path (plan §9.2), no Claude credential, no document content, no line item, no
stack trace, no SQL, no internal exception message. `internal_error`'s `message` is a fixed
Thai string. This is plan §18's logging rule applied to the response body, where it matters
more.

---

## 3. The workflow state machine

This is the machine in `console/sequencer/logic.ts` plus the scheduler dimension in
`console/app/orchestrator.ts`, written as a machine. It invents nothing: every transition
below is traceable to a line of the runtime, and the plan's §12.2 forbids changing stage
order, status names, retry counts, gates, or completion checks.

### 3.1 Two axes, not one

A run's observable condition is a **pair**: a sequencer status and a scheduler position.
Collapsing them loses information the platform needs — plan §9.3 says so and this document
enforces it.

**Axis A — sequencer status** (`console/sequencer/logic.ts:117-127`), ten values:

| Status | Meaning | Terminal? |
|---|---|---|
| `idle` | At a rest point, about to run `stage[stageIndex]`. Also the state of a run that has never started | no — resumable |
| `stage-running` | The stage's own process is running | transient, in-memory only **[C-09]** |
| `gate-running` | The completion check is running | transient, in-memory only **[C-09]** |
| `blocked` | Completion check exited 1; retries remain | no — retryable |
| `env-error` | Completion check exited 2, or the stage process failed; retries remain | no — retryable |
| `fatal-cleanup` | A process group could not be proven dead | **yes**, and it latches the whole service |
| `stopped` | Cancelled by an operator or by shutdown | **yes** |
| `stopped-for-human` | `human-stop.yaml` has entries | **yes** — never auto-cleared |
| `blocked-for-human` | Retries exhausted, or `final`'s gate failed (never retried) | **yes** |
| `done` | The `final` gate passed | **yes** |

`TERMINAL_STATUSES = ["done", "fatal-cleanup", "stopped", "stopped-for-human",
"blocked-for-human"]` (`logic.ts:134`). "Terminal" means the sequencer will not move on its
own and a restart will not resume it (`run-store.ts:7-17`) — it does **not** mean the run is
finished with, and three of the five are exactly the human-pause states §23.3 asks about.

**Axis B — scheduler position** (`orchestrator.ts:95-103`), two booleans:

| | Meaning |
|---|---|
| `queued: true` | The `relPath` is in the FIFO array, waiting for a slot |
| `active: true` | The `relPath` holds a concurrency slot and its drive loop is running |

They are never both true. Both false means "not scheduled" — the run is at rest, whatever its
status.

**Axis C — existence**, for completeness: a job may be registered with no `run-state.yaml` at
all. That is `hasRunRecord: false`, reported as `idle` (§1.7), and it is what
`toDisplayStatus(null)` already returns (`dashboard.ts:80`).

### 3.2 The transition table

Every legal transition. `→` is a status change; the **Event** column is the SSE event Core
emits (§6.2). Transitions marked *(scheduler)* change only axis B.

| # | From | To | Trigger | Where | Event |
|---|---|---|---|---|---|
| T1 | *(no job)* | job registered, `idle`, `hasRunRecord:false` | `POST /v1/jobs` or `POST /v1/jobs/resolve` | job module | `job.created` |
| T2 | `idle`, not scheduled | *(scheduler)* `queued:true` | `POST …/start`, or `retry`, or `repair`, or boot re-queue | `orchestrator.ts:184-190` | `run.queued` + `queue.changed` |
| T3 | `queued:true` | *(scheduler)* `active:true` | A slot frees and `pump()` admits the head of the queue | `orchestrator.ts:121-141` | `run.started` + `queue.changed` |
| T4 | `idle` + `active` | `stage-running` *(transient)* | `runStage()` begins the stage process | `logic.ts:301-304` | `run.status_changed` **[C-09]** |
| T5 | `stage-running` | `gate-running` *(transient)* | The stage process succeeded; `settle()` begins | `logic.ts:190-204` | `run.status_changed` **[C-09]** |
| T6 | `gate-running` | `idle`, `stageIndex+1`, `retryCount:0` | Completion check exit 0, and this is not the last stage | `logic.ts:164-173,215` | `run.progress_changed` |
| T7 | `gate-running` | `done` | Completion check exit 0 on `final` | `logic.ts:164-173` | `run.completed` |
| T8 | `gate-running` | `stopped-for-human` | `human-stop.yaml` has ≥1 entry (checked **before** the gate) | `logic.ts:195-202` | `run.status_changed` + `human_action.requested` |
| T9 | `gate-running` | `blocked` | Gate exit 1 and `retryCount < 2` | `logic.ts:227-232` | `run.status_changed` |
| T10 | `gate-running` | `blocked-for-human` | Gate exit 1 and retries exhausted, **or** gate exit 1/2 on `final` (which never retries) | `logic.ts:217-224,233-236` | `run.status_changed` + `human_action.requested` |
| T11 | `gate-running` | `env-error` | Gate exit 2 and `retryCount < 1` | `logic.ts:240-244` | `run.status_changed` |
| T12 | `gate-running` | `blocked-for-human` | Gate exit 2 and retries exhausted | `logic.ts:245-248` | `run.status_changed` + `human_action.requested` |
| T13 | `stage-running` | `env-error` | The stage process failed and `retryCount < 1` | `logic.ts:283-287` | `run.status_changed` |
| T14 | `stage-running` | `blocked-for-human` | The stage process failed, retries exhausted | `logic.ts:288-291` | `run.status_changed` + `human_action.requested` |
| T15 | `stage-running` or `gate-running` | `fatal-cleanup` | A process group could not be proven dead | `logic.ts:207-212,268-273` | `run.failed` + `queue.changed` (every other active run is aborted) |
| T16 | `stage-running` or `gate-running` | `stopped` | The run's `AbortSignal` fired mid-attempt | `logic.ts:192,196,213,260,274` | `run.stopped` |
| T17 | `queued:true`, any status | `stopped` | `POST …/stop` on a queued run — removed from the queue and marked stopped | `orchestrator.ts:280-295` | `run.stopped` + `queue.changed` |
| T18 | `active:true` | `stopped` | `POST …/stop` on an active run — abort, then wait for the child group to exit | `orchestrator.ts:298-300` | `run.stopped` |
| T19 | `blocked` or `env-error` | *(scheduler)* `queued:true` | `POST …/retry` — the same stage is re-invoked from scratch, `retryCount+1` | `orchestrator.ts:241-250`, `logic.ts:311-322` | `run.queued` + `human_action.resolved` if it was human-paused |
| T20 | any not-queued, not-active status | `idle` at `stageIndex = segment(1)`, `retryCount:0`, then `queued` | `POST …/repair` — a **full pipeline restart from Stage 1** | `orchestrator.ts:252-274` | `run.status_changed` + `run.queued` |
| T21 | any not-queued, not-active status | as T20 | The `keep` exclusion decision, which calls `repairRun` after writing the disposition | `server.ts:512-530` | as T20 |
| T22 | `queued:true` | `stopped` | Graceful shutdown drains the queue | `orchestrator.ts:306-317` | `run.stopped` |
| T23 | `active:true` | `stopped` | Graceful shutdown aborts active attempts | `orchestrator.ts:318-323` | `run.stopped` |
| T24 | `idle` (persisted), not scheduled | *(scheduler)* `queued:true` | **Boot.** Every persisted `idle` record is re-queued | `orchestrator.ts:201-207` | `run.queued` after the snapshot |
| T25 | `stopped-for-human` | `idle` | *(out of band)* a human archives `human-stop.yaml`, then issues `repair` | `logic.ts:64` (never cleared by the sequencer) | as T20 |

**`retry` is the only transition that spends a retry.** `stop` never spends one
(`logic.ts:124`). `repair` resets the counter to zero because it builds a fresh `initialState()`
(`orchestrator.ts:265`).

### 3.3 Transitions that do not exist

Stated explicitly, because "what the API returns when a client attempts one" is only
answerable if the illegal set is named.

| Attempted | Why it is illegal | API response |
|---|---|---|
| `start` on `stage-running`/`gate-running` (i.e. `active`) | A second drive loop for one `relPath` would write `run-state.yaml` twice | `409 run_not_startable`, `details.currentStatus`, `allowedCommands: ["stop"]` |
| `start` on `done` | The run is complete; re-running is `repair`, which is a different intent | `409 run_not_startable` — message `"งานนี้เสร็จสมบูรณ์แล้ว"` (`orchestrator.ts:226-227`) |
| `start` on `blocked`/`env-error` | These are retryable, not startable — `retry` preserves the retry count and the stage; `start` would not | `409 run_not_startable` — message `"ลูกค้ารายนี้มีการรันค้างอยู่แล้ว ใช้ปุ่มลองใหม่แทน"`, `allowedCommands: ["retry","repair","stop"]` |
| `start` on `stopped`/`stopped-for-human`/`blocked-for-human`/`fatal-cleanup` | Terminal. A human must act first | `409 run_not_startable`, `allowedCommands` per §3.4 |
| `retry` on anything but `blocked`/`env-error` | `retryStage()` no-ops on every other status (`logic.ts:312`); the orchestrator refuses before reaching it | `409 run_not_retryable` |
| `retry` on `stopped-for-human`/`blocked-for-human` | Deliberately terminal: "a human must intervene first" (`logic.ts:309-310`) | `409 run_not_retryable`, `allowedCommands: ["repair","stop"]` |
| `repair` while `queued` or `active` | Repair rewrites `run-state.yaml` under a live writer | `409 run_not_repairable` |
| `stop` on a run that is neither queued nor active | There is nothing to cancel | `409 run_not_running` |
| Any of `start`/`retry`/`repair` while the `fatal-cleanup` latch is set | No work may start until the container is restarted | `503 halted_fatal_cleanup` (`orchestrator.ts:220,242,253`) |
| Advancing `stageIndex` without a passing completion check | **Structurally impossible.** `advance()` is private and reached only from an exit-0 (`logic.ts:15-19,164-173,215`) | no route exists |
| Writing a Gate record, signing, advancing a Phase | Core has no model for any of it (plan §2.3, §20) | no route exists |

The last two rows are the ones worth keeping in a test: they are guarantees of the shape of
the code, not of a check somebody remembered to write.

### 3.4 Command legality matrix

The row a client gets back as `details.allowedCommands`.

| State | `start` | `retry` | `repair` | `stop` | exclusion decision / group PATCH |
|---|:--:|:--:|:--:|:--:|:--:|
| no run record (`hasRunRecord:false`) | ✅ | ❌ | ✅ | ❌ | ❌ (nothing to review) |
| `idle`, not scheduled | ✅ | ❌ | ✅ | ❌ | ✅ |
| `queued` | ✅ *no-op* **[C-12]** | ❌ | ❌ | ✅ | ❌ `run_busy` |
| `active` (`stage-running`/`gate-running`) | ❌ | ❌ | ❌ | ✅ | ❌ `run_busy` |
| `blocked` | ❌ | ✅ | ✅ | ❌ | ✅ |
| `env-error` | ❌ | ✅ | ✅ | ❌ | ✅ |
| `stopped` | ❌ | ❌ | ✅ | ❌ | ✅ |
| `stopped-for-human` | ❌ | ❌ | ✅ | ❌ | ✅ |
| `blocked-for-human` | ❌ | ❌ | ✅ | ❌ | ✅ |
| `done` | ❌ | ❌ | ✅ | ❌ | ✅ |
| `fatal-cleanup` | ❌ 503 | ❌ 503 | ❌ 503 | ❌ | ✅ (reads and review writes are unaffected) |

**[C-12] `start` on an already-queued run is a success, not a conflict.** It returns `200`
with `alreadyQueued: true` and enqueues nothing. *Rationale: this is exactly what the runtime
does — a queued run's persisted status is `idle`, so `enqueueRun` passes its resumability
check and `enqueueForProcessing` then de-duplicates on `queue.includes(relPath)`
(`orchestrator.ts:186`). Reporting a conflict would contradict the runtime, and reporting
success is what makes the double-clicked `เริ่มรัน` safe even before the idempotency key is
consulted.*

**A ✅ in the `repair` column is a statement about the state machine, not a promise that a
bare `POST` succeeds.** When the run has human review work to lose, `repair` additionally
requires `acknowledgeDiscard: true` in the body (**[C-40]**, §5.8) and is otherwise
`409 repair_not_acknowledged`. That is a guard on an unrecoverable write, not a transition
rule, so `repair` still appears in `allowedCommands` — the numbers a screen needs in order to
ask are in `repairImpact` (**[C-38]**), on the same read.

### 3.5 The human-pause states, filled in (plan §23.3)

Plan §23.3 records that the mock has no notion of a run that pauses for a human, and that
filling it is an implementer's job. This is the fill, and it is deliberately confined to what
§7 and §9.1 already provide — **no new route, no new capability**.

There are three pause states and they are not the same thing:

| State | What happened | What clears it | Who must act |
|---|---|---|---|
| `blocked` | A completion check failed and retries remain | `retry` — the platform may offer it, and the CLI has it | Nobody, strictly: it is a retryable failure. Surface it, do not alarm |
| `blocked-for-human` | Retries are exhausted, or `final` failed and is never retried | Fixing the underlying gap, then `repair` | A reviewer. There is nothing to retry |
| `stopped-for-human` | `human-stop.yaml` carries ≥1 hard-blocker entry, written by a stage that hit a Stop rule | A human archiving `human-stop.yaml` **outside Core** (`logic.ts:64` — the sequencer never clears it), then `repair` | A reviewer, and the entries say what and why |

What the API gives the platform for each:

1. The run object carries `humanStop[]` — `{ stage, unit, condition, reason }` per entry —
   so the platform can render *what* stopped it rather than a bare state.
2. Core emits `human_action.requested` on entry to `stopped-for-human` or `blocked-for-human`
   (§6.2), carrying the same entries plus the stage. Plan §10.3 lists this event with "No
   mock counterpart. See §23.3" — this is its payload.
3. Core emits `human_action.resolved` when the run leaves either state by any route (`repair`,
   `stop`, `retry` where legal). That is what lets the platform clear a notification it
   raised, rather than leaving one that never resolves.
4. **[C-13] Core exposes no route to resolve a human stop.** Resolution is `repair` after the
   human has done the out-of-band thing. *Rationale: `human-stop.yaml` is a Ledger-Gate
   artifact whose clearing is a human declaration (`logic.ts:63-64`); §9.1's route table has
   no route for it, and inventing one would be Core acquiring an opinion about human review it
   does not have. `repair` already exists and already does the right thing.* The office
   platform's screen for this is a platform design question and stays out of scope here; the
   contract it needs is complete. **The captain reviewed and accepted this on 2026-08-07,
   together with its cost — see §5.8's `[captain 2026-08-07]`.**

The one thing an implementer must not do: treat `stopped-for-human` as a failure. Plan §9.3
maps `env-error`/`fatal-cleanup`/`stopped` onto the mock's `failed`, and leaves the three
pause states explicitly unmapped — they need the platform's fifth display state, and a run in
`stopped-for-human` has produced valid artifacts up to that point.

§3.6 pins *what* may stop a run; §3.7 pins *where* each stop is recorded.

### 3.6 The stop conditions — a closed set, pinned in the contract

`stopped-for-human` has exactly one producer: a stage appends an entry to
`ข้อมูลระบบ/_pages/human-stop.yaml` (schema `ksk_human_stop.v1`) and `settle()` reads that file
**before** the completion check (`logic.ts:195-202`, T8). What may legitimately appear there is
fixed by `.claude/skills/ksk-keying/references/decision-policy.md` → **Stop rules**, which
names three hard blockers and states in as many words that everything else in the policy
"never writes here; this file is exclusively for the three stop conditions above".

Until this revision the spec referenced that mechanism and never pinned the set, so a fourth
value added to the policy file would have reached the office platform's screen as a string the
screen does not recognise, and a person would have been shown a state with no instruction.

**[C-36] `condition` is a closed three-value enumeration in the API contract, and Core carries
a person-facing Thai `message` and `remedy` for each.** *Rationale: the policy file is the
source of the rule, but a policy file is not a wire contract — a platform cannot switch
exhaustively on a set that is only implied. Pinning it here means adding a fourth blocker is a
deliberate two-part change (one row in this table, one deploy) instead of a silent widening,
and carrying the Thai text in Core follows **[C-02]**: the accountant reading the screen and
the operator reading `keying jobs show` get the same sentence, and the platform is not asked to
maintain a private translation of a set it does not own.*

| `condition` | What it means (source: decision-policy.md → Stop rules) | `message` — what the person is shown | `remedy` — what the person does |
|---|---|---|---|
| `no_coa_source` | The client has **no** `coa.csv` **and** no ผังบัญชี workbook anywhere in the client folder, so the run cannot map a single line to an account. Client-wide: `unit` is `null` | `"ยังไม่มีผังบัญชีของลูกค้ารายนี้ ระบบจึงลงบัญชีให้ไม่ได้เลย"` | `"วางไฟล์ coa.csv หรือไฟล์ผังบัญชี (.xlsx/.xls) ไว้ในโฟลเดอร์ของลูกค้า — ระดับลูกค้า ไม่ใช่ระดับเดือน — แล้วเก็บ human-stop.yaml และสั่งรันใหม่"` |
| `unreadable_required_source` | A required source file is missing or unreadable, so the page named in `unit` can never reach a terminal state. `unit` names the file or `file#pN` | `"เปิดไฟล์ «<unit>» ไม่ได้ หรือไฟล์หายไป จึงตรวจเอกสารใบนี้ต่อไม่ได้"` | `"หาไฟล์ตัวจริงมาวางทับที่เดิม (สแกนใหม่ หรือขอจากลูกค้า) ถ้าเอกสารใบนี้ไม่ต้องลงบัญชีจริง ๆ ให้เอาออกจากโฟลเดอร์เดือนนั้น แล้วเก็บ human-stop.yaml และสั่งรันใหม่"` |
| `no_rule_ambiguity` | Two policy rules give contradicting answers for the same money and the difference **materially changes the books** — the one class of question the policy refuses to answer by default. `unit` names the segment or group in dispute; `reason` states both readings | `"รายการนี้ลงบัญชีได้สองทางที่ขัดกัน และนโยบายยังไม่ได้ตัดสินว่าให้ยึดทางไหน"` | `"อ่านเหตุผลที่ระบบเขียนไว้ เลือกแนวทาง แล้วบันทึกเป็นข้อตกลงของลูกค้ารายนี้ใน CLIENT.md (หัวข้อ conventions) — ถ้าเป็นเรื่องที่ใช้กับทุกลูกค้า ให้แก้ที่ decision-policy.md — แล้วเก็บ human-stop.yaml และสั่งรันใหม่"` |

The messages are written for an accountant, not an engineer: each says what to go and fix, and
none of them names a stage, an exit code, or a file the pipeline owns. `<unit>` is substituted
verbatim (Thai filenames included) at read time. The strings are Core's and version with Core's
code; a platform that wants its own wording maps `condition`, exactly as **[C-02]** intends.

The entry, on the wire, wherever `humanStop[]` appears (§1.7):

```json
{
  "stage": "interpret",
  "unit": "เอกสารรายจ่าย/true-6908.pdf#p7",
  "condition": "unreadable_required_source",
  "conditionRaw": "unreadable_required_source",
  "reason": "invoice.pdf page 6 is corrupted — pdfinfo cannot read it; no other source for this transaction",
  "message": "เปิดไฟล์ «เอกสารรายจ่าย/true-6908.pdf#p7» ไม่ได้ หรือไฟล์หายไป จึงตรวจเอกสารใบนี้ต่อไม่ได้",
  "remedy": "หาไฟล์ตัวจริงมาวางทับที่เดิม (สแกนใหม่ หรือขอจากลูกค้า) …"
}
```

`stage`, `unit` and `reason` are the artifact's own bytes, untouched. `condition`,
`conditionRaw`, `message` and `remedy` are Core's, derived on read.

**[C-37] An unrecognised `condition` is surfaced as unrecognised — never rejected, never
dropped, never passed through as if it were known.** Concretely, when the value in the YAML is
not one of the three:

1. **The run's status is unaffected.** It is `stopped-for-human` because the file has entries,
   which is a fact about the file, not about whether Core recognises the label. Visibility of
   the stop never depends on Core understanding it.
2. `condition` is `null` and `conditionRaw` carries the value **verbatim**. A client switching
   on `condition` therefore lands in its own default branch instead of matching nothing
   silently; §1.3's `null` reads correctly here — *the contract condition is known to be absent*.
3. `message` and `remedy` are the fixed fallback pair:
   `"งานนี้หยุดรอคน ด้วยเหตุผลที่ระบบรุ่นนี้ยังไม่รู้จัก (<conditionRaw>)"` /
   `"อ่านข้อความในช่อง «เหตุผล» ซึ่งเป็นสิ่งที่ขั้นตอนนั้นเขียนไว้เอง จัดการต้นเหตุตามนั้น แล้วแจ้งผู้ดูแลระบบว่าพบเงื่อนไขใหม่ «<conditionRaw>» เพื่อเพิ่มเข้าสัญญา"`.
   The person still gets the stage's own `reason`, which is the part written for this specific
   incident, plus an instruction that ends with somebody being told the contract has drifted.
4. One `warn` log line, `event=run.human_stop.unknown_condition`, carrying `conditionRaw` —
   §3.7's third row. That is the line an operator greps when the platform starts showing the
   fallback.

*Rationale: three other behaviours were available and each fails the captain's requirement.
Returning `422 artifact_malformed` hides a run that has genuinely stopped behind an error on
the read route — the run becomes invisible exactly when a person is needed. Dropping the
unrecognised entry turns a hard blocker into silence, which is the one outcome the Stop-rules
design exists to prevent. Passing the raw string through as `condition` is what the closed
enumeration is for: it makes an unknown value indistinguishable from a known one and leaves the
screen with nothing to say. Keeping the run visible, naming the raw value in the response and
in the log, and telling the person both what the stage said and whom to tell, is the only
option where the person still learns there is something to fix **and** the maintainer learns
the contract needs a fourth row.*

Adding a fourth condition is therefore a contract change, not a policy edit: one row in the
table above, one deploy. Until it lands, **[C-37]** is what a person sees — degraded, but
never silent.

### 3.7 Where a stop is recorded — the three places, in one place

The captain's question is "how does a person find out what actually went wrong, so they can go
and fix it". It has one answer, here, rather than a sentence per route.

| # | Surface | What carries the stop | Read by | Survives? |
|---|---|---|---|---|
| 1 | **The run object** — `GET /v1/jobs/{jobId}` (§5.5), `GET /v1/jobs` (§5.3), `GET /v1/runs` (§5.10), `GET /v1/runs/{runRef}` (§5.14), and every SSE `run.snapshot` | `status: "stopped-for-human"`, `humanStop[]` (§3.6's enriched entries), `failReason` (the joined conditions, `dashboard.ts:86-93`), `allowedCommands: ["repair"]` | The office platform's run screen; `keying jobs show` | Until a human archives `human-stop.yaml`. It is the **total** surface: a platform that missed every event finds the stop here, which is what §6.4 relies on |
| 2 | **The event** `human_action.requested` (§6.2), emitted on entry to the state (T8) | `kind: "human_stop"`, `stage`, `entries[]` — byte-identical to `humanStop[]` — and `resolvableBy: ["repair"]` | The platform's gateway, which turns it into a notification to assignee + `startedBy`; `keying jobs watch` | **Not journalled** (**[C-19]**, §21). If nobody was subscribed it is gone, and surface 1 is the recovery — plan §10.2's "late, never silent" |
| 3 | **The log**, one structured line per entry, `warn`, written the moment `settle()` detects the entries | `event=run.human_stop jobId=… workspaceRelPath=216/69-08 stage=interpret unit="…#p7" condition=unreadable_required_source conditionKnown=true reason="…" streamId=… seq=…`, and `event=run.human_stop.unknown_condition` for **[C-37]** | The operator, at the container's log | **The only one that survives the resolution.** Once the human archives `human-stop.yaml` and repairs, surfaces 1 and 2 are empty by design — the log is the sole record that this client-month ever stopped, and why |

Three rules that follow, and that a test should hold:

- **A stop is written to all three, always, in that order** — projection, then event, then log —
  so a log line without a projection is a bug, not a race. `human_action.resolved` (§6.2) closes
  surface 2's loop when the run leaves the state by any route, which is what lets the platform
  clear a notification instead of leaving one that never resolves.
- **`message`/`remedy` are for people; `reason`/`failReason` are for logs.** A screen that shows
  `failReason` to an accountant is showing them a sequencer log line. §3.6 exists so it does not
  have to.
- **Plan §18's redaction rules apply to the log line unchanged**: `unit` is workspace-relative
  and never a host absolute path, `reason` is the stage's own sentence and nothing is added to
  it, and no credential or document content appears. A stop is the one place where the
  temptation to log the document is strongest and the rule does not bend.

> **needs-decision:** pinning §3.6 surfaced one gap between the two halves of the loop, and it
> is recorded rather than resolved here because the resolution is not this document's to pick.
> A person now learns *exactly* what to fix (§3.6) and where to read it (§3.7) — but clearing a
> `stopped-for-human` still takes **two** out-of-band acts: fixing the underlying gap, **and**
> archiving `human-stop.yaml`, which the sequencer never does (`logic.ts:64`) and for which
> **[C-13]** deliberately exposes no route. A repair that skips the second one re-stops the run
> at the next gate (§5.8). So an accountant working only inside the office platform can be told
> what to fix, can be shown the `รันใหม่` button, and still cannot complete the resolution
> without filesystem access to the workspace. Three ways out exist and each is somebody else's
> call: **(a)** accept it — clearing a Ledger-Gate artifact stays a deliberate act by whoever
> has the workspace, and the platform's screen says so; **(b)** the office platform gains its
> own way to reach the workspace, which is a platform decision under §10 and not a Core route;
> **(c)** Core gains a route to archive `human-stop.yaml`, which reopens **[C-13]** and is a
> plan revision. Nothing in this document assumes any of the three, and the contract above is
> complete under all of them.

---

## 4. Concurrency, the queue, and restart

Plan §15 phase 2's exit criterion is "no duplicate workflow and no accepted command loss".
These are the rules that deliver it.

### 4.1 What "concurrency one" means, precisely

`KSK_APP_CONCURRENCY` (default `1`, `console/app/config.ts:16-17`) bounds **the number of
`relPath`s whose drive loop is executing a stage process or a completion check at one
instant**. It is not a bound on registered jobs, queued jobs, HTTP requests, review reads, or
review writes — all of those are unbounded and unaffected.

Precisely:

- `pump()` admits from the queue while `activeSlots.size < concurrency`
  (`orchestrator.ts:123`).
- A slot is taken the moment a run is admitted and released the moment its drive loop returns
  (`orchestrator.ts:126,132-138`).
- **A run that pauses releases its slot immediately.** `blocked`, `env-error`,
  `stopped-for-human`, `blocked-for-human`, `done`, `stopped`, `fatal-cleanup` all end the
  drive loop (`orchestrator.ts:178-181`). One stuck client-month can never hold the queue.
- Only `idle` continues the loop, which is what makes a whole run — seven stages — occupy one
  slot for its duration without re-queuing between stages.
- The workspace has **one writer** at a time per client/month by construction: a `relPath`
  cannot be admitted twice (`orchestrator.ts:186`, `orchestrator.ts:125`).

### 4.2 Ordering

- The queue is a **FIFO array**; `pump()` shifts from the head (`orchestrator.ts:124`).
- Admission order is enqueue order. There is no priority, no fairness weighting, and no
  starvation risk beyond "a long run holds its slot for its duration".
- **A start command for a job already in the queue does not move it.** The de-duplication at
  `orchestrator.ts:186` means the second command is a no-op **[C-12]**, so a client cannot
  jump the queue by re-clicking.
- **A start command for an active job is refused** (`409 run_not_startable`), so it cannot
  queue behind itself.
- `retry` and `repair` re-enter the queue **at the tail**, exactly like a new run
  (`orchestrator.ts:12-18` states this as the policy). A retry does not resume a reserved
  slot.

### 4.3 Restart: what happens to queued versus active work

The queue is in memory and is **not** persisted; `run-state.yaml` is (`run-store.ts:1-5`).
The rules follow from that:

| At the moment of restart | On disk | After boot |
|---|---|---|
| Queued, never started | `idle` (or absent) | **Re-queued** (`orchestrator.ts:205`) |
| Queued, then stopped by graceful shutdown | `stopped` | **Not** re-queued — terminal (`orchestrator.ts:306-317`) |
| Active, mid-stage, killed hard | `idle` at the last rest point | **Re-queued**, and the stage re-runs from scratch. Safe because every `ksk-stage-*` skill is self-sufficient from on-disk artifacts (`run-store.ts:7-17`) |
| Active, aborted by graceful shutdown | `stopped` | **Not** re-queued |
| Paused (`blocked`, `env-error`, human-pause, `done`, `fatal-cleanup`) | that status | **Not** re-queued. A restart must not paper over a state that already requires a human (`run-store.ts:13-17`) |

**[C-14] Re-queue order after a restart is workspace scan order, not the pre-restart enqueue
order.** Boot walks clients then months, both sorted with `localeCompare(…, "th")`
(`workspace.ts:22-28`, `orchestrator.ts:201-206`). *Rationale: the enqueue order is not
persisted anywhere and persisting it would be a new durable ordering table, which plan §8.2
forbids ("do not add event history … to Core's schema"). Scan order is deterministic, which is
what matters for a restart drill; it is simply not the same order.* Stated so an operator is
not surprised that the run that was next before the restart is not next after it. It costs no
correctness: §4.4's duplicate rule and the receipt reconciliation are what protect the exit
criterion, not the order.

The `fatal-cleanup` latch is **process-local and cleared by the restart itself**
(`orchestrator.ts:196-198`), but the run's persisted `fatal-cleanup` status survives. So after
a restart the service accepts commands again while that particular run still requires an
explicit `repair`. Both halves of that are deliberate.

### 4.4 Why "no duplicate workflow and no accepted command loss" holds

Four independent mechanisms, each of which must be tested (plan §16 lists the tests):

1. **No duplicate run per client/month, in-process.** `activeSlots` and `queue.includes()`
   make a second admission impossible (`orchestrator.ts:125,186`). This is the mechanism that
   holds even if idempotency is bypassed entirely.
2. **No duplicate run across a retried HTTP call.** The idempotency key (§1.5): a replay
   returns the original receipt and enqueues nothing (plan §8.4).
3. **No accepted command lost across a crash.** The receipt is committed **before** the
   orchestrator call (plan §8.4); boot step 4 reapplies pending receipts idempotently and
   marks a receipt applied when the run record already proves the transition happened.
4. **No workflow duplicated by that reapplication.** Reapplication goes through the same
   `enqueueRun`, so mechanism 1 catches it.

The failure the four are jointly designed against is the one plan §8.4 names: the platform's
`เริ่มรัน` button is one click from a user who cannot see whether the first click landed.

### 4.5 What concurrency does *not* protect

Two honest limits, both already true today and neither introduced here:

- **Two different client/months on the same client** can be admitted concurrently if
  `concurrency > 1`. Client-scoped artifacts (`coa_usage.json`, `learning-notes.md`) are
  written by the learn flow, which already refuses while any month of that client is busy
  (`server.ts:543-544`). Nothing else in the pipeline writes client-scoped state mid-run.
- **`concurrency` is not a cost limit.** It bounds concurrent Claude invocations, which is why
  plan §23.8 says measure before raising it.

---

## 5. The routes

All 21 rows of plan §9.1's table, in the plan's own order, none dropped. (The plan's prose
calls it a route list; the table carries exactly 21 rows and all 21 are below.)

Conventions for this section: every route is authenticated per §1.1 and may return `401
unauthorized`, `503 not_ready` (except §5.1) and `500 internal_error`; those three are not
repeated per route. Every listed status code is one the route can actually return.

| § | Method | Path | Kind |
|---|---|---|---|
| 5.1 | `GET` | `/v1/health/live` | query |
| 5.2 | `GET` | `/v1/health/ready` | query |
| 5.3 | `GET` | `/v1/jobs` | query |
| 5.4 | `POST` | `/v1/jobs` | command (idempotent by uniqueness) |
| 5.5 | `GET` | `/v1/jobs/{jobId}` | query |
| 5.6 | `POST` | `/v1/jobs/{jobId}/start` | **command** |
| 5.7 | `POST` | `/v1/jobs/{jobId}/retry` | **command** |
| 5.8 | `POST` | `/v1/jobs/{jobId}/repair` | **command** |
| 5.9 | `POST` | `/v1/jobs/{jobId}/stop` | **command** |
| 5.10 | `GET` | `/v1/runs` | query |
| 5.11 | `GET` | `/v1/jobs/{jobId}/events` | stream |
| 5.12 | `GET` | `/v1/events` | stream |
| 5.13 | `POST` | `/v1/jobs/resolve` | command (idempotent by uniqueness) |
| 5.14 | `GET` | `/v1/runs/{runRef}` | query |
| 5.15 | `GET` | `/v1/runs/{runRef}/review` | query |
| 5.16 | `GET` | `/v1/runs/{runRef}/exclusions` | query |
| 5.17 | `POST` | `/v1/runs/{runRef}/exclusions/{unit}/decision` | **command** |
| 5.18 | `PATCH` | `/v1/runs/{runRef}/groups/{groupId}` | **command** |
| 5.19 | `GET` | `/v1/runs/{runRef}/documents/{unit}` | query (bytes) |
| 5.20 | `GET` | `/v1/clients/{clientKey}/coa` | query |
| 5.21 | `GET` | `/v1/runs/{runRef}/export` | query (bytes) — **not safe**, see §5.21 |

---

### 5.1 `GET /v1/health/live`

Process liveness only. No auth required, no dependency touched — it must answer while SQLite
is migrating and the orchestrator is still reconciling.

**Parameters** none. **Body** none.

**200**
```json
{ "status": "live", "service": "keying-core", "streamId": "ksk-core-01J8Z9F3", "startedAt": "2026-08-07T08:00:01.004Z" }
```

`streamId` is the process-instance id that also stamps every SSE envelope (plan §10.1); a
client that sees it change knows the process restarted.

**Status codes** — `200` only. This route never returns `503`; that is what makes it a
liveness probe rather than a second readiness probe.

---

### 5.2 `GET /v1/health/ready`

Migrations applied, workspace root validated, orchestrator boot and reconcile complete
(plan §8.4 steps 1–6). Carries the workspace warning list **[r3]**.

**Parameters** none.

**200 — ready**
```json
{
  "status": "ready",
  "streamId": "ksk-core-01J8Z9F3",
  "checks": {
    "sqlite": { "ok": true, "schemaVersion": 1, "journalMode": "wal" },
    "workspace": { "ok": true, "root": "/workspace", "clients": 113, "months": 1284 },
    "orchestrator": { "ok": true, "reconciledAt": "2026-08-07T08:00:04.771Z", "pendingRequests": 0 },
    "buddhistCentury": { "base": 2500, "window": "2500-2599", "expiresOn": "2057-01-01" }
  },
  "queue": { "depth": 2, "active": 1, "concurrency": 1 },
  "warnings": [
    { "code": "month_folder_ignored", "clientKey": "216", "name": "69-8",
      "message": "ชื่อโฟลเดอร์เดือนไม่ตรงรูปแบบ YY-MM จึงข้ามไป" },
    { "code": "month_folder_ignored", "clientKey": "ศรีชัย", "name": "69-08 (แก้ไข)",
      "message": "ชื่อโฟลเดอร์เดือนไม่ตรงรูปแบบ YY-MM จึงข้ามไป" }
  ]
}
```

Rules, all from plan §9.2 **[r3]**:

- `warnings[]` names **every** skipped non-matching month directory, `name` **verbatim** — a
  trailing space or a full-width digit must be visible, not normalised away.
- **Warnings do not make the service un-ready.** `status` stays `"ready"` with a non-empty
  `warnings[]`. A stray folder is an operator problem, not a fault.
- Dot-directories produce **no** warning and are excluded from the walk entirely.
- `warnings[]` is `[]`, never absent, when there is nothing to report.
- `buddhistCentury.base` is `KSK_BUDDHIST_CENTURY_BASE`. Core refuses to boot if it is not a
  multiple of 100, so this route never reports a bad one.

**503 — not ready**
```json
{ "error": { "code": "not_ready", "status": 503, "message": "ระบบยังเตรียมตัวไม่เสร็จ",
  "requestId": "req_...",
  "details": { "checks": { "sqlite": { "ok": true }, "workspace": { "ok": false, "reason": "workspace_root_missing" },
                           "orchestrator": { "ok": false, "reason": "reconcile_in_progress" } } } }
}
```
**[C-15]** The `503` body carries the same `checks` object as the `200`, inside `details`.
*Rationale: an operator reading a failing readiness probe needs to know which check failed;
returning a bare code would send them to the logs for something the probe already knows.*

**Status codes** — `200`, `503`.

---

### 5.3 `GET /v1/jobs`

List keying jobs with their current projection.

**Query parameters**

| Name | Type | Default | Rule |
|---|---|---|---|
| `clientKey` | string | — | Exact match. Repeatable |
| `status` | enum | — | One of the ten §3.1 values, or `queued`/`active`. Repeatable; OR within the parameter |
| `archived` | `true`\|`false`\|`any` | `false` | Archived jobs are hidden by default |
| `hasRunRecord` | `true`\|`false` | — | Filter jobs that have never run |
| `limit` | int 1..500 | `100` | |
| `cursor` | opaque string | — | From the previous page's `nextCursor` |

**[C-16] Pagination is cursor-based and the sort is `(clientKey, monthId)` ascending with
Thai collation.** *Rationale: the office is 113 customers × ~12 months, so a page is a
convenience rather than a necessity, but a stable sort matters — `localeCompare(…, "th")` is
already what the workspace walk uses (`console/app/workspace.ts:26`), and reusing it means the
API order and the CLI order and the disk order are one order.*

**200**
```json
{
  "jobs": [
    {
      "jobId": "job_7Qd2xK9mLp0aRt4Vb8Nc1Z",
      "workspaceRelPath": "216/69-08",
      "clientKey": "216",
      "monthId": "69-08",
      "title": "216 — 69-08",
      "companyName": "บริษัท สองหนึ่งหก จำกัด",
      "archived": false,
      "externalRef": { "projectId": "216-monthly-69-08", "phaseIndex": 1, "workflowKey": "ksk-keying" },
      "createdAt": "2026-08-01T02:11:40.000Z",
      "updatedAt": "2026-08-07T10:02:44.310Z",
      "run": { "...": "the run object of §1.7" }
    }
  ],
  "nextCursor": null,
  "total": 1
}
```

`companyName` is `client_name` from `<clientKey>/CLIENT.md`
(`console/app/workspace.ts:35-41`), or `null`. It is a convenience for the CLI's human output;
the office platform has its own customer record and should not use it.

**Status codes** — `200`, `400 validation_failed`.

---

### 5.4 `POST /v1/jobs`

Register a job bound to a validated client/month. **This is the operator's door** (the CLI's
`keying jobs register`); the office platform uses §5.13 instead, because the platform speaks
`monthKey` and must never construct a keying identity itself (plan §9.2, §9.4).

**[C-17] `POST /v1/jobs` takes `{ clientKey, monthId }` — keying identity — while
`POST /v1/jobs/resolve` takes `{ clientKey, monthKey }` — office identity.** *Rationale: this
is why §9.1 lists both. One route that accepted either would let the platform send a `monthId`
it truncated itself, which plan §9.2 forbids in as many words.* A `workspaceRelPath` form is
**not** accepted here; `POST /api/runs { path }` remains the compatibility route for that
(plan §9.2) and is untouched.

**Request**
```json
{
  "clientKey": "216",
  "monthId": "69-08",
  "title": "216 — 69-08",
  "externalRef": { "projectId": "216-monthly-69-08", "phaseIndex": 1, "workflowKey": "ksk-keying" },
  "requestedBy": "prs_9f31c0"
}
```
`title` and `externalRef` are optional. `externalRef` is stored verbatim and never
interpreted (plan §7.2).

**201 — created** / **200 — already existed**
```json
{ "job": { "...": "as in §5.3" }, "created": true }
```

**Command semantics.** Registering a job that already exists is **not** an error: the route
returns `200` with `created: false` and the existing job, and updates `title`/`externalRef` if
they were supplied and differ. It is idempotent by the `unique workspace_rel_path` constraint
(plan §8.2), which is why the `Idempotency-Key` header is optional here (§1.5). Registration
starts nothing — the job's run is `hasRunRecord: false`.

**Status codes** — `201`, `200`, `400 validation_failed` / `invalid_client_key` /
`invalid_month_id` / `invalid_path`, `404 client_not_found` / `month_folder_not_found`.

---

### 5.5 `GET /v1/jobs/{jobId}`

Job metadata plus authoritative/observed workflow status.

**Path parameters** — `jobId`, opaque; a value that is not a well-formed job id is
`400 validation_failed`, not `404`.

**Query parameters** — `include=queue` adds this job's queue position when it is queued.

**200**
```json
{
  "job": {
    "jobId": "job_7Qd2xK9mLp0aRt4Vb8Nc1Z",
    "workspaceRelPath": "216/69-08",
    "clientKey": "216",
    "monthId": "69-08",
    "title": "216 — 69-08",
    "archived": false,
    "externalRef": { "projectId": "216-monthly-69-08", "phaseIndex": 1, "workflowKey": "ksk-keying" },
    "createdAt": "2026-08-01T02:11:40.000Z",
    "updatedAt": "2026-08-07T10:02:44.310Z",
    "run": { "...": "the run object of §1.7" },
    "queuePosition": null,
    "allowedCommands": ["retry", "repair"]
  }
}
```

`allowedCommands` is the §3.4 row for the run's current state, on every read — so a client
never has to guess and never has to POST to find out.

**Status codes** — `200`, `400`, `404 job_not_found`.

---

### 5.6 `POST /v1/jobs/{jobId}/start`

Start/enqueue the workflow. Wraps `Orchestrator.enqueueRun` (`console/app/orchestrator.ts:219-239`).

**Headers** — `Idempotency-Key` **required**.

**Request**
```json
{ "requestedBy": "prs_9f31c0",
  "externalRef": { "projectId": "216-monthly-69-08", "phaseIndex": 1, "workflowKey": "ksk-keying" } }
```
Both optional. A supplied `externalRef` overwrites the stored one — this is how the platform
re-binds a job to a project after the office data changed.

**202 — accepted**
```json
{
  "receipt": { "requestId": "req_01J8ZC4K7Q", "idempotencyKey": "216-monthly-69-08:1:ksk-keying:3",
               "command": "start", "state": "applied", "acceptedAt": "2026-08-07T10:15:00.212Z" },
  "run": { "...": "run object, queued:true, observedStatus:'queued'" },
  "alreadyQueued": false
}
```

**Command semantics** — the four questions the brief asks, answered:

| Target state | Result |
|---|---|
| No run record, or `idle` and not scheduled | `202`, run enters the queue (T2) |
| **Already queued** | `202` with `alreadyQueued: true`, **nothing enqueued** — **[C-12]**, §3.4 |
| **Already active** | `409 run_not_startable`, `details.currentStatus`, `allowedCommands: ["stop"]` |
| `blocked` / `env-error` | `409 run_not_startable` — use `retry`. Message: `"ลูกค้ารายนี้มีการรันค้างอยู่แล้ว ใช้ปุ่มลองใหม่แทน"` |
| `done` | `409 run_not_startable` — `"งานนี้เสร็จสมบูรณ์แล้ว"` |
| `stopped` / `stopped-for-human` / `blocked-for-human` | `409 run_not_startable` — terminal; `repair` is the way forward |
| `fatal-cleanup` latch set | `503 halted_fatal_cleanup` |

**Idempotency** — a replay of the same key returns the stored receipt and run with
`Idempotency-Replayed: true` and the original status code, including a stored `409`
(**[C-06]**). This is the mechanism that makes the double-clicked `เริ่มรัน` safe even when
the first click's response was lost.

**Status codes** — `202`, `400 idempotency_key_required` / `_invalid` / `validation_failed`,
`404 job_not_found`, `409 run_not_startable` / `idempotency_key_conflict` /
`idempotency_key_in_flight`, `503 halted_fatal_cleanup`.

---

### 5.7 `POST /v1/jobs/{jobId}/retry`

Re-invoke the **current** stage from scratch with a fresh context, spending one retry. Wraps
`Orchestrator.retryRun` (`orchestrator.ts:241-250`) → `retryStage` (`logic.ts:311-322`).

**Headers** — `Idempotency-Key` **required**. **Request** — `{ "requestedBy": "prs_9f31c0" }`, optional.

**202**
```json
{
  "receipt": { "requestId": "req_...", "command": "retry", "state": "applied", "acceptedAt": "..." },
  "run": { "...": "queued:true, retryCount unchanged until the attempt begins" }
}
```

**Command semantics**

| Target state | Result |
|---|---|
| `blocked` or `env-error` | `202`, re-enters the queue **at the tail** (T19). `retryCount` increments when the attempt starts, not when the command is accepted |
| Already queued after an earlier `retry` | `202`, `alreadyQueued: true`, nothing enqueued |
| Anything else — including `stopped-for-human` and `blocked-for-human` | `409 run_not_retryable`. Those two are deliberately terminal: a human must intervene first (`logic.ts:309-310`) |
| `fatal-cleanup` latch set | `503 halted_fatal_cleanup` |

**Retry does not reset the stage or the retry counter.** It re-runs the same stage with
`retryCount + 1`, and when the budget is exhausted the next failure lands in
`blocked-for-human` (T10/T12/T14). A client that wants a clean slate wants `repair`.

**Idempotency** — a replay returns the original receipt; it never spends a second retry. This
is why the platform's key must include an attempt number (plan §8.4): two *intended* retries
need two keys.

**Status codes** — `202`, `400`, `404 job_not_found`, `409 run_not_retryable` /
`idempotency_key_*`, `503 halted_fatal_cleanup`.

---

### 5.8 `POST /v1/jobs/{jobId}/repair`

**A full pipeline restart from Stage 1 (`segment`)**, not from Stage 0. Wraps
`Orchestrator.repairRun` (`orchestrator.ts:252-274`), which writes a fresh `initialState()`
with `stageIndex` set to `segment`, stamps new timestamps, and enqueues.

**Headers** — `Idempotency-Key` **required** (except on a dry run — see **[C-39]**).

**Request**
```json
{ "acknowledgeDiscard": true, "requestedBy": "prs_9f31c0" }
```

| Field | Required | Meaning |
|---|---|---|
| `acknowledgeDiscard` | **when `repairImpact.destroys` is `true`** | "I know this throws away human review work." Absent or `false` in that case → `409 repair_not_acknowledged` (**[C-40]**) |
| `dryRun` | no, default `false` | `true` measures and reports, changes nothing (**[C-39]**) |
| `requestedBy` | no | Audit only (§1.1) |

**202 — repaired**
```json
{
  "receipt": { "command": "repair", "state": "applied", "...": "..." },
  "run": { "status": "idle", "queued": true, "stage": { "id": "segment", "index": 1, "count": 7 },
           "retryCount": 0, "humanStop": [], "startedAt": "2026-08-07T11:02:10.500Z", "version": 18,
           "repairImpact": { "destroys": false, "editedGroups": 0, "groupCount": 0, "lastHumanEditAt": null } },
  "discarded": { "editedGroups": 4, "groupCount": 12, "lastHumanEditAt": "2026-08-07T13:20:11.004Z" }
}
```

**200 — dry run** (`{"dryRun": true}`); nothing is enqueued, no receipt is written
```json
{
  "wouldRepair": true,
  "acknowledgementRequired": true,
  "repairImpact": { "destroys": true, "editedGroups": 4, "groupCount": 12,
                    "lastHumanEditAt": "2026-08-07T13:20:11.004Z" },
  "run": { "...": "the run object, unchanged" }
}
```

**Command semantics**

| Target state | Result |
|---|---|
| Any state that is neither queued nor active | `202`. The run's state is **reset** and re-queued (T20) — provided the acknowledgement rule below is satisfied |
| Would destroy review work, no `acknowledgeDiscard` | `409 repair_not_acknowledged`, `details.repairImpact`. **Nothing is reset**, **[C-40]** |
| `queued` or `active` | `409 run_not_repairable` — repair rewrites `run-state.yaml` under a live writer |
| `fatal-cleanup` latch set | `503 halted_fatal_cleanup`. The latch clears only on a process restart (`orchestrator.ts:196-198`); the run's persisted `fatal-cleanup` status does not, so after the restart `repair` is exactly the command that clears it |
| `dryRun: true`, any state | `200` with the impact and the unchanged run. Even `queued`/`active` answer `200` here — asking what a repair would cost is a read |

**Repair is the resolution path for both human-pause states** (§3.5) and for `stopped`,
`done`, and a post-restart `fatal-cleanup`. It is idempotent in the receipt sense but **not**
in effect: a second repair with a *new* key resets the run again.

#### The cost, and the decision to pay it

⚠ **Repair overwrites `_segments/**`, `_doc_groups/**`, `ตรวจทาน/**` and `run-state.yaml` in
place** (plan §12.2 **[r3]**), so **every human edit made through §5.18 since the last run is
lost, unrecoverably.** There is no undo: §21 removed run history, so there is no prior version
to restore from.

**[captain 2026-08-07] `repair` stands as the resolution path, cost accepted.** Told plainly
that a person who merely supplies one missing file loses all the review work done so far, the
captain answered *"ok repair ก็ได้"*. Recorded here so it is not silently revisited:
**resume-from-stage, partial repair, an edit-preserving repair variant, and any new route to
resolve a stop were considered and are not the design.** Reopening this is a plan revision with
the captain in the room, not an implementer's improvement — and **[C-13]** is the same decision
seen from the other side.

What follows from accepting the cost is the narrow thing this route must do: **a destructive
operation must not be indistinguishable from a harmless one at the API.** Exactly what is
destroyed, and what is not:

| Path | On repair |
|---|---|
| `ข้อมูลระบบ/_segments/**` | **Overwritten** — Stage 1 onward re-runs from scratch |
| `ข้อมูลระบบ/_doc_groups/**` | **Overwritten.** Every §5.18 edit lives here; this is the loss |
| `ตรวจทาน/**` | **Overwritten** — the review pages are regenerated |
| `run-state.yaml` | **Replaced** by a fresh `initialState()` at `segment` (`orchestrator.ts:265`) |
| `ข้อมูลระบบ/_pages/dispositions.yaml` | **Survives.** `merge-dispositions` never overwrites a `declared_by: human` or `agent_policy` entry (`.claude/skills/ksk-keying/scripts/AGENTS.md`), so §5.17 `confirm` decisions are kept |
| `CLIENT.md`, `coa.csv`, `coa_usage.json` | **Survive** — client-scoped, and repair starts at Stage 1, so Stage 0 does not re-run |
| `ข้อมูลระบบ/_pages/human-stop.yaml` | **Survives** — the sequencer never clears it (`logic.ts:64`). Consequence worth a test: **repairing without archiving it first re-stops the run at the very next gate**, because `settle()` reads the file before the completion check (T8). The out-of-band archive in §7.2 step 5 is not a formality |

**[C-38] The run object carries `repairImpact` — what a repair would throw away right now.**
`{ destroys, editedGroups, groupCount, lastHumanEditAt }`. A group counts as *edited* when its
`review-data.json` has been written since the `categorize` stage produced it — the same mtime
comparison **[C-22]** already permits for the `ETag`, so no new bookkeeping is introduced.
`destroys` is `false` exactly when `editedGroups` is `0` (including `hasRunRecord: false`, where
there is nothing on disk to lose). *Rationale: the screen that owns the `รันใหม่` button already
reads the run object; making the cost a field on that read means it can warn without a preflight
call and without re-deriving "has anyone touched this month" from the review routes. It is
absent from the list routes and from SSE (§1.7) because it costs a filesystem read per group and
a dashboard does not need it.*

**[C-39] The same route answers "what would this cost" via `dryRun: true`, returning `200` and
changing nothing.** No receipt is written, nothing is enqueued, and `Idempotency-Key` is
optional — if supplied it is neither consumed nor recorded, so the real command can use it
afterwards. *Rationale: §9.1's route table is fixed and a `GET …/repair-preview` would be a new
route; a body flag on the existing command is the same question asked at the same address. The
`200`/`202` split is the honest signal — `202` means work was accepted, `200` means nothing
happened.*

**[C-40] When `repairImpact.destroys` is `true`, `repair` requires `acknowledgeDiscard: true`
and is otherwise `409 repair_not_acknowledged` with `details.repairImpact`.** When `destroys`
is `false` the field is optional and accepted either way, so the common "nothing to lose"
repair stays a one-line call. *Rationale: **[C-31]** already refuses to let a person at a
terminal destroy review work without being told what they are destroying; an HTTP caller must
not have a weaker guard than the CLI. Making it a `409` rather than a convention turns plan §15
phase 8 step 2's "the run screen must say so" from something a platform is trusted to remember
into something Core can prove it did. The rejection happens before any state is touched, so a
refused repair is a true no-op.* This amends **[C-31]**'s non-interactive half: `keying jobs
repair` without a TTY and without `--yes` now **fails** with exit 6 instead of proceeding
silently (§8.2).

**[C-41] An accepted repair records what it destroyed, in the response, the event, and the
log.** The `202` carries `discarded` (the `repairImpact` measured immediately before the reset);
`run.queued` with `trigger: "repair"` carries the same object (§6.2); and Core writes one `warn`
line, `event=run.repair.discarded jobId=… workspaceRelPath=… editedGroups=4 groupCount=12
lastHumanEditAt=… requestedBy=… acknowledged=true`. *Rationale: the receipt (§1.5) records the
intent, and nothing today records the loss. The moment the stages re-run there is no artifact
left that ever knew those edits existed, and §21 ruled out a run history — so this log line is
the only durable evidence of what a repair cost, and it costs one line. §3.7's third row is the
same argument for a stop.*

**Status codes** — `202`, `200` (dry run), `400`, `404 job_not_found`,
`409 run_not_repairable` / `repair_not_acknowledged` / `idempotency_key_*`,
`503 halted_fatal_cleanup`.

---

### 5.9 `POST /v1/jobs/{jobId}/stop`

Stop queued or active work and **wait for owned processes to exit** before responding. Wraps
`Orchestrator.stopRun` (`orchestrator.ts:276-301`).

**Headers** — `Idempotency-Key` **required**. **Request** — `{ "requestedBy": "..." }`, optional.

**200**
```json
{
  "receipt": { "command": "stop", "state": "applied", "...": "..." },
  "run": { "status": "stopped", "queued": false, "active": false,
           "finishedAt": "2026-08-07T11:20:41.882Z", "version": 19 },
  "stoppedWhile": "active"
}
```

`stoppedWhile` is `"queued"` or `"active"`.

**Command semantics**

| Target state | Result |
|---|---|
| `queued` | `200`. Removed from the queue and marked `stopped` (T17) |
| `active` | `200`, **after** the abort signal fires and the owned child process group is reaped. The response is deliberately slow rather than optimistic — plan §9.1's own wording is "stop … and wait for owned processes to exit" (T18) |
| Neither queued nor active — including already `stopped` | `409 run_not_running` — `"งานนี้ไม่ได้กำลังทำงานอยู่"` |
| No job | `404 job_not_found` |

**Stop never spends a retry** (`logic.ts:124`), and `stopped` is terminal: the run does not
resume on its own and is not re-queued at boot. `retry` from `stopped` is refused; `repair` is
the way back.

**[C-18] `stop` on an already-stopped run is `409`, not a success.** *Rationale: it matches
the runtime exactly (`orchestrator.ts:296`), and the alternative — returning `200` — would
tell a caller it cancelled something it did not.* An idempotent replay is still a replay: the
same key returns the original `200`.

**Status codes** — `200`, `400`, `404 job_not_found`, `409 run_not_running` /
`idempotency_key_*`. **Never** `503 halted_fatal_cleanup`: stopping is exactly what one wants
to be able to do when the latch is set.

---

### 5.10 `GET /v1/runs`

Neutral run summaries with queue/active flags. The difference from §5.3 is the subject:
`/v1/jobs` is job-shaped (metadata first, run nested); `/v1/runs` is run-shaped and only lists
jobs that have a run record.

**Query parameters** — `clientKey`, `status`, `queued`, `active`, `limit`, `cursor`, as §5.3.

**200**
```json
{
  "runs": [ { "...": "run objects of §1.7" } ],
  "queue": { "concurrency": 1, "depth": 2, "active": 1,
             "order": ["ศรีชัย/69-08", "216/69-07"] },
  "nextCursor": null
}
```

`queue.order` is the FIFO array, head first, as `workspaceRelPath` values — the real queue,
not a projection (plan §7.1: "inspect the real queue and active slots"). It is the only place
queue position is observable, and it is a snapshot: two reads a second apart may differ.

**Status codes** — `200`, `400 validation_failed`.

---

### 5.11 `GET /v1/jobs/{jobId}/events`

Per-job SSE. Envelope and delivery semantics are §6.

**Query parameters** — `snapshot` (`true`\|`false`, default `true`).

**200** — `text/event-stream; charset=utf-8`, `cache-control: no-cache`, `connection: keep-alive`.

The first frame is a `run.snapshot` event for this job (§6.3), then live deltas for it only,
then a `: ping` comment every 15 s.

**Status codes** — `200`, `404 job_not_found`. A stream that is open when the job is archived
stays open; archiving is metadata.

---

### 5.12 `GET /v1/events`

Global SSE for the office platform's gateway and for `keying jobs watch`.

**Query parameters** — `clientKey` (repeatable, server-side filter), `snapshot`
(default `true`), `types` (repeatable event-type filter).

**200** — as §5.11, but the snapshot is a `run.snapshot` per job with a run record, followed
by one `queue.changed`, and then live deltas for every job.

**[C-19] `Last-Event-ID` is accepted and ignored; every reconnect re-snapshots.** *Rationale:
§21 fixed "no persisted event journal in v1", so there is nothing to replay from. Honouring
the header would imply a gap-free resume Core cannot deliver, and plan §10.2 already requires
the client to re-snapshot and reconcile on reconnect. The header is accepted rather than
rejected so a stock EventSource client works unchanged.*

**Status codes** — `200`, `400 validation_failed`.

---

### 5.13 `POST /v1/jobs/resolve`

**The office platform's only way to turn office identity into keying identity** (plan §9.2).
Resolves `{ clientKey, monthKey }` to a `jobId` + `workspaceRelPath`, registering the job if
absent.

**Headers** — `Idempotency-Key` optional (§1.5).

**Request**
```json
{
  "clientKey": "216",
  "monthKey": "2569-08",
  "externalRef": { "projectId": "216-monthly-69-08", "phaseIndex": 1, "workflowKey": "ksk-keying" },
  "register": true,
  "requestedBy": "prs_9f31c0"
}
```

| Field | Type | Required | Rule |
|---|---|---|---|
| `clientKey` | string | yes | The customer's `keyingClientKey`. Non-empty, no `/`, no leading `.`, must resolve under `KSK_WORKSPACE_ROOT` |
| `monthKey` | string | yes | **Four-digit Buddhist year**, `^[0-9]{4}-(0[1-9]\|1[0-2])$`. The platform never truncates it (plan §9.2 **[r3]**) |
| `externalRef` | object | no | Stored verbatim |
| `register` | boolean | no, default `true` | **[C-20]** `false` makes the call a pure lookup that never creates a job row |
| `requestedBy` | string | no | Audit only |

**[C-20] `register` defaults to `true` and may be set to `false`.** *Rationale: plan §9.1
specifies register-if-absent, which is right for `เริ่มรัน`. But the platform also renders a
Phase card for a งวด nobody has run, and a read that silently creates rows makes `GET
/v1/jobs`' count a function of how many cards were painted. `false` gives the read path a way
to ask without writing; the default preserves the plan's behaviour exactly.*

**200 / 201**
```json
{
  "jobId": "job_7Qd2xK9mLp0aRt4Vb8Nc1Z",
  "runRef": "job_7Qd2xK9mLp0aRt4Vb8Nc1Z",
  "workspaceRelPath": "216/69-08",
  "clientKey": "216",
  "monthId": "69-08",
  "monthKey": "2569-08",
  "created": false,
  "run": { "...": "run object of §1.7" }
}
```
`201` when the job row was created by this call, `200` otherwise.

**The mapping, and its failures** (plan §9.2 **[r3]**):

1. `monthKey` fails its regex → `400 invalid_month_key`, `details.fields[0].expected`.
2. `monthKey` → `monthId` by dropping the first two digits of the year. Total and lossless;
   Core owns this function and the platform never performs it.
3. `clientKey` does not resolve to a directory → `404 client_not_found`.
4. `<clientKey>/<monthId>` is not a directory on disk →
   `404 month_folder_not_found`, `details.expectedMonthId: "69-08"`. **Core never creates the
   directory and never fuzzy-matches a near miss** — a folder called `69-8` is one the
   operator must rename, and it is already named in §5.2's `warnings[]`.
5. `register: false` and no job row → `200` with `jobId: null`, `created: false`, `run: null`,
   and a resolved `workspaceRelPath`.

**Status codes** — `200`, `201`, `400 invalid_month_key` / `invalid_client_key` /
`invalid_path` / `validation_failed`, `404 client_not_found` / `month_folder_not_found`,
`409 idempotency_key_*`.

---

### 5.14 `GET /v1/runs/{runRef}`

One run: state, stage index/id, timings, failure reason, headline counts. This is the route
plan §10.2 makes the platform call for **every non-terminal run reference on reconnect**, so
it has to be total and cheap.

**Path parameters** — `runRef` (= `jobId`, **[C-03]**).

**Query parameters** — `include=log` appends the last 8 sequencer log lines
(`console/sequencer/logic.ts:160-162` keeps exactly 8).

**200**
```json
{
  "run": { "...": "the run object of §1.7" },
  "log": [
    "interpret: process completed",
    "interpret: checking human-stop.yaml",
    "interpret: running completion check",
    "interpret: completion check exit 1 — BLOCKED (retry 1/2 used)"
  ]
}
```

**[C-11] A registered job that has never run returns `200` with a synthetic idle run, not
`404`.** `hasRunRecord: false`, `status: "idle"`, `stage` = stage 0, all timestamps `null`,
`counts: null`, `version: 0`. *Rationale: plan §10.2 requires that a missed event degrade to a
late notification and never a silent one, and a `404` mid-reconcile is ambiguous — the
platform cannot tell "never ran" from "job gone" and has to make a judgement call in the one
code path that must not guess. `idle` is already what the runtime reports for a month with no
run record (`console/app/dashboard.ts:80`).* `404 job_not_found` is reserved for an unknown
`runRef`, which is unambiguous.

**Status codes** — `200`, `400`, `404 job_not_found`.

---

### 5.15 `GET /v1/runs/{runRef}/review`

The review read model — buckets, groups, lines, facts, flags, counts — as neutral JSON, not
the rendered page (plan §9.1, §7.1). It is assembled from the same on-disk artifacts the
generated review pages read (`console/app/review-data.ts`), so plan §16's contract test — "the
review read model matches the generated review page for the same run" — is meaningful.

**Query parameters**

| Name | Type | Default | Rule |
|---|---|---|---|
| `bucket` | enum | — | Restrict to one bucket. Repeatable |
| `view` | `summary`\|`full` | `summary` | `summary` omits `lines[]` and `facts{}` |
| `groupId` | string | — | Restrict to one group. Repeatable; implies `view=full` |

**[C-21] The default is `view=summary`.** *Rationale: a month is routinely 40+ pages across a
dozen groups, and the platform's Phase card needs counts, not line items. Plan §2.3's rule
that the platform stores counts and never content is easier to honour when the counts are the
cheap call.*

**200** (`view=full`, one bucket, abbreviated to one group and one page)
```json
{
  "runRef": "job_7Qd2xK9mLp0aRt4Vb8Nc1Z",
  "status": "done",
  "version": 21,
  "counts": { "totalUnits": 41, "pageCount": 41, "groupCount": 12, "attention": 3, "excluded": 8 },
  "buckets": [
    {
      "key": "expense/vat",
      "label": "รายจ่าย — มี VAT",
      "pageCount": 31,
      "attention": 2,
      "groups": [
        {
          "groupId": "g-004",
          "label": "บริษัท ทรู คอร์ปอเรชั่น จำกัด (มหาชน) — INV-6908-114",
          "etag": "\"c1f0a7e39b2d\"",
          "reviewFlags": ["vat_mismatch"],
          "pageCount": 1,
          "pages": [
            {
              "pageIndex": 0,
              "ref": "ใบกำกับภาษี INV-6908-114 หน้า 1",
              "shortRef": "INV-6908-114",
              "sourceUnit": "เอกสารรายจ่าย/true-6908.pdf#p3",
              "sourcePage": 3,
              "sourceSheet": null,
              "status": "needs_attention",
              "skipped": false,
              "facts": {
                "date": "2026-08-03", "seller": "บริษัท ทรู คอร์ปอเรชั่น จำกัด (มหาชน)",
                "seller_tax_id": "0107536000633", "buyer": "บริษัท สองหนึ่งหก จำกัด",
                "document_no": "INV-6908-114", "subtotal": 1200, "vat": 84, "total": 1284
              },
              "lines": [
                {
                  "lineIndex": 0, "description": "ค่าบริการอินเทอร์เน็ต ส.ค. 2569",
                  "qty": 1, "unit": null, "unitPrice": 1200, "amount": 1200,
                  "amountIncludesVat": false, "vatTreatment": null,
                  "accountKey": "5310-01", "accountCode": "5310", "subCode": "01",
                  "accountNameTh": "ค่าสาธารณูปโภค", "confidence": "high",
                  "reason": "ตรงกับรายการเดือนก่อน", "needsReview": false
                }
              ]
            }
          ]
        }
      ]
    },
    {
      "key": "bank_statement",
      "label": "รายการเดินบัญชี",
      "pageCount": 0,
      "attention": 1,
      "groups": [
        {
          "groupId": "kbank-1234",
          "label": "กสิกรไทย 123-4-56789-0",
          "etag": "\"7ab41c02de91\"",
          "reviewFlags": [],
          "statement": {
            "bank": "กสิกรไทย", "accountNo": "123-4-56789-0",
            "accountHolder": "บริษัท สองหนึ่งหก จำกัด", "period": "2026-08",
            "openingBalance": 412300.55, "closingBalance": 388120.10,
            "bankAccountKey": "1120-02", "bankAccountCode": "1120", "bankSubCode": "02"
          },
          "rows": [
            { "rowIndex": 4, "dateIso": "2026-08-05", "time": "09:14",
              "description": "โอนออก ค่าเช่า", "counterparty": "บจก. ที่ดินทอง",
              "direction": "out", "amount": 35000, "balance": 377120.10,
              "accountKey": "5210-00", "accountCode": "5210", "subCode": "00",
              "accountNameTh": "ค่าเช่า", "confidence": "medium",
              "reason": "คู่ค้าเดิม", "needsReview": true, "skipped": false }
          ]
        }
      ]
    }
  ]
}
```

Field mapping to the artifacts, so the implementer does not have to guess:

| JSON | Artifact |
|---|---|
| `buckets[].key` | `DOCUMENT_BUCKETS` + `bank_statement` (`review-data.ts:132-141`) |
| `groups[].groupId` | The group directory name; `groups[].label` is `review-data.json`'s `label` |
| `groups[].reviewFlags` | `review_flags` on the group document |
| `groups[].etag` | **[C-22]** A strong ETag over that group's `review-data.json` bytes — §1.6, and the precondition §5.18 requires |
| `pages[].pageIndex` | `page_index_in_group` — the stable key `review-edit.ts` addresses a page by. **Never `ref`**, which is a display label with no uniqueness guarantee (`review-edit.ts:60-66`) |
| `pages[].status` | `initial_status` — `"reviewed"` \| `"needs_attention"` |
| `pages[].facts` | `facts` verbatim, keys unchanged (they are the pipeline's own vocabulary) |
| `lines[].accountKey` | `coaKey()` = `account_code` + `sub_code`, the join key the account picker uses |
| `rows[]` | Statement rows, `row_index` as `rowIndex` |

**[C-22]** *Rationale for a per-group ETag rather than a run-level one: §1.6. The value is
opaque; an implementation may hash the file bytes or use `(size, mtimeNs)` — it only has to
change whenever the file changes.*

**Headers** — when the response covers exactly one group, `ETag` is set to that group's tag.
Otherwise no `ETag` (there is no single entity to precondition on).

**Status codes** — `200`, `400 validation_failed`, `404 job_not_found`,
`422 artifact_malformed` (a group's `review-data.json` fails its schema —
`review-data.ts:151-160` treats that as a hard error, not a silent skip, and so does this).
A run that has never reached `categorize` returns `200` with `buckets: []`; that is not an
error, it is an empty read model.

---

### 5.16 `GET /v1/runs/{runRef}/exclusions`

Proposed exclusions with `reason`, `duplicate_of`, and the current decision. This is the
review screen's step 1 (plan §9.5), and it reads `ข้อมูลระบบ/_pages/dispositions.yaml` through
the same `buildClaims()` core the existing page uses (`console/app/review-claims.ts:116-169`).

**Query parameters** — `decided` (`true`\|`false`\|`any`, default `any`).

**200**
```json
{
  "runRef": "job_7Qd2xK9mLp0aRt4Vb8Nc1Z",
  "version": 21,
  "guard": { "writable": true, "reason": null },
  "counts": { "total": 8, "pending": 3, "confirmed": 4, "keptBack": 1 },
  "exclusions": [
    {
      "unit": "เอกสารรายจ่าย/สรุปยอด-ส.ค..pdf#p1",
      "file": "เอกสารรายจ่าย/สรุปยอด-ส.ค..pdf",
      "page": 1,
      "sheet": null,
      "fileKind": "pdf",
      "reason": "reference_report",
      "reasonLabel": "รายงานอ้างอิง (ไม่ใช่ต้นฉบับ)",
      "extraScrutiny": true,
      "declaredBy": "agent",
      "duplicateOf": null,
      "conflictGroup": null,
      "referenceReportCheckMissing": false,
      "decision": null,
      "documentUrl": "/v1/runs/job_7Qd2xK9mLp0aRt4Vb8Nc1Z/documents/%E0%B9%80%E0%B8%AD%E2%80%A6%23p1"
    },
    {
      "unit": "เอกสารรายจ่าย/true-6908.pdf#p7",
      "file": "เอกสารรายจ่าย/true-6908.pdf", "page": 7, "sheet": null, "fileKind": "pdf",
      "reason": "duplicate", "reasonLabel": "ซ้ำกับเอกสารอื่น", "extraScrutiny": false,
      "declaredBy": "agent_policy",
      "duplicateOf": { "unit": "เอกสารรายจ่าย/true-6908.pdf#p3", "file": "เอกสารรายจ่าย/true-6908.pdf", "page": 3, "sheet": null },
      "conflictGroup": null, "referenceReportCheckMissing": false,
      "decision": "confirmed",
      "documentUrl": "/v1/runs/job_.../documents/%E2%80%A6"
    }
  ]
}
```

- `reason` is the **raw** disposition reason, one of the real 7-value vocabulary or a
  `superseded_by <seg-id>` string (`review-claims.ts:33-46`); `reasonLabel` is the Thai label.
  An unrecognised reason maps to `reasonLabel = reason` and is still listed — a future
  category must never hide a claim.
- `decision` is `null` (pending), `"confirmed"` (a human Exclusion Declaration —
  `declared_by: "human"` with the exclusion kept), or `"kept"` (brought back into the pipeline).
- `extraScrutiny` is `true` for `reference_report`, which is why that category sorts first
  (`review-claims.ts:161-169`); preserve the order.
- `guard.writable` mirrors the existing review guard (`console/app/server.ts:213-220`): `false`
  while the run is queued or active, with a Thai `reason`.
- Ordering is `buildClaims()`'s: `reference_report` first, stable otherwise.

**Status codes** — `200`, `404 job_not_found`, `422 artifact_malformed` (a `dispositions.yaml`
that does not parse). A run with no `dispositions.yaml` yet returns `200` with
`exclusions: []`.

---

### 5.17 `POST /v1/runs/{runRef}/exclusions/{unit}/decision`

Record a human Exclusion Declaration (`confirm`) or a request to return the page to the
pipeline (`keep`). **This is the one review write that changes run state**, and that has to be
said out loud.

**Path parameters**

| Name | Rule |
|---|---|
| `unit` | The `unitKey`, **percent-encoded exactly once** with `encodeURIComponent` — so `/` becomes `%2F` and `#` becomes `%23`. Core decodes exactly once and rejects a decoded value that fails the traversal guard or is not a well-formed unit key |

**[C-23] The unit may also be supplied in the body as `unitKey`; when both are present they
must be byte-identical after NFC normalisation, or the request is `400 invalid_unit`.**
*Rationale: a unit key contains `/` and `#` and Thai, and some proxies normalise `%2F` in a
path segment before the application sees it. §9.1 fixes the route shape, so the body field is
the belt to the path's braces — and requiring them to agree means a normalising proxy produces
a loud `400`, not a decision applied to the wrong page.*

**Headers** — `Idempotency-Key` **required**.

**Request**
```json
{ "decision": "confirm", "unitKey": "เอกสารรายจ่าย/true-6908.pdf#p7", "requestedBy": "prs_9f31c0" }
```
```json
{ "decision": "keep", "unitKey": "เอกสารรายจ่าย/true-6908.pdf#p7",
  "acknowledgeDiscard": true, "requestedBy": "prs_9f31c0" }
```

| Field | Values | Meaning |
|---|---|---|
| `decision` | `"confirm"` | The human agrees with the agent's stated reason. The entry is sealed `declared_by: "human"`, preserving its `reason`/`duplicate_of` (`dispositions-writer.ts:36-56`). **No run state changes.** |
| | `"keep"` | The human says the exclusion was wrong. The entry is replaced with `{ disposition: "used", declared_by: "human" }` **and the run is repaired** — see below |

**200 — `confirm`**
```json
{ "unit": "…#p7", "decision": "confirmed", "runRepaired": false,
  "run": { "...": "unchanged run object" } }
```

**202 — `keep`**
```json
{ "unit": "…#p7", "decision": "kept", "runRepaired": true,
  "discarded": { "editedGroups": 4, "groupCount": 12, "lastHumanEditAt": "2026-08-07T13:20:11.004Z" },
  "run": { "status": "idle", "queued": true, "stage": { "id": "segment", "index": 1, "count": 7 }, "version": 22 } }
```

**`keep` re-runs the pipeline from Stage 1.** The existing implementation writes the
disposition and immediately calls `repairRun` (`console/app/server.ts:512-530`), because a page
brought back into scope has to be segmented, interpreted, linked, grouped and categorised
before it can appear anywhere. `/v1` preserves that exactly, including the compensating
rollback: **if the repair is refused, the disposition write is reverted** and the route returns
the repair's own error (`dispositions-writer.ts:104-127`'s `revert()`), so the file is never
left saying `used` with no run requeued.

⚠ Therefore `keep` carries §5.8's consequence in full: **every human edit made through §5.18
since the last run is discarded.** The platform must present `เอากลับเข้ากระบวนการ` as the
re-run it is.

**It therefore carries §5.8's guard in full too.** `decision: "keep"` requires
`acknowledgeDiscard: true` whenever `repairImpact.destroys` is `true` (**[C-40]**), and the
check runs **before** the disposition is written — so a refusal is a clean `409
repair_not_acknowledged` with `details.repairImpact` and no `revert()` is involved. `confirm`
never repairs and never requires it. *A guard on §5.8 alone would be theatre: the same
destruction is one button away on the review screen, and `เอากลับเข้ากระบวนการ` is the door a
person is far more likely to walk through by accident.* `GET …/exclusions` (§5.16) does not
carry `repairImpact` — a screen that needs the numbers reads §5.14, or dry-runs §5.8.

**Command semantics**

| Target | Result |
|---|---|
| Unit is a pending agent proposal, run not queued/active | `200` (confirm) or `202` (keep) |
| Unit already decided (`declared_by: "human"`) | `409 decision_not_pending` — `"รายการนี้ไม่ใช่ข้อเสนอตัดออกที่รอตรวจสอบ (อาจถูกตรวจสอบไปแล้ว)"` |
| Same decision replayed with the same key | The stored receipt, `Idempotency-Replayed: true` |
| Run is queued or active | `409 run_busy` — the existing guard (`server.ts:213-220,501-502`) |
| Unit not in `dispositions.yaml` | `404 unit_not_found` |
| `decision: "keep"` that would discard review work, no `acknowledgeDiscard` | `409 repair_not_acknowledged` — checked first, **nothing written** |
| `decision: "keep"` but the run cannot be repaired (queued/active raced in) | `409 run_not_repairable`, disposition reverted |

**Idempotency** — required, because `keep` starts work. A replay must not repair twice.

**Status codes** — `200`, `202`, `400 invalid_unit` / `validation_failed` /
`idempotency_key_*`, `404 job_not_found` / `unit_not_found`, `409 decision_not_pending` /
`run_busy` / `run_not_repairable` / `repair_not_acknowledged` / `idempotency_key_*`,
`422 artifact_malformed`.

---

### 5.18 `PATCH /v1/runs/{runRef}/groups/{groupId}`

Reviewer edits to one group. The surface is **exactly the union of the three existing artifact
writers** — `savePageEdit`, `saveRowEdit`, `saveStatementMetaEdit`
(`console/app/review-edit.ts:216-242`) — and nothing else, because plan §12.2 says an edit that
cannot be expressed in the existing artifact shape means the API is wrong, not that the
artifact should change.

**Path parameters** — `runRef`; `groupId` (percent-encoded if it contains anything unusual).

**Headers**

| Header | Required | Rule |
|---|---|---|
| `Idempotency-Key` | yes | §1.5 |
| `If-Match` | yes | The group's `ETag` from §5.15. A mismatch is `409 stale_version` with `details.currentEtag` (**[C-08]**) |
| `X-Keying-Bucket` | no | See `bucket` below |

**Request — document group**
```json
{
  "bucket": "expense/vat",
  "pages": [
    {
      "pageIndex": 0,
      "facts": { "total": 1284, "vat": 84 },
      "lines": [ { "lineIndex": 0, "amount": 1200, "accountKey": "5310-01", "description": "ค่าอินเทอร์เน็ต ส.ค. 2569" } ],
      "skipped": false
    }
  ],
  "requestedBy": "prs_9f31c0"
}
```

**Request — bank statement group**
```json
{
  "bucket": "bank_statement",
  "statement": { "bankAccountKey": "1120-02" },
  "rows": [ { "rowIndex": 4, "amount": 35000, "accountKey": "5210-00", "skipped": false } ],
  "requestedBy": "prs_9f31c0"
}
```

Rules:

- `bucket` is **required** — a `groupId` is unique only within its bucket, because the group
  directory is `_doc_groups/<bucket>/<groupId>` (`review-data.ts:233-235`).
- Only the fields present are applied; every absent field keeps its current value
  (`review-edit.ts:78-121` is a patch, not a replace).
- `lines[].accountKey` is resolved **server-side** against the client's `coa.csv`; an unknown
  key is rejected outright rather than accepted with a stale name
  (`review-edit.ts:43-48,89-96`) → `400 validation_failed` with
  `fields[0].problem: "unknown_account_key"`.
- `vatTreatment` on a line is honoured **only** in `expense/mixed` and is silently ignored
  elsewhere, exactly as `applyPageEdit(…, allowVatTreatment)` does — a raw request cannot
  smuggle a per-line VAT override into a bucket whose schema forbids one.
- A patch that names a `pageIndex`/`lineIndex`/`rowIndex` that does not exist is
  `400 validation_failed` with the offending index — **not** `404`: the group exists and it is
  the request that is wrong about its contents (`review-edit.ts:78,86,146`). `404
  group_not_found` is reserved for a `groupId` with no directory.

**[C-24] Two fields §9.1's purpose column names are handled differently from the rest.**

| Field | v1 behaviour | Why |
|---|---|---|
| `status` | **Server-derived, not client-settable.** A save flips that page's `initial_status` to `"reviewed"` and that row's `needs_review` to `false`, because *the save is the human review signal* (`review-edit.ts:120-124,175-178`). A client-sent `status` is `400 unsupported_field` | Accepting it would let a client mark a page reviewed without reviewing it, and would fight the writer |
| `note` | **`400 unsupported_field`.** There is no note field on any group, page, row or statement artifact | Plan §12.2: an edit that cannot be expressed in the existing artifact shape is a signal the API is wrong. Silently accepting a note that vanishes on refresh is worse than refusing it. **If the review screen needs a note, that is a real artifact-schema change and belongs in a plan revision, not here** |

`skip` is supported and maps to `skipped` at **page** and **row** level, which is where the
export gate reads it — there is no group-level skip.

**200**
```json
{
  "groupId": "g-004",
  "bucket": "expense/vat",
  "etag": "\"c1f0a7e39b2e\"",
  "applied": { "pages": 1, "lines": 1, "rows": 0, "statement": false },
  "status": { "pageIndex": 0, "value": "reviewed" },
  "version": 21
}
```
`ETag` response header carries the new tag, so a client can chain edits without re-reading.
`version` is the run's projection version and is **unchanged** by a group edit — a review edit
is not a run transition and emits no run event.

**Command semantics** — not idempotent in effect (it is a patch of absolute values, so
re-applying the same body is a no-op in practice), idempotent by receipt. Refused with
`409 run_busy` while the run is queued or active, matching the existing guard
(`server.ts:680-681`).

**Status codes** — `200`, `400 validation_failed` / `unsupported_field` /
`idempotency_key_*`, `404 job_not_found` / `group_not_found`, `409 run_busy` /
`stale_version` / `idempotency_key_*`, `422 artifact_malformed`.

---

### 5.19 `GET /v1/runs/{runRef}/documents/{unit}`

An allowlisted reference to the source document page for the evidence pane. Never a host
path; every resolution goes through the workspace guard
(`console/app/workspace.ts:105-120`) which rejects traversal, encoded traversal, symlink
escape and absolute paths (plan §9.2).

**Path parameters** — `unit`, percent-encoded exactly once, as §5.17.

**Query parameters**

| Name | Values | Default | Meaning |
|---|---|---|---|
| `variant` | `source` \| `page-image` | `source` | The original file, or the rendered page image the pipeline prepared |

**[C-25] The route serves bytes by default and metadata on `Accept: application/json`.**
*Rationale: plan §9.1 calls it a "reference … for the evidence pane", and the pane needs both —
a URL to render and enough metadata to label it. Two shapes on one route beats inventing a
second route the plan's table does not have.*

**200, bytes** — `content-type` from the extension (`application/pdf`,
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `image/png`, …; the same
map `server.ts:222-226` already uses), `content-disposition: inline; filename*=UTF-8''…`,
`cache-control: private, max-age=60`.

**200, `Accept: application/json`**
```json
{
  "unit": "เอกสารรายจ่าย/true-6908.pdf#p3",
  "file": "เอกสารรายจ่าย/true-6908.pdf",
  "page": 3,
  "sheet": null,
  "contentType": "application/pdf",
  "bytes": 1841002,
  "variants": {
    "source": "/v1/runs/job_.../documents/%E2%80%A6?variant=source",
    "pageImage": "/v1/runs/job_.../documents/%E2%80%A6?variant=page-image"
  }
}
```
`variants.pageImage` is `null` when no rendered page artifact exists.

**Status codes** — `200`, `400 invalid_unit` / `invalid_path`, `404 job_not_found` /
`unit_not_found` (including a `variant=page-image` with no rendered artifact).

---

### 5.20 `GET /v1/clients/{clientKey}/coa`

The client's chart of accounts, for the review screen's account picker (plan §9.1, §23.4).
Reads the real `<clientKey>/coa.csv` (`console/app/coa.ts:38-57`) — never the mock's hardcoded
`WF_COA_*` tables.

**Path parameters** — `clientKey`. **Client-scoped, not month-scoped**: `coa.csv` lives at the
client root (plan §12.1).

**Query parameters** — `q` (substring filter over `accountCode`, `subCode`, `nameTh`,
`nameEn`), `limit` (default `2000`).

**200**
```json
{
  "clientKey": "216",
  "sourcePath": "216/coa.csv",
  "updatedAt": "2026-07-02T04:00:11.000Z",
  "rows": [
    { "accountKey": "1120-02", "accountCode": "1120", "subCode": "02",
      "nameTh": "เงินฝากธนาคาร — กสิกรไทย", "nameEn": "Bank deposits — KBank" },
    { "accountKey": "5310-01", "accountCode": "5310", "subCode": "01",
      "nameTh": "ค่าสาธารณูปโภค", "nameEn": "Utilities" }
  ],
  "total": 214
}
```

`accountKey` is `coaKey()` — the composite the review edit route expects, precomputed so no
client re-derives the join.

`coa_usage.json` is **not** exposed. It is a pipeline input (plan §12.1), not review data, and
§9.1 has no route for it.

**Status codes** — `200`, `400 invalid_client_key` / `validation_failed`,
`404 client_not_found` (no client directory) or `404` with `details.reason: "coa_missing"`
when the directory exists but `coa.csv` does not, `422 artifact_malformed` when the CSV is
missing a required column — a malformed COA is a hard stop, not a silent partial load
(`coa.ts:38-47`).

---

### 5.21 `GET /v1/runs/{runRef}/export`

The PEAK import file. Two shapes: a manifest, and the workbook bytes.

**Query parameters**

| Name | Values | Meaning |
|---|---|---|
| `bucket` | one of the six | Absent → the manifest. Present → the workbook for that bucket |

**200 — manifest** (no `bucket`)
```json
{
  "runRef": "job_7Qd2xK9mLp0aRt4Vb8Nc1Z",
  "status": "done",
  "exports": [
    { "bucket": "expense/vat", "ready": true, "rowCount": 31,
      "filename": "นำเข้า PEAK - รายจ่าย — มี VAT.xlsx",
      "url": "/v1/runs/job_.../export?bucket=expense%2Fvat", "warnings": [] },
    { "bucket": "income/vat", "ready": false, "rowCount": 0,
      "filename": null, "url": null,
      "warnings": ["ไม่มีเอกสารที่ยังไม่ถูกข้ามสำหรับส่งออกในหมวดนี้"] },
    { "bucket": "bank_statement", "ready": true, "rowCount": 58,
      "filename": "peak_import_bank_statement.xlsx",
      "url": "/v1/runs/job_.../export?bucket=bank_statement", "warnings": [] }
  ]
}
```

**200 — workbook** (`bucket` present) — `content-type:
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `content-disposition:
attachment; filename*=UTF-8''…` carrying **the existing filename unchanged** (plan §12.2:
PEAK export filenames, headers, rows and workbook bytes are all invariants), and an
`X-Keying-Export-Warnings` header carrying a JSON array of the warnings the builder produced.

**[C-26] This route builds the workbook on read, and therefore inherits the existing
`changes.json` write as a side effect. It is *not* a safe method.** *Rationale: today no PEAK
file is ever written to disk — `POST /api/export/...` builds the workbook in memory and, in
the same operation, writes one `changes.json` per group (`console/app/server.ts:754-761`).
Plan §12.2 pins "changes.json effects" as an invariant, so moving that computation into the
`final` stage would be a pipeline behaviour change this document has no authority to make.
Keeping production where it is and documenting the side effect is the only option that changes
nothing.* Consequences the implementer must honour: the route requires `status: "done"` and a
run that is neither queued nor active; it must serialise concurrent builds per run; and it is
naturally idempotent, because the build is deterministic from the same artifacts.

**If the captain wants a strictly safe GET**, the fix is for `final` to write the workbook to
disk, and that needs an amendment to plan §12.2 — it is flagged here rather than done here.

**Status codes** — `200`, `400 validation_failed` (unknown `bucket`), `404 job_not_found`,
`409 export_not_ready` (run not `done`, or the bucket has no committable rows —
`server.ts:748,778`), `409 run_busy`, `422 artifact_malformed`.

---

### 5.22 One route the plan mentions and §9.1 does not carry

Plan §7.1 lists "rebuild review data where the current API permits it" among the application
commands, and §9.1's table has no `/v1` route for it. **[C-27] This document does not add
one.** *Rationale: the route table is the frozen surface; inventing a `/v1` route the plan did
not list would be exactly the silent scope growth this document exists to avoid.* The existing
`POST /api/runs/:client/:month/rebuild-review-data` (`server.ts:488-498`) stays available
through the compatibility period, and if the office platform needs it, adding it is a one-row
amendment to §9.1 — a decision, not an omission.

---

## 6. SSE: the payloads behind the event names

Plan §10.1 fixes the envelope and §10.3 names the events the office platform subscribes to.
This section gives each one a payload, because a name is not a contract.

### 6.1 The envelope

```
event: run.status_changed
id: 1042
data: {"streamId":"ksk-core-01J8Z9F3","seq":1042,"type":"run.status_changed","occurredAt":"2026-08-07T10:42:18.000Z","jobId":"job_7Qd2xK9mLp0aRt4Vb8Nc1Z","runRef":"job_7Qd2xK9mLp0aRt4Vb8Nc1Z","workspaceRelPath":"216/69-08","externalRef":{"projectId":"216-monthly-69-08","phaseIndex":1,"workflowKey":"ksk-keying"},"version":17,"data":{...}}
```

- `streamId` changes on every Core restart; a client that sees a new one must discard its
  ordering assumptions and re-snapshot (plan §10.1, §10.2).
- `seq` increases within a process instance and is also the SSE `id:` field.
- `version` is the job's projection version. **The platform compares it before writing a run
  reference** (plan §8.5, §10.1) — a lower `version` than the one it holds is dropped.
- `externalRef` is echoed verbatim so the platform routes without a lookup table.
- `data` is neutral DTOs only. **No HTML fragment ever appears** — the existing dashboard
  stream carries pre-rendered rows (`console/app/server.ts:142`) and that stream is the legacy
  adapter, not this one.
- A `: ping` comment every 15 s (`server.ts:267-273` already does this).

### 6.2 The catalogue

Every event, its trigger from §3.2, and its `data`.

| Event | Emitted on | `data` |
|---|---|---|
| `run.snapshot` | Connection open, one per job (§6.3) | `{ "run": <run object §1.7> }` |
| `job.created` | T1 | `{ "job": { jobId, workspaceRelPath, clientKey, monthId, title, externalRef } }` |
| `job.updated` | Title/externalRef/archived changed | `{ "job": {...}, "changed": ["externalRef"] }` |
| `job.archived` | Archive flag set | `{ "jobId": "...", "archivedAt": "..." }` |
| `run.queued` | T2, T19, T20, T24 | `{ "run": <run>, "queuePosition": 2, "trigger": "start" \| "retry" \| "repair" \| "boot", "discarded": { editedGroups, groupCount, lastHumanEditAt } }` — `discarded` is present **only** when `trigger` is `"repair"` (**[C-41]**) |
| `run.started` | T3 — a slot was taken | `{ "run": <run>, "stage": { "id": "profile", "index": 0, "count": 7 } }` |
| `run.progress_changed` | T6 — `stageIndex` advanced | `{ "run": <run>, "stage": {...}, "previousStage": { "id": "segment", "index": 1 } }` |
| `run.status_changed` | T4, T5, T8–T14 — any status change that is not itself a terminal completion | `{ "run": <run>, "from": "gate-running", "to": "blocked", "retriesRemaining": 1, "reason": "<last log line>" }` |
| `run.completed` | T7 | `{ "run": <run>, "counts": { totalUnits, reviewed, excluded, groupCount, attention }, "durationMs": 4431022 }` |
| `run.failed` | T15, and any entry into `env-error`/`blocked-for-human` that ends the attempt | `{ "run": <run>, "failStage": { "id": "interpret", "index": 2 }, "failWhy": "<last log line>", "terminal": true }` |
| `run.stopped` | T16–T18, T22, T23 | `{ "run": <run>, "stoppedWhile": "active" \| "queued", "byShutdown": false }` |
| `human_action.requested` | T8, T10, T12, T14 — entry into `stopped-for-human` or `blocked-for-human` | `{ "run": <run>, "kind": "human_stop" \| "retries_exhausted", "stage": {...}, "entries": [ { "stage", "unit", "condition", "conditionRaw", "reason", "message", "remedy" } ], "resolvableBy": ["repair"] }` — `entries[]` is byte-identical to `run.humanStop[]` (§3.6), and empty for `kind: "retries_exhausted"`, which has no `human-stop.yaml` behind it |
| `human_action.resolved` | The run leaves either state by any route | `{ "run": <run>, "kind": "human_stop", "resolvedBy": "repair" \| "stop" }` |
| `queue.changed` | T2, T3, T15, T17, T22 | `{ "concurrency": 1, "depth": 2, "active": 1, "order": ["ศรีชัย/69-08","216/69-07"] }` |

**[C-28] `run.failed` carries `terminal`, and both `env-error` (retries remain) and
`blocked-for-human` (retries exhausted) emit it.** *Rationale: plan §9.3 maps `env-error` onto
the mock's `failed` display state, so the platform's `run` notification has to fire for it —
but a retryable failure and a dead-end are not the same thing to a person, and `terminal:
false` plus `retriesRemaining` is what lets the platform say "ลองใหม่ได้" instead of "ไม่สำเร็จ".*

**`run.status_changed` for `blocked` is not a failure** and carries no `failWhy`. Only
`run.failed` does.

### 6.3 Snapshot on connect

Plan §10.2 rule 1: send a consistent snapshot before live deltas.

1. The subscription is registered **first**, synchronously, so no event minted during the
   snapshot scan is lost.
2. `seq` is snapshotted **before** the scan begins, not stamped when it resolves. This is the
   existing snapshot-before-scan race protection (`console/app/seq-utils.ts` via
   `server.ts:335`), and it is what makes a later broadcast strictly outrank an in-flight
   catch-up so a terminal event cannot be repainted back to a running state.
3. One `run.snapshot` per job with a run record, then one `queue.changed`, then live deltas.
4. `?snapshot=false` skips steps 3 and starts at live deltas — for a client that has just
   read `GET /v1/runs` itself and does not want the duplicate.

### 6.4 Reconnect and reconcile — the hard requirement

Plan §10.2's consequence: the platform is a durable subscriber, not a dashboard someone has
open. A missed event must degrade to a **late** notification, never a silent one.

The contract that makes it possible, restated as obligations:

**Core owes:**
- a `streamId` that changes on restart, and a `version` that only increases per job;
- a snapshot on every connect that is consistent with the deltas that follow it;
- `GET /v1/runs/{runRef}` that is **total** — it answers for every job, including one that has
  never run (**[C-11]**), so reconciliation never has to interpret a `404`;
- bounded per-subscriber buffering: a slow subscriber is disconnected, never allowed to block
  the orchestrator or grow memory without limit (plan §10.2 rule 6).

**The platform owes** (stated here because the contract is only meaningful in pairs):
- on reconnect, or on a changed `streamId`, call `GET /v1/runs/{runRef}` for **every**
  non-terminal run reference **before** resuming live events;
- compare `version` before writing, and drop anything lower;
- emit any notification it now owes — exactly once, which is why the notification's identity
  must be `(runRef, terminal state)` and not "the event arrived".

§7.4 walks this end to end.

---

## 7. End-to-end sequences

Four sequences. Every step names the **actor**, the **call or event**, and the **state
change**. `—` means no state changed.

### 7.1 The office platform starts a run and follows it to completion

| # | Actor | Call / event | State change |
|---|---|---|---|
| 1 | Person | Clicks `เริ่มรัน` on `/projects/:id` | — (browser only) |
| 2 | Platform | Server-side capability check: may this `personId` start a run? (plan §9.4 — **Core will not check**) | — |
| 3 | Platform | Pre-check `wfDocsReady`: are Phase 1 document gates closed? If not, refuse locally | — (plan §9.5: pre-check *and* Core's own `segment` failure; do not rely on one) |
| 4 | Platform gateway | `POST /v1/jobs/resolve` `{clientKey:"216", monthKey:"2569-08", externalRef:{…}}` | Core: job row created if absent → `job.created`. Run: `hasRunRecord:false`, `idle` |
| 5 | Core | Responds `201 { jobId, runRef, workspaceRelPath:"216/69-08" }` | — |
| 6 | Platform gateway | `POST /v1/jobs/{jobId}/start`, `Idempotency-Key: 216-monthly-69-08:1:ksk-keying:1`, `requestedBy: prs_9f31c0` | Core: receipt committed → `enqueueRun` → **T2** queued |
| 7 | Core | `202 { receipt, run: queued }` + SSE `run.queued` + `queue.changed` | Platform: run reference `{state:"queued", no:+1, version:1}` |
| 8 | Core | A slot frees; `pump()` admits the job | **T3** `active:true` → SSE `run.started` |
| 9 | Platform | Renders `กำลังทำงาน`, step 0 of 7 | reference `state:"running", stageIndex:0` |
| 10 | Core | `profile` gate exit 0 → `advance()` | **T6** `stageIndex 0→1` → SSE `run.progress_changed` |
| 11 | Core | …repeats for `segment`, `interpret`, `link`, `group`, `categorize` | one `run.progress_changed` per stage |
| 12 | Core | `final` gate exit 0 | **T7** `done`, `finishedAt` set, slot released → SSE `run.completed` with `counts` |
| 13 | Platform | On `run.completed`: writes counts to the run reference **if `version` is higher**, emits the `run` notification **to the assignee and to `startedBy`** (plan §10.3) | reference `state:"done"`, notification row created |
| 14 | Person | Opens `ตรวจทานผลการรัน` | — |
| 15 | Platform | `GET /v1/runs/{runRef}/review` + `GET /v1/runs/{runRef}/exclusions` | — (reads only) |
| 16 | Person | Ticks Gate 2.1 as evidence-supported and signs it | **Platform only.** Never reaches Core (plan §9.5, §20) |

Two invariants this sequence must preserve and a test should assert (plan §15 phase 8 step 5):
a Gate can be ticked and signed at any point between steps 6 and 13 with the run in flight,
and step 12 changes **no** Gate record.

### 7.2 A run stops for a human, and is resolved

| # | Actor | Call / event | State change |
|---|---|---|---|
| 1 | Core | Mid-run, `settle()` reads `human-stop.yaml` **before** the completion check and finds 2 entries | **T8** `gate-running → stopped-for-human`, slot released |
| 2 | Core | SSE `run.status_changed` (`to: "stopped-for-human"`) **and** `human_action.requested` with `entries[]` and `resolvableBy:["repair"]` | Platform: reference `state:"stopped-for-human"` — its fifth display state (plan §9.3, §23.3) |
| 3 | Platform | Emits a `run` notification to assignee + `startedBy`, carrying each entry's `message` — the Thai sentence §3.6 pins per `condition`, not `reason` and not `failReason` | notification row |
| 4 | Person | Opens the run, reads `humanStop[]` — `{stage:"interpret", unit:"…#p7", condition:"unreadable_required_source", message:"เปิดไฟล์ … ไม่ได้ …", remedy:"หาไฟล์ตัวจริงมาวางทับที่เดิม …"}` | — |
| 5 | Person | Does what `remedy` says **outside Core**, then archives `human-stop.yaml`. The sequencer never clears it (`logic.ts:64`), and a repair that skips this re-stops at the next gate (§5.8) | — (workspace file, no API) |
| 6 | Platform | Before offering `รันใหม่`: reads `repairImpact` from `GET /v1/runs/{runRef}` (or `POST …/repair {"dryRun":true}`) — `{destroys:true, editedGroups:4, groupCount:12}` | — (reads) |
| 7 | Person | Sees `การแก้ไขที่คุณทำไว้ใน 4 จาก 12 กลุ่มจะหายและกู้คืนไม่ได้` and confirms | — (browser only) |
| 8 | Platform | `POST /v1/jobs/{jobId}/repair` `{acknowledgeDiscard:true}`, new `Idempotency-Key` (attempt+1) | **T20** state reset to `idle` at `segment`, `retryCount:0`, re-queued |
| 9 | Core | `202` with `discarded:{editedGroups:4,…}`; SSE `human_action.resolved` (`resolvedBy:"repair"`), `run.status_changed`, `run.queued` (`trigger:"repair"`, same `discarded`); one `warn` log line `event=run.repair.discarded` | Platform: clears the human-action banner and the notification it owes; records `discarded` in its own audit |
| 10 | Core | `pump()` admits it; run proceeds | **T3** → `run.started` |
| 11 | — | ⚠ Every §5.18 edit made since the previous run is gone (§5.8). `dispositions.yaml`, `CLIENT.md` and `coa.csv` are not | The loss was priced at step 7 and recorded at step 9 |

Note step 5. **[C-13]** Core exposes no route to clear a human stop; `repair` is the
resolution, and the human's out-of-band declaration is what makes it valid — a decision the
captain reviewed and accepted with its cost on 2026-08-07 (§5.8). If the run is
`blocked-for-human` instead (retries exhausted rather than a hard blocker), steps 1–10 are
identical except there is no `human-stop.yaml` to archive — step 5 is fixing whatever the
completion check complained about, and `humanStop[]` is empty, so step 3's notification carries
`kind: "retries_exhausted"` and the stage rather than a `message`.

Steps 6–9 are the whole of change 2: the platform cannot reach step 8 without having been told
the number at step 6, because a bare `POST` is `409 repair_not_acknowledged` (**[C-40]**).

### 7.3 A run fails and is retried

| # | Actor | Call / event | State change |
|---|---|---|---|
| 1 | Core | `interpret`'s completion check exits 1, `retryCount = 0 < 2` | **T9** `gate-running → blocked`, slot released |
| 2 | Core | SSE `run.status_changed` `{from:"gate-running", to:"blocked", retriesRemaining:2}` | Platform: reference `state:"blocked"` — **not** `failed`; there are retries |
| 3 | Platform | Shows `ติดขัด (ลองใหม่ได้)` and enables `ลองใหม่` from `allowedCommands` | — |
| 4 | Person | Clicks `ลองใหม่` | — |
| 5 | Platform | `POST /v1/jobs/{jobId}/retry`, `Idempotency-Key: …:attempt:2` | **T19** re-queued at the **tail** |
| 6 | Core | `run.queued` `{trigger:"retry"}` | reference `state:"queued"` |
| 7 | Core | Slot frees; `retryStage()` re-invokes **the same stage from scratch, fresh context**, `retryCount → 1` | **T3**, then T4/T5 |
| 8a | Core | Gate exits 0 | **T6** `run.progress_changed`, run continues |
| 8b | Core | Gate exits 1 again, `retryCount = 1 < 2` | **T9** `blocked` again, `retriesRemaining: 1` |
| 8c | Core | Gate exits 1 a third time, budget spent | **T10** `blocked-for-human` → `run.failed` `{terminal:true}` + `human_action.requested` `{kind:"retries_exhausted"}` |
| 9 | Platform | On `terminal:true`: `run` notification, `รอคนตรวจสอบ`, `retry` no longer offered — `allowedCommands: ["repair"]` | reference `state:"failed"` |
| 10 | Person | Fixes the cause, `รันใหม่` → §7.2 steps 6–9 | **T20** |

The distinction at step 2 versus step 9 is the whole point of `retriesRemaining` and
`terminal`: the same Thai word `ไม่สำเร็จ` on both would make the platform's notification lie
twice — once by alarming early, once by under-alarming late.

### 7.4 The platform is down while a run completes, and reconciles

Plan §10.2's hard requirement, step by step.

| # | Actor | Call / event | State change |
|---|---|---|---|
| 1 | Platform | Holds run references for jobs A (`running`), B (`queued`), C (`done`) | — |
| 2 | Platform | Container stops (deploy, crash, host reboot) | SSE connection drops. **Core is unaffected** (plan §17) |
| 3 | Core | A completes; B starts and then enters `stopped-for-human` | A: **T7** `done`, `version 17→18`. B: **T3** then **T8**, `version 9→11`. Both events are emitted into a stream with no subscriber and are **not journalled** (§21: no event journal in v1) |
| 4 | Platform | Restarts. `streamId` in its store is `ksk-core-01J8Z9F3`; it has not yet reconnected | — |
| 5 | Platform | **Before** opening the stream: for every **non-terminal** reference — A (`running`), B (`queued`) — calls `GET /v1/runs/{runRef}` | — (reads) |
| 6 | Core | A → `{status:"done", version:18, counts:{…}, finishedAt}`; B → `{status:"stopped-for-human", version:11, humanStop:[…]}` | — |
| 7 | Platform | `18 > 17` → writes A's reference `done` + counts. `11 > 9` → writes B's `stopped-for-human` | references updated |
| 8 | Platform | **Emits the notifications it owes**: A's `ผลการรันอัตโนมัติ` to assignee + `startedBy`; B's human-action notification. Late, not silent | notification rows created |
| 9 | Platform | Skips C — terminal references are not re-fetched (they cannot have moved without a re-run, and a re-run would have produced a new `version` the next snapshot carries) | — |
| 10 | Platform | Opens `GET /v1/events` | Core sends `run.snapshot` per job, then `queue.changed`, then live deltas |
| 11 | Platform | Reconciles the snapshot against its references by `version` again — this is belt-and-braces, and it is what catches anything that moved between steps 5 and 10 | — |
| 12 | Platform | If the snapshot's `streamId` differs from the stored one, it repeats step 5 for everything non-terminal before trusting any `seq` ordering | — |

**Exactly-once notification** is the platform's obligation, not Core's. The idempotent key is
`(runRef, terminalState)` — a notification is owed if the reference has just moved into a
terminal state and no notification row exists for that pair. "The event arrived" is not a
usable key, because in this sequence it never arrived at all.

Step 9 is the one place this design is deliberately lossy and it is worth naming: if a run went
`done → repair → done` entirely inside the outage, the platform sees one completion, not two.
That is §21's no-run-history decision, and it is correct — there is no second result to show.

---

## 8. The CLI contract, finished

Plan §11 proposes ten commands and six rules. This section gives each command its arguments,
flags, output, exit code, and the route it calls. The CLI is a **thin client of the running
Core** — never a second scheduler, never a direct SQLite client (plan §11, §21).

### 8.1 Invocation and global flags

```
keying [global flags] <group> <command> [arguments] [flags]
```

| Global flag | Env | Default | Meaning |
|---|---|---|---|
| `--api <url>` | `KSK_CORE_API` | `http://127.0.0.1:4900/v1` | Loopback, or `compose exec` inside the container |
| `--token <t>` | `KSK_CORE_TOKEN` | — | The service token (§1.1). Read from the env in normal use; **never** logged or echoed |
| `--json` | — | off | Machine output. **[C-29]** |
| `--timeout <ms>` | `KSK_CORE_TIMEOUT_MS` | `30000` (`stop`: `300000`) | `stop` waits for owned processes to exit (§5.9), so it gets its own default |
| `--idempotency-key <k>` | — | minted per invocation | **[C-30]** |
| `--quiet` | — | off | Suppress human prose; exit code only |
| `--no-color` | `NO_COLOR` | off | |

**[C-29] `--json` is explicit and the CLI never sniffs the TTY.** *Rationale: TTY-sniffing
makes the same command produce two shapes depending on whether it is piped, which is the
classic way a working script breaks under `cron`. Plan §11 asks for "a stable JSON mode"; a
mode you can end up in by accident is not stable.* Human output is Thai where the underlying
value is Thai (statuses, reasons, warnings); labels are the same ones the dashboard already
uses (`console/app/dashboard.ts:165-177`), so an operator reads one vocabulary.

**[C-30] A mutating command mints a fresh idempotency key per invocation unless
`--idempotency-key` is given.** *Rationale: an operator re-running `keying jobs retry` by hand
means "try again", so re-using a key would silently replay the first answer and look like the
command did nothing. A script that needs at-most-once passes its own key — which is exactly
what the office platform does (plan §8.4).*

### 8.2 The commands

| Command | Route | Exit on success |
|---|---|---|
| `keying jobs list` | `GET /v1/jobs` | 0 |
| `keying jobs register <client/month>` | `POST /v1/jobs` | 0 |
| `keying jobs show <job-id>` | `GET /v1/jobs/{jobId}` | 0 |
| `keying jobs start <job-id>` | `POST /v1/jobs/{jobId}/start` | 0 |
| `keying jobs retry <job-id>` | `POST /v1/jobs/{jobId}/retry` | 0 |
| `keying jobs repair <job-id>` | `POST /v1/jobs/{jobId}/repair` | 0 |
| `keying jobs stop <job-id>` | `POST /v1/jobs/{jobId}/stop` | 0 |
| `keying jobs watch [job-id]` | `GET /v1/events` or `GET /v1/jobs/{jobId}/events` | 0 on SIGINT |
| `keying queue list` | `GET /v1/runs` (reads the `queue` block) | 0 |
| `keying health` | `GET /v1/health/ready` (and `/live` on failure) | 0 |

---

#### `keying jobs list`

**Arguments** none.
**Flags** `--client <key>` (repeatable), `--status <s>` (repeatable; the ten §3.1 values plus
`queued`/`active`), `--archived`, `--limit <n>` (default 100), `--all` (follow `nextCursor` to
the end).

**Human output** — a table, one row per job, Thai status labels:
```
JOB                          CLIENT   MONTH   สถานะ                        ขั้น        อัปเดต
job_7Qd2xK9mLp0aRt4Vb8Nc1Z    216      69-08   ติดขัด (ลองใหม่ได้)           2/7 interpret  10:02
job_Fk1pW8sZ3nQb6Yr0Tc5Ah    ศรีชัย    69-08   กำลังทำงาน                   4/7 group      10:11
2 งาน · คิว 1 · กำลังทำงาน 1
```
**JSON output** — the `GET /v1/jobs` body verbatim. No reshaping: plan §16's contract test
"CLI JSON output matches HTTP DTOs" is only checkable if it is the same bytes.

**Exit** 0; 3 on a bad filter; 9 if Core is unreachable.

---

#### `keying jobs register <client/month>`

**Arguments** — `<client/month>`, one argument containing exactly one `/`. Split on the
**first** `/`: everything before is `clientKey`, everything after is `monthId`. A value with
zero or more than one `/` is a usage error (exit 2) before any request is made.

**Flags** `--title <t>`, `--external-ref <json>` (a JSON object; malformed → exit 2).

**Route** `POST /v1/jobs` with `{ clientKey, monthId, title?, externalRef? }`. The CLI does
**not** validate the `YY-MM` form itself — Core owns that regex and there must be one
implementation of it (plan §9.2).

**Human output**
```
สร้างงานแล้ว  job_7Qd2xK9mLp0aRt4Vb8Nc1Z  216/69-08
```
or, when it already existed, `มีงานนี้อยู่แล้ว  job_…  216/69-08`.

**Exit** 0 (created or already existing — registration is idempotent, §5.4); 3 on
`invalid_month_id`/`invalid_client_key`; 5 on `client_not_found`/`month_folder_not_found`.

---

#### `keying jobs show <job-id>`

**Arguments** `<job-id>`. **Flags** `--log` (adds the last 8 sequencer log lines),
`--watch` (after printing, follow §5.11 until terminal or SIGINT).

**Human output**
```
job_7Qd2xK9mLp0aRt4Vb8Nc1Z
  โฟลเดอร์      216/69-08  (บริษัท สองหนึ่งหก จำกัด)
  สถานะ         ติดขัด (ลองใหม่ได้)          คิว: ไม่  กำลังทำงาน: ไม่
  ขั้น           2/7  interpret — Stage 2 — interpret
  ลองใหม่ได้อีก   1 ครั้ง
  เหตุผล        interpret: completion check exit 1 — BLOCKED (retry 1/2 used)
  เริ่ม          07/08/2569 09:14   อัปเดต 10:02   version 17
  คำสั่งที่ใช้ได้   retry, repair
```
`คำสั่งที่ใช้ได้` is `allowedCommands` from §5.5 — the CLI does not re-derive §3.4.

When the run is `stopped-for-human`, the block below is printed instead of `เหตุผล` — one
paragraph per `humanStop[]` entry, using §3.6's `message`/`remedy` verbatim, because an
operator at a terminal needs the same sentence the accountant gets on the screen:
```
  หยุดรอคน     2 รายการ
   1) interpret · เอกสารรายจ่าย/true-6908.pdf#p7
      เปิดไฟล์ «เอกสารรายจ่าย/true-6908.pdf#p7» ไม่ได้ หรือไฟล์หายไป จึงตรวจเอกสารใบนี้ต่อไม่ได้
      → หาไฟล์ตัวจริงมาวางทับที่เดิม (สแกนใหม่ หรือขอจากลูกค้า) …
      (เหตุผลจากระบบ: invoice.pdf page 6 is corrupted — pdfinfo cannot read it)
```
An entry whose `condition` is `null` (**[C-37]**) prints the fallback pair and shows
`conditionRaw` in the header line, so the unrecognised value is visible without `--json`.

**JSON output** — the `GET /v1/jobs/{jobId}` body verbatim.
**Exit** 0; 5 on `job_not_found`.

---

#### `keying jobs start <job-id>`

**Arguments** `<job-id>`. **Flags** `--requested-by <personId>`, `--wait` (follow the run to a
terminal state and exit on its outcome), `--idempotency-key <k>`.

**Route** `POST /v1/jobs/{jobId}/start`.

**Human output**
```
เข้าคิวแล้ว  job_7Qd2xK9mLp0aRt4Vb8Nc1Z  216/69-08  (คิวลำดับที่ 2)
```
When Core answers `alreadyQueued: true`: `อยู่ในคิวอยู่แล้ว  job_…` — still exit 0
(**[C-12]**). When the response carried `Idempotency-Replayed: true`, the line is prefixed
`(ซ้ำ)` so an operator can see the command did not do anything new.

**Exit** 0; 6 on `run_not_startable` — and the message is the reason, not a generic conflict:
```
เริ่มไม่ได้: งานนี้เสร็จสมบูรณ์แล้ว   (สถานะปัจจุบัน done · คำสั่งที่ใช้ได้: repair)
```
8 on `halted_fatal_cleanup`, with the operator instruction the runtime already carries:
`ระบบหยุดเพื่อความปลอดภัยหลังเก็บ process ไม่สำเร็จ กรุณา restart app/container`.

With `--wait`: exit 0 if the run reaches `done`; 6 if it reaches any other terminal state
(the state is named); 9 if the stream dies and cannot be re-established.

---

#### `keying jobs retry <job-id>`

Same arguments, flags, and output shape as `start`. Route `POST /v1/jobs/{jobId}/retry`.

**Human output** `ลองใหม่แล้ว  job_…  (ครั้งที่ 2 · เหลืออีก 1)`.

**Exit** 0; 6 on `run_not_retryable`, whose message names why — in particular the two
deliberately terminal states:
```
ลองใหม่ไม่ได้: งานนี้หยุดรอมนุษย์ตัดสินใจ ต้องแก้ที่ต้นเหตุแล้วใช้ repair
```
8 on `halted_fatal_cleanup`.

---

#### `keying jobs repair <job-id>`

**Arguments** `<job-id>`. **Flags** as `start`, plus `--yes`.

**[C-31] `repair` prompts for confirmation on a TTY unless `--yes` is given, and the prompt
names what is discarded.** *Rationale: repair resets the run to Stage 1 and overwrites
`_segments/**`, `_doc_groups/**` and `ตรวจทาน/**` in place (§5.8), so it destroys every human
review edit since the last run. Every other command in this surface is recoverable; this one
is not, and §21's no-run-history decision is exactly why.*

**Amended by [C-40].** The prompt is now filled from the route rather than from a fixed
string: the CLI first calls `POST …/repair {"dryRun": true}` and prints the real numbers, then
sends `acknowledgeDiscard: true` only if the person confirms. And a **non-interactive
invocation without `--yes` no longer proceeds** — it prints what it would have destroyed and
exits `6`, because Core would refuse it anyway. `--yes` is what a script sends to mean "I have
already told my user".

```
$ keying jobs repair job_7Qd2xK9mLp0aRt4Vb8Nc1Z
repair จะเริ่มใหม่ตั้งแต่ Stage 1 (segment) และเขียนทับผลเดิมทั้งหมด
การแก้ไขที่คนทำไว้ในหน้าตรวจทานจะหายไป และกู้คืนไม่ได้
216/69-08 · สถานะปัจจุบัน blocked-for-human
มีการแก้ไขของคนอยู่ใน 4 จาก 12 กลุ่ม · แก้ล่าสุด 07/08 13:20
human-stop.yaml ยังอยู่ — ถ้ายังไม่เก็บ run จะหยุดซ้ำที่เดิม
ยืนยัน? [y/N]
```

The `human-stop.yaml` line appears only when the run is `stopped-for-human` and the file still
has entries; it is the §5.8 consequence an operator otherwise discovers by watching the run
stop again four minutes later.

**Exit** 0; 2 if declined at the prompt; 6 on `run_not_repairable` or
`repair_not_acknowledged` (the non-TTY, no-`--yes` case); 8 on `halted_fatal_cleanup`.

---

#### `keying jobs stop <job-id>`

**Arguments** `<job-id>`. **Flags** `--requested-by`, `--timeout <ms>` (default 300000),
`--idempotency-key`.

**Route** `POST /v1/jobs/{jobId}/stop`. The command **blocks** until Core has reaped the
owned process group; that wait is the point of the route (§5.9), so the CLI must not print
"stopped" before the response arrives.

**Human output** `หยุดแล้ว  job_…  (กำลังทำงานอยู่ · ใช้เวลา 4.2 วินาที)`.

**Exit** 0; 6 on `run_not_running` (`งานนี้ไม่ได้กำลังทำงานอยู่`); 9 if the CLI's own timeout
fires first — and the message says so plainly, because the stop may still be completing
server-side.

---

#### `keying jobs watch [job-id]`

**Arguments** optional `<job-id>`. With one, `GET /v1/jobs/{jobId}/events`; without, the
global `GET /v1/events`.

**Flags** `--client <key>` (repeatable, global stream only), `--types <t,…>`,
`--no-snapshot`, `--until-terminal`.

**Human output** — one line per event, newest last:
```
10:11:04  216/69-08      run.progress_changed   4/7 group
10:12:40  ศรีชัย/69-08     run.status_changed     blocked  (เหลืออีก 1 ครั้ง)
10:12:40  ศรีชัย/69-08     human_action.requested หยุดรอมนุษย์ · interpret · 2 รายการ
```
**JSON output** — **NDJSON**: one envelope per line, exactly the §6.1 object. **[C-32]**
*Rationale: a stream has no closing bracket, so a JSON array would never be parseable
incrementally; NDJSON is what `jq --stream`-free tooling expects and what a `while read`
loop can consume.*

**Reconnect** — the same discipline as the office platform (§6.4): on drop, reconnect with
exponential backoff (200 ms → 8 s, jitter), re-snapshot, and print a visible
`— เชื่อมต่อใหม่ (streamId เปลี่ยน) —` line if `streamId` changed, because everything the
operator saw before it belongs to a dead process instance.

**Exit** 0 on SIGINT/SIGTERM, or when `--until-terminal` sees the watched job reach a terminal
state; 5 on `job_not_found`; 9 when the reconnect budget (default 10 attempts) is exhausted.

---

#### `keying queue list`

**Arguments** none. **Flags** `--json`.

**Route** `GET /v1/runs`; the command renders the `queue` block and the active runs.

**Human output**
```
concurrency 1 · กำลังทำงาน 1 · รอคิว 2
กำลังทำงาน   ศรีชัย/69-08     4/7 group        เริ่ม 10:04
คิว 1        216/69-07        —
คิว 2        216/69-06        —
```
The order is Core's real FIFO order, head first (§5.10). The CLI never sorts it.

**Exit** 0; 9 if Core is unreachable.

---

#### `keying health`

**Arguments** none. **Flags** `--json`, `--strict`.

**Route** `GET /v1/health/ready`. If that connection fails, the CLI additionally calls
`GET /v1/health/live` so it can tell "Core is down" from "Core is up but not ready" — two
different operator actions.

**Human output** — and this is the command plan §11 **[r3]** singles out, because the operator
fixing month folders is at a terminal, not reading a JSON body:
```
สถานะ      พร้อมใช้งาน
SQLite     ok · schema 1 · WAL
Workspace  ok · /workspace · ลูกค้า 113 · เดือน 1284
คิว        concurrency 1 · กำลังทำงาน 1 · รอคิว 2
ปี พ.ศ.     base 2500 · ช่วง 2500–2599 (หมดอายุ 1 ม.ค. 2057)

⚠ โฟลเดอร์เดือนที่ข้ามไป 2 รายการ (ชื่อไม่ตรงรูปแบบ YY-MM)
   216      69-8
   ศรีชัย     69-08 (แก้ไข)
```
The offending names are printed **verbatim**, one per line, with the client — a trailing space
or a full-width digit must be visible here, which is why they are not quoted, trimmed, or
normalised. This list is the rename worklist plan §19.9–11 asks for.

**Exit** — **[C-33]** 0 when ready, **even with warnings**; `--strict` turns a non-empty
`warnings[]` into exit 10. 8 when ready returns `503`; 9 when Core is unreachable at all.
*Rationale: plan §9.2 is explicit that a stray folder does not make the service un-ready, so
the default exit must not contradict the readiness contract. But an operator who wants a cron
to shout about a folder nobody renamed needs a non-zero, and `--strict` is it.*

### 8.3 Exit codes

**[C-34]** One table, used by every command.

| Code | Meaning | Typical cause |
|---|---|---|
| `0` | Success | |
| `1` | Unexpected failure | `500 internal_error`, an unhandled CLI exception |
| `2` | Usage error | Bad arguments, malformed `--external-ref`, declined confirmation |
| `3` | Request rejected as invalid | `400` — `validation_failed`, `invalid_month_id`, `invalid_client_key`, `invalid_unit`, `invalid_path` |
| `4` | Not authorised | `401 unauthorized` — missing or wrong service token |
| `5` | Not found | `404` — `job_not_found`, `client_not_found`, `month_folder_not_found` |
| `6` | Illegal in the current state | `409` — `run_not_startable`, `run_not_retryable`, `run_not_repairable`, `repair_not_acknowledged`, `run_not_running`, `run_busy`, `stale_version`, `export_not_ready`, `decision_not_pending` |
| `7` | Artifact unusable | `422 artifact_malformed` |
| `8` | Service unavailable | `503` — `not_ready`, `halted_fatal_cleanup` |
| `9` | Cannot reach Core | Connection refused, DNS failure, CLI timeout, exhausted reconnect budget |
| `10` | Warnings present | `keying health --strict` only |

*Rationale for the shape: one code per HTTP class rather than one per error code, so a script
can branch on "the run moved" (`6`) versus "I asked wrongly" (`3`) versus "Core is down"
(`9`) without a lookup table — while `--json` still gives the exact `code` for anything
finer.* Codes above `10` are unused and reserved.

### 8.4 What the CLI deliberately does not have

- **No review commands.** Plan §11's surface has none, and §9.1's review routes exist for the
  office platform's screens. **[C-35]** *Rationale: adding `keying review …` would be a new
  operator capability this document has no authority to introduce; the routes are there when
  a later revision wants it.*
- **No archive/unarchive.** `archived` is in the job model (plan §7.2) but §11 lists no
  command and §9.1 no route. Not invented here.
- **No offline mode, no direct SQLite access.** Plan §11 forbids it: an emergency offline
  repair tool would be a distinct maintenance mode requiring Core to be stopped, and it is not
  this surface.
- **No local scheduling, no local retry loop.** `--wait` follows a run; it never re-issues a
  command. The queue is Core's.

---

## 9. Index of marked choices

Every `[C-nn]` in this document, in one place, so a reviewer can overrule without reading the
body. None of these is a §21 decision; none of them reopens one.

One entry in this document is **not** a `[C-nn]` and is not overrulable here:
**[captain 2026-08-07]** in §5.8 — `repair` as the resolution path for a human stop, with the
loss of review work accepted after being stated. §0.1 defines the tag.

| # | Choice | Where |
|---|---|---|
| C-01 | Service token is `Authorization: Bearer <token>` | §1.1 |
| C-02 | Errors carry a machine `code` **and** a Thai `message`; `Accept-Language` ignored | §1.2 |
| C-03 | **`runRef` is the same token as `jobId`** — one run per job, no history | §1.4 |
| C-04 | Core exposes no attempt counter; `no` stays the platform's | §1.4 |
| C-05 | `Idempotency-Key` required on the six real commands, optional on the two registration routes | §1.5 |
| C-06 | Receipts record rejections too; a replay returns the recorded outcome verbatim | §1.5 |
| C-07 | Receipt retention 30 days, `KSK_CORE_RECEIPT_TTL_DAYS` | §1.5 |
| C-08 | Group edits precondition on a per-group `ETag`, not the run's `version` | §1.6 |
| C-09 | `gate-running` stays in the enum but is **not observable** in v1 | §1.7, §3.1 |
| C-10 | The error body is nested under `error`, not flat | §2.1 |
| C-11 | `GET /v1/runs/{runRef}` returns `200` + a synthetic idle run for a never-run job, not `404` | §5.14 |
| C-12 | `start` on an already-queued run is `202` + `alreadyQueued`, not `409` | §3.4, §5.6 |
| C-13 | **No route resolves a human stop**; `repair` after an out-of-band declaration is the path | §3.5 |
| C-14 | Restart re-queues in workspace scan order, not pre-restart enqueue order | §4.3 |
| C-15 | The readiness `503` body carries the same `checks` object inside `details` | §5.2 |
| C-16 | Cursor pagination; sort `(clientKey, monthId)` with Thai collation | §5.3 |
| C-17 | `POST /v1/jobs` takes `monthId`; `POST /v1/jobs/resolve` takes `monthKey` | §5.4 |
| C-18 | `stop` on an already-stopped run is `409`, not a success | §5.9 |
| C-19 | `Last-Event-ID` accepted and ignored; every reconnect re-snapshots | §5.12 |
| C-20 | `resolve` gains `register` (default `true`) so a read path need not create rows | §5.13 |
| C-21 | `GET …/review` defaults to `view=summary` | §5.15 |
| C-22 | Per-group `ETag` over `review-data.json` | §5.15 |
| C-23 | `unit` may be repeated in the body and must match the path | §5.17 |
| C-24 | Group `status` is server-derived; group `note` is refused as `unsupported_field` | §5.18 |
| C-25 | `documents/{unit}` serves bytes; `Accept: application/json` returns the reference | §5.19 |
| C-26 | **`GET …/export` builds on read and is not a safe method** — it inherits the `changes.json` write | §5.21 |
| C-27 | No `/v1` route for rebuild-review-data; the legacy route stays | §5.22 |
| C-28 | `run.failed` carries `terminal` so a retryable failure reads differently | §6.2 |
| C-29 | `--json` is explicit; the CLI never sniffs the TTY | §8.1 |
| C-30 | The CLI mints a fresh idempotency key per invocation | §8.1 |
| C-31 | `keying jobs repair` confirms on a TTY and names what it discards | §8.2 |
| C-32 | `keying jobs watch --json` emits NDJSON | §8.2 |
| C-33 | `keying health` exits 0 with warnings; `--strict` exits 10 | §8.2 |
| C-34 | One exit-code table, one code per HTTP class | §8.3 |
| C-35 | No CLI review commands, no archive command | §8.4 |
| C-36 | **`condition` is a closed three-value enumeration**, each with a Thai person-facing `message` and `remedy` carried by Core | §3.6 |
| C-37 | An unrecognised `condition` → `condition: null` + `conditionRaw` + a fallback message + a `warn` log line; the run stays visible and is never rejected or dropped | §3.6 |
| C-38 | The run object carries `repairImpact` on single-subject reads; absent from list routes and SSE | §1.7, §5.8 |
| C-39 | `POST …/repair {"dryRun": true}` answers "what would this cost" on the same route, `200`, no receipt | §5.8 |
| C-40 | **A destructive `repair` (and a destructive `keep`) requires `acknowledgeDiscard: true`** — otherwise `409 repair_not_acknowledged`. Amends C-31's non-interactive half | §5.8, §5.17 |
| C-41 | An accepted repair records what it destroyed: `discarded` in the `202`, in `run.queued`, and in one `warn` log line | §5.8, §6.2 |

Five of these are the ones worth a captain's minute: **C-03** (identifier collapse — it is
right only because §21 removed run history), **C-13** (no resolve route for a human stop),
**C-24** (a review note has nowhere to live), **C-26** (an unsafe GET, or a §12.2
amendment), and **C-40** (a `409` on an unacknowledged destructive repair — the one choice here
that can make a caller that works today stop working).

---

## 10. What this document deliberately does not decide

- **The office platform's screen for a paused run.** Plan §23.3's *display* half — where it
  appears, who is notified, what it looks like — is the platform's design. The *contract* half
  is filled (§3.5, §6.2), which is what §23.3 said the boundary needed.
- **Whether the customer master is the platform's or Core's** (plan §23.4). §5.20 exposes the
  chart of accounts because §9.1 lists the route; it says nothing about who owns the customer
  record.
- **A phase-transition event log** (plan §23.5). Platform-side, phase 7.
- **Raising `KSK_APP_CONCURRENCY`** (plan §23.8). §4 specifies what the value means, not what
  it should be. Measure first; the limit exists to bound Claude cost and process load.
- **`RunGroup.kept`** (plan §23.8). It is seeded and never read in the mock, and it maps to no
  artifact field, so §5.15 does not carry it. If it turns out to mean something, that is a
  contract addition, not an omission to patch quietly.
- **A cheaper way out of a human stop.** Resume-from-stage, a partial repair, an
  edit-preserving repair, and a route that resolves a stop are **not** open questions here —
  the captain reviewed the cost of the simple path and took it on 2026-08-07 (§5.8). What this
  document adds is the price tag on the wire, not a discount.
- **Anything in §21.** Six decisions, all closed, none touched.

---

## 11. Traceability

| Acceptance requirement | Where it is met |
|---|---|
| Every route in §9.1's table specified | §5.1–§5.21, all 21, with the index table at the head of §5; §5.22 records the one application command plan §7.1 names that §9.1 carries no route for |
| One error model, closed code list | §2 — 30 codes, one mapping rule, four `details` shapes |
| State machine: states, transitions, triggers, events, illegal moves | §3.1 (states), §3.2 (T1–T25), §3.3 (illegal + response), §3.4 (matrix), §3.5 (the §23.3 gap), §3.6 (the stop conditions), §3.7 (where a stop is recorded) |
| Revision 1: `condition` closed, unknown value specified, stop recorded in one place | §3.6 (**C-36**, **C-37**), §3.7 |
| Revision 1: `repair` settled and its cost visible before it is paid | §5.8 — `[captain 2026-08-07]`, **C-38**–**C-41**; §5.17 for the second door |
| Concurrency and queue rules strong enough for phase 2's exit criterion | §4, with §4.4 naming the four mechanisms |
| Four sequences, each step naming actor, call, state change | §7.1–§7.4 |
| Every CLI command: arguments, output, exit codes, route | §8.2, §8.3 |
| Choices marked individually | Inline `[C-nn]`, indexed at §9 |
| Nothing in §21 reopened | §0, §10 |
