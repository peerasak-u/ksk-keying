# Keying Core — what a live run showed, and what to build next

Status: findings — not a plan revision, and it amends nothing
Date: 2026-08-08
Subject: `keying-core/` at `fm/ksk-core-service-foundation` @ `aa35e63` (PR #70's head)
Companion documents (both authoritative, neither edited by this one):

- `docs/plans/2026-08-07-keying-core-api-workflow-spec.md` — the implementer-level `/v1` contract
- `docs/plans/2026-08-06-keying-core-modular-monolith-plan.md` (revision 4) — the architecture

This document exists because three investigations produced measured results that lived only in
throwaway worktrees: a smoke test of the service against the real 70-client workspace, a live
25-minute keying run with the service sampled every 10 s throughout, and a Stage-2 prompt-shape
experiment measured against that run's output. Everything load-bearing from those three is carried
here. Nothing below asks you to open a path outside this repository.

**No code was changed by any of the three.** Every number is measured unless it is explicitly
labelled *extrapolated*.

---

## 1. What `keying-core/` is today, honestly

**It is a correct read model of what is written to disk, and a fabricated read model of what is
happening now.** That is not a hedge; it is the shape of the result. Every disk-derived field was
right during a real run. Every scheduler-derived field was wrong in 100 % of the samples taken
while a stage was executing. The boundary is clean enough to state in one line: **if the fact comes
from a file, believe it; if it comes from the scheduler, it is a placeholder.**

### 1.1 The evidence

A real `/ksk-keying` run was driven by `console/` against `(พร้อมทดสอบ)_216 บจก.ชามหวาน / 69-03` —
a genuinely cold month with no `ข้อมูลระบบ/` — while `keying-core` was pointed at the same live
workspace and sampled every 10 s. The run finished clean: **17:25:30Z → 17:50:56Z, 25 min 26 s,
all 7 stages, `retryCount: 0`, no block, no human stop, 51 units, 36 doc groups, terminal status
`done`.** So this is not a report about a broken pipeline; it is what a healthy run looked like
through Core's window.

**163 samples, 10 s apart.** Each sample captured four channels at the same instant: `pgrep -f
ksk-stage` (is a stage process alive), `GET /api/runs` (the orchestrator's own in-memory truth),
`run-state.yaml` read directly (disk truth), and `GET /v1/jobs/{jobId}` (Core's claim).

```
samples with a run record:                    158
  orchestrator said active=true:              151   ->  keying-core said active=false in 151 of 151
  orchestrator said active=false:               7   ->  keying-core agreed (correct)

samples in which keying-core EVER reported active=true or queued=true:   0   (of 163)
```

It never once, in 163 samples, said a run was running. And the seven times it said a run was *not*
running it was right, because by then it wasn't.

Both processes ran **natively under Bun on the host, not in Docker** — see §4.3 for why Docker was
not an option on a Mac. That makes this a *verified natively* result.

Separately, an earlier smoke test booted the service against the real workspace
(`~/Dropbox/สารบัญงานบัญชี_For Ton`) in ~5 ms and exercised all six routes: 70 client folders,
**22 valid `YY-MM` months, and 61 month folders skipped across 26 clients** — the workspace holds
almost three times as many non-matching month folders as matching ones, because it predates the
format rule. Only 2 of the 61 look like a mistyped month (`ยอดขาย 5-69`, `PND 53`); the rest are a
different filing convention entirely (`ค่าใช้จ่าย`, `รายได้`, `STM`, `ไฟล์นำเข้า` — folders
organised by document kind). The migration those warnings imply is bigger than a rename pass.
`status` stayed `ready` with all 61 warnings, which is the specified behaviour.

### 1.2 Trust

- **Identity.** `(clientKey, monthKey) → jobId`, the Buddhist `2569-05 → 69-05` mapping, Thai keys
  with parentheses and spaces, canonicalisation of URL-encoded keys. Exercised against real folders
  end to end, in both the smoke test and the live run.
- **Which stage a month is on.** All six stage boundaries tracked, with lags of 7 s, 6 s, 9 s, 10 s,
  7 s and 5 s against `run-state.yaml`'s own `updated_at`. Every one is at or under the 10 s poll
  interval — the signature of a service with no staleness of its own. It reads the file on every
  request and holds no cache; the delay was entirely the sampler's.
- **`version` as an ordering token.** `0 → 10` across 163 samples, strictly non-decreasing, +1 per
  real change only, no bump on a plain re-read (32 consecutive reads sat at `v=2`). It also held
  when the disk state was later moved *backwards* by hand (`done → blocked → stopped-for-human →
  done`, ending at `version: 13`). §1.6's monotonicity requirement is met.
- **Terminal reporting.** `done`, `finishedAt`, `counts` (`totalUnits: 51, reviewed: 42, excluded:
  9, groupCount: 36, attention: 31`), `retryCount`, `allowedCommands: ["repair"]` — all matched the
  orchestrator and the disk to the millisecond.
- **`repairImpact`.** Honest on a cold month, mid-run, and on a freshly-completed one. The smoke
  test had found a real month reporting `destroys: true, editedGroups: 38` of `groupCount: 38`
  where nothing had been edited — every pre-sidecar group taking the fallback marker. On the PR
  head the same object reports `destroys: false, certainty: "known", editedGroups: 0`, and the run
  wrote the `review-data.ai.json` baseline sidecar for all 36 of its groups. That defect is closed
  by observation, not by argument.
- **`humanStop[]`, including drift.** An unrecognised condition comes back with `condition: null`,
  `conditionRaw` verbatim, a Thai message naming the drift and a remedy telling the person to
  report it, plus one `warn` line. *(Synthetic — the live run never blocked — but the mechanism is
  unambiguous.)*
- **The error model on the wire.** Every deliberate rejection returned the §2 body shape with a
  Thai message and no host path: `400 invalid_client_key` on `../../etc` (refused at the *format*
  check, before the path guard is consulted — a client key may not contain `/`), `400
  invalid_month_id` on `69-5`, `404 month_folder_not_found` on a month not on disk, `400
  invalid_month_key` on a platform-truncated `69-05`, `401 unauthorized` with no token, and `400
  validation_failed` with `problem: "unknown_route"` for `POST /v1/jobs/{id}/start`.

### 1.3 Do not trust

- **Anything that describes motion.** `queued`, `active`, `observedStatus`, `queuePosition`, and
  `GET /v1/health/ready`'s `queue{depth,active}` are hardcoded to "nothing is happening". A screen
  must not be built on them and a scheduler must not read them.
- **`allowedCommands` on a run that might be moving.** See §1.4 — it is inverted precisely when it
  matters.
- **`counts` as a finished result.** It is live from Stage 1, not from `final` (§1.5).
- **`checks.orchestrator.ok: true`.** Captured while `claude -p /ksk-stage-segment` was executing,
  `GET /v1/health/ready` returned `queue: {depth: 0, active: 0, concurrency: 1}` and
  `checks.orchestrator: {ok: true, reconciledAt: "…T17:24:01.225Z", pendingRequests: 0}` — with
  `reconciledAt` frozen at Core's own boot time. It asserts a healthy, reconciled orchestrator that
  Core has never spoken to. That is a *stronger* claim than `checks.sqlite` makes about its own
  missing dependency (`{ok: false, reason: "sqlite_not_implemented"}`), and it is the wrong way
  round: the unimplemented dependency is honest, the unwired one is not. A fleet dashboard reading
  `queue{}` sees free capacity while the single concurrency slot is fully occupied.

**The root cause is single, and the source already names it.**
`keying-core/src/application/scheduler-view.ts:33-42` binds the `SchedulerView` port to
`unscheduledSchedulerView`, which returns `[]` / `false` by construction. Every "do not trust" item
above is that one object. The README's seam table already says the port is unwired — but a field
*documented* as a placeholder and *shipped* as a confident `false` will be believed.

### 1.4 `allowedCommands` is inverted while a run moves

This is the highest-consequence item and it deserves its own statement. Across every sample where
the orchestrator held the run active, exactly one set was ever returned:

```
["start","repair"]
```

Never `stop`. Not once. Against what `console/app/orchestrator.ts` would actually do with each, on
a running run:

| Command | Offered? | What the runtime does |
|---|---|---|
| `start` | **offered** | `enqueueRun` → no-ops on an active slot — a button that does nothing |
| `repair` | **offered** | `repairRun` → **`409`** `"งานนี้กำลังทำงานอยู่หรืออยู่ในคิว ไม่สามารถซ่อมได้ในขณะนี้"` |
| `stop` | **hidden** | `stopRun` → aborts the controller and reaps the process group — **the only one that works** |

So the projection offers a dead button and the *destructive* one, and hides the only live control.
`repair` resets the run to Stage 1 and re-enqueues; the runtime's own `409` is the only thing
standing between that button and a clobbered in-flight run. And an operator who needs to stop a run
burning tokens on the wrong month is offered nothing.

**The state machine is not at fault.** `checkCommand`
(`keying-core/src/workflow/state-machine.ts:543-601`) is correct given truthful inputs — line 561
excludes `start` when `active`, line 591 excludes `repair` when scheduled, line 595 includes `stop`
when active. All three branches key on `active`/`queued`. **One wrong boolean flips the entire
command row.** The matrix does not need fixing; the port it reads from does.

The same is true of `observedStatus`: `state-machine.ts:89-93` is `if (queued) → "queued"; if
(active) → "stage-running"; else status`. Fed `active: false`, both guards fall through and it
returns the raw persisted `idle` — and the persisted status is *supposed* to be `idle` while a
stage runs, because `stage-running`/`gate-running` never reach disk. So the derived field that
exists to answer "is this moving?" answers it wrongly, and there is no other field on the wire that
separates a run working normally from a run that crashed mid-stage: both are `idle` with a run
record.

**Nothing breaks today, because the four command routes do not exist** — they are absent rather
than stubbed, and `POST /v1/jobs/{id}/start` returns `400 unknown_route`. This is a defect that
lands the moment they are implemented, which is exactly why finding it now is worth more than
finding it after.

Note also the counterweight, because it bounds the blast radius: on a run **at rest**
`allowedCommands` is correct. A synthetic `blocked` run at `interpret` with one retry used returned
`retriesRemaining: 1` and `["retry","repair"]`; a `stopped-for-human` run returned `["repair"]`.
A blocked or stopped run genuinely *is* at rest, so `active: false` happens to be true and the
matrix produces the right row. **The scheduler lie only bites while a run is moving** — which is
precisely the window a person is most likely to be watching.

### 1.5 `counts` appears four stages before the contract allows

`run-contract.ts:19-22` documents `counts` as *"`null` until the `final` gate has written them."*
The live run falsifies that:

```
17:32:17Z  v=2  counts=null
17:32:27Z  v=3  counts={"totalUnits":51,"reviewed":0,"excluded":9,"groupCount":0,"attention":0}
```

17:32:27Z is **during Stage 1's gate**, not `final`. `readLedgerCounts`
(`workspace-repository.ts:128-143`) returns as soon as `_pages/ledger.yaml` exists, and the
*segment* Ledger Gate writes it — stage 1 of 7. The progression:

| Time | Stage | `counts` |
|---|---|---|
| 17:25–17:32 | profile, segment | `null` |
| 17:32:27Z | segment gate | `u=51 rev=0 exc=9 grp=0 att=0` |
| 17:47:47Z | group | `u=51 rev=0 exc=9 grp=36 att=0` |
| 17:50:58Z | final / done | `u=51 rev=42 exc=9 grp=36 att=31` |

Every number is a true fact about the ledger; the **window** is wrong, and the contract tells the
platform to cache them. From 7 minutes into a 25-minute run, a card would have read *"51 units · 0
reviewed · 9 excluded · 0 groups"* — indistinguishable from *"the run finished and nobody reviewed
anything"*, which is precisely the state a reviewer is asked to act on.

### 1.6 Two sequencing facts the platform integration needs

- **`GET /v1/jobs` lists registered jobs, not discovered months.** The smoke workspace held 22
  valid months and the list returned 2, because only 2 had been registered. That is per spec
  (registration is explicit via §5.4 / §5.13), but it means the office platform must resolve every
  งวด it wants to see before any of them appear.
- **Registrations do not survive a restart.** `JobRepository` is in-memory until the SQLite adapter
  lands. This is why persistence is step 1 of §4.

### 1.7 One item this evidence does not settle

The smoke test found a second defect: a month whose `run-state.yaml` is corrupt produced a list row
**byte-for-byte identical** to a month that never ran — same `status: "idle"`, `hasRunRecord:
false`, `counts: null`, `failReason: null`, with no key present on one and absent on the other. The
single-subject read did hard-fail correctly (`422 artifact_malformed`, `reason:
"run_state_unparseable"`), and `resolve` still returned a `jobId` so the repair path stayed
reachable — but the visibility half of the decision had not landed.

`aa35e63` adds an additive `artifactProblem` marker that appears intended to close it (README
finding 7). **The live run did not exercise this** — no artifact was corrupted during it — so it is
neither confirmed nor refuted by the evidence in this document. Someone should corrupt a
`run-state.yaml` on the current head and check the list row before treating it as closed.

---

## 2. Three open questions

These change either the PR's scope or the wire contract, so they are recorded as questions with
their options rather than as recommendations wearing a decision's clothes.

### Q1 — Wire the scheduler port before merging, or merge without it?

The four fields in §1.3 and the command row in §1.4 are all one unwired port. The options:

- **(a)** Merge #70 with `SchedulerView` unwired, as it stands. The service is genuinely useful
  today for identity, stage tracking and terminal state; nothing consumes the motion fields yet
  because no client exists.
- **(b)** Land the `SchedulerView` adapter over the real `Orchestrator` inside #70, before merging.
  It is read-only and it is the cheapest remaining piece of work; it makes the existing projection
  honest without adding a route.
- **(c)** Merge, but mark those fields provisional on the wire — so the platform cannot build on
  them by accident.

The cost of getting this wrong is not distributed evenly across the options: under (a), any screen
built between merge and the adapter is built on a `false` that is never anything but `false`.

### Q2 — Withhold `allowedCommands` while the port is a stub?

`allowedCommands` is the field §5.5 exists to provide *"so a client never has to guess and never
has to POST to find out"*, and while a run moves it recommends the destructive command and
withholds the safe one (§1.4). The options:

- **(a)** Keep emitting the row. It is correct for every run at rest, the command routes do not
  exist yet, and the runtime's own `409` refuses the dangerous case.
- **(b)** Withhold the whole key under §1.3's missing-key rule — "this route does not carry that
  fact" — until the scheduler port is wired. A missing key is a fact a client can handle; a
  confidently wrong row is not.

Note that (b) is only distinguishable from (a) for the window in which a run is moving, and that
Q1(b) dissolves the question entirely.

### Q3 — Gate `counts` on `final`, or amend the contract?

`run-contract.ts:19-22` says `null` until `final`; the code returns it from Stage 1 (§1.5). One of
the two is wrong. The options:

- **(a)** Gate `counts` on the run having reached `final`/`done`, as the contract already says.
  The platform then caches only complete numbers.
- **(b)** Keep the live counts and carry a completeness marker beside them, the way
  `repairImpact.certainty` now does for the same class of problem — the codebase has already solved
  this shape once. Live partial counts are useful progress information if they are labelled as
  partial.
- **(c)** Amend the contract to match the code, i.e. document `counts` as live-from-the-ledger and
  make the platform responsible for not treating `reviewed: 0` as final.

---

## 3. Stage 2: inlining the leaf prompt — measured

A separate experiment measured whether Stage 2's per-page leaf should stop being a
"packet of paths + `Read`/`Write` tools" agent and become a "packet of content + the model returns
JSON" call. **It should.** The result is large and it costs nothing in correctness.

### 3.1 What was measured

Ten pages of the same client-month as §1 (`216 / 69-03`), the same 10 pages for all variants, the
same model (`sonnet`, which `.claude/agents/ksk-watson.md:5` pins), same host, same day,
back-to-back. Pages picked deterministically: all 4 income documents (the rarest kinds, the only
sales side, the largest amounts) plus 6 expense documents at evenly-spaced ranks of the
`gross_total`-sorted list of the 31 Grab invoices, spanning ฿37.76 → ฿1,952.79.

The baseline was **not** taken from anyone's prior claim: it was re-measured by importing the real
prompt builder verbatim from `console/sequencer/interpret-executor.ts:242` (`buildLeafPrompt`) and
the real arg list from `:281`, with an assertion that both still match the repo source before
running — so pipeline drift would fail the experiment rather than silently invalidate it. All
variants ran with `--strict-mcp-config --setting-sources project` so this host's SessionStart hooks
and claude.ai MCP servers (absent in the containerised production leaf) were suppressed identically.

| | A — baseline (today) | B — inline, 1 process/page |
|---|---|---|
| invocation | `claude -p <packet> --agent ksk-watson --tools Read,Write` | `claude -p --input-format stream-json --tools "" --system-prompt <inlined>` |
| fixed material | 4 × `Read` (schema, playbook, page image, `CLIENT.md`) | in the system prompt + an image content block in the message |
| output | leaf `Write`s `interpretation.json` + `fragment.json` | model returns JSON; **the executor** writes the file |

### 3.2 The numbers, per page, mean over 10 pages

| | A baseline | B inline |
|---|---|---|
| **turns** | **8.0** | **1.0** |
| **wall clock** | **44.8 s** | **16.3 s** (15.7 s steady) |
| new input tokens | 6 | 2 |
| **cache creation** | **32,520** | **4,035** (steady) |
| cache read | 42,650 | 19,904 (flat) |
| **output tokens** | **3,951** | **1,260** |
| **cost / page** | **$0.2687** | **$0.0498** (steady) |
| 10-page total | $2.687 | $0.618 |
| retries | 0 | 0 |
| schema-valid (pipeline's own validator) | 10/10 | 10/10 |

Cost is the CLI's own `total_cost_usd`, and it reconciles to Sonnet list pricing with the 1-hour
cache TTL this account uses (write $6/MTok = 2× base, read $0.30/MTok, output $15/MTok): modelled
$0.2501 against a reported $0.2516 for A's first page.

**Correctness.** All 10 B outputs pass the pipeline's own
`.claude/skills/ksk-keying/scripts/validate-interpretation.ts`, canonical. Field agreement against
the real run's 36 interpretations on disk: `doc_kind`, `document_no`, `document_date`,
`counterparty_tax_id`, `gross_total`, `vat`, `wht` — **10/10 for both A and B.** Every
book-corrupting field matches. `counterparty_name` is A 9/10, B 8/10, and all three disagreements
are the same string: whether Grabtaxi carries a `(Head Office)` suffix. **The real run is itself
inconsistent about it — 27 of its 31 Grab documents carry the suffix and 4 do not**, the same
branch line on the same supplier's identical invoice template. A dropped it on one page; B added it
on the two pages where the real run happened to drop it, i.e. B picked the majority form. Nothing
here changes a booking: the tax id (`0105556090377`) is identical in every case, and tax id is what
the COA and ledger stages key on. Output richness is equivalent, not thinner (10 line items, 6
review flags, 10 `page_disposition` entries for B against 10 / 6 / 10 for the real run). Zero
retries and zero errors across all trials.

### 3.3 Why it is cheaper — the mechanism, not just the ratio

A's turn trace, identical on all 10 pages:

```
1 Read  references/schemas/segment-interpretation.md   (20 KB)
2 Read  references/extract-playbooks.md                (17 KB)
3 Read  CLIENT.md                                      (11 KB)
4 Read  page-001.png                                   (~2.3 k tok)
5 Write interpretation.json
6 Write fragment.json
7 digest reply
```

(Eight turns, counting the protocol's final tool-result round.) Two independent costs come out of
that shape, and A's $0.2687 splits **73 % cache creation, 22 % output, 5 % cache read**:

1. **The same bytes cost ~20× more arriving as `Read` tool results than as a cached system
   prompt.** Every tool result lands in the conversation and is written to cache at $6/MTok, and
   the prefix is re-cached as it grows — 32,520 cache-creation tokens per page, for material that
   is byte-identical on every page of every client. Inlining puts the same bytes in the *system
   prompt*, where they are written once and thereafter **read** at $0.30/MTok.
2. **A leaf that writes its own files generates the payload twice.** Two `Write` calls means
   emitting the full interpretation JSON twice, plus a digest: 3,951 output tokens against B's
   1,260. Moving the file write to the executor is worth ~2,700 output tokens per page on its own
   (~$0.040 of the $0.219 saved) — an output cost nobody had framed the multi-turn shape as
   carrying.

*One correction worth recording so it is not re-derived:* the ~110,000-token cache-creation figure
that had been circulating **did not reproduce** — the real number is ~32,500. Same shape, smaller
number; the larger figure was likely measured with this host's SessionStart hooks and MCP tool
definitions loaded (worth ~20 k on their own). The conclusion is unchanged and the A:B ratio here
is, if anything, conservative.

**Extrapolated** to a full 36-page month (cold start + 35 steady pages, serial) — a projection from
the per-page means above, not a measurement:

| | cost | wall clock |
|---|---|---|
| A baseline | $9.66 | ~27 min |
| B inline | $1.91 | ~10 min |

### 3.4 The change, concretely

1. `buildLeafPrompt` (`console/sequencer/interpret-executor.ts:242`) inlines the schema, the
   playbook and `CLIENT.md` into a `--system-prompt` instead of naming their paths; page images go
   in as base64 image content blocks over `--input-format stream-json`.
2. `--tools ""`. The leaf's `Read`/`Write` grants — and with them the entire class of "the leaf
   wandered off and read a neighbouring file" risk that `ksk-watson.md`'s input contract spends
   half its text defending against — disappear structurally rather than by instruction.
3. `executeInterpretPlan` writes `interpretation.json` from the parsed response and derives the
   `ksk_disposition_fragment.v1` YAML from the object's `page_disposition` (consumed by
   `.claude/skills/ksk-keying/scripts/merge-dispositions.ts`). Validation, retry and the ledger stay
   exactly where they are — the executor already owns them, and a JSON-parse failure becomes one
   more deterministic validation error feeding the existing retry path.
4. Keep the substantive `ksk-watson.md` text (Scope, Accounting rules) verbatim. The experiment
   changed only the I/O contract, and that is the only thing worth changing.

### 3.5 The negative result: do not batch pages into one process

A third variant was measured — one process for all 10 pages, 10 user messages down one stdin — on
the premise that it would pay the cache-creation cost once. **The premise is wrong, and the variant
is worse. Someone will propose it again; this is the answer.**

- **The prompt cache already spans separate `claude -p` processes.** B's page 1 paid 23,885
  cache-creation tokens; pages 2–10 each read **19,904 from cache** with `cache_creation` down to
  ~4,035 (just the page image) — in ten *separate* processes. Server-side prefix caching does not
  care about process boundaries. The batched variant exists to pay a fixed cost once; B already
  pays it once. There was never a single fixed block to amortise.
- **The batched variant gets monotonically worse.** Its `cache_read` climbs **+5,026 tokens per
  page and never comes back down**, because every prior page's image and every prior answer stays
  in the prefix:

```
batched cache_read : 23,885 → 23,885 → 29,553 → 34,232 → 38,907 → 44,443 → 49,616 → 54,437 → 59,257 → 64,090
batched cost/page  : $0.0350  $0.0535  $0.0492  $0.0623  $0.0634  $0.0577  $0.0570  $0.0587  $0.0601  $0.0615
B       cache_read : 0 → 19,904 → 19,904 → …  (flat)
B       cost/page  : $0.1698  $0.0542  $0.0486  $0.0624  $0.0519  $0.0440  $0.0459  $0.0537  $0.0440  $0.0440
```

  Its 10-page total ($0.559) beats B's ($0.618) only over these ten pages, and only because it
  happened to warm on B's cache; its per-page cost is *rising* while B's is flat. **Extrapolated**
  to a 36-page month it crosses over and keeps climbing.
- **It gives up the two things that make the current design safe:** per-page isolation (page 7's
  reading can no longer be contaminated by page 3's) and per-page retry (a single failure poisons
  the whole process).

### 3.6 What the experiment did not cover

Two cases a real implementation must handle and this measurement says nothing about:

- **Multi-page units.** `seg-001`, the 7-page bank statement, was deliberately excluded — it is one
  7-page *unit*, not a page, and including it would have made the per-page columns incomparable. A
  multi-page unit means up to 15 images in one message. Expect the same shape with more image
  tokens, but that is an expectation, not a measurement. A hard cap on total inlined bytes per
  message is needed.
- **Spreadsheet units** (`ksk-marple`), whose inputs are JSON sheet artifacts rather than page
  images. Plausibly an even better fit for inlining, since the material is text — but unmeasured.

---

## 4. What to do next, in order

The order is not preference; each step is where it is because of what it unblocks.

**1. SQLite persistence** — `keying_jobs`, `workflow_requests`, `run_projections` behind the three
existing ports (`JobRepository`, `RunProjectionStore`, and the request/receipt store). *Why first:*
everything below needs durable job rows and durable receipts to live in. Today a restart forgets
every registration, so there is nowhere to put an idempotency receipt and nothing for boot
reconcile to reconcile. When it lands, `checks.sqlite.ok` joins the readiness condition per plan
§8.4 step 1 — today it is deliberately excluded so that a failing check does not make every route
permanently `503`.

**2. The `SchedulerView` adapter over the real `Orchestrator`** — *Why second, and why before any
command route:* it is read-only, it is the cheapest remaining piece of work, and it is the single
change that turns every item in §1.3 and the inverted row in §1.4 from wrong to right. It unblocks
honest screens. Doing it *after* the command routes would mean shipping a wrong command row with
live buttons behind it; doing it before means the row is already correct on the day the buttons
appear. (This is Q1 in §2 — if Q1 is decided as (b), this step happens inside #70.)

**3. The four command routes** (`start` / `retry` / `repair` / `stop`) wired to `enqueueRun` /
`retryRun` / `repairRun` / `stopRun`, with the `Idempotency-Key` receipt flow of §1.5 / §8.4 in
front of them. *Why here:* the legality decision and its `409`s already exist and are tested — only
the execution half is missing — but the receipts have nowhere to persist without step 1 and the
legality inputs are fabricated without step 2. This is also the step where the three open README
findings about the command matrix (§3.4's `queued` row vs §5.7, and the `fatal-cleanup` latch) stop
being unreachable and become the slice's first decisions.

**4. Boot reconcile** — plan §8.4 steps 2–5: boot the orchestrator, reapply pending receipts
idempotently, refresh projections. *Why after 3:* there is nothing to reconcile until a command can
be accepted. *Why not later:* without it, a crash between writing a receipt and enqueueing the run
silently loses an accepted command — the window opens the moment step 3 ships.

**5. SSE** (`/v1/events`, `/v1/jobs/{id}/events`) and the event envelope. *Why here rather than
earlier:* the platform can poll, and §1.2 shows polling is cheap and accurate (no server-side
staleness, `version` is a sound ordering token). *Why not never:* §10.2's "late, never silent"
guarantee needs a push channel; polling can be late *and* silent.

**6. Then the rest** — the review and exclusions routes, the document and export routes, and the
CLI. None of them is on the critical path for making a run movable through `/v1`.

### 4.1 A process-level caveat that lands at step 3

At step 3, Core becomes the thing that spawns `claude -p`. Whichever process serves `/v1` must then
have the workspace mount, the `.claude` skills mount **and** working Claude credentials. Today only
the console container is set up that way, and `keying-core/` has no `Dockerfile` and no compose
service. Until step 3, none of this matters — `bun run src/main.ts` is the whole story, because the
service spawns nothing.

Three measured blockers stand between `console/`'s container story and running any of it on a Mac,
and they are worth recording because two of them are structural rather than configuration:

| Blocker | Detail | Fix |
|---|---|---|
| GID 20 collision | macOS gives every user primary group `staff` = GID 20; in Debian (which `oven/bun:1` is built on) GID 20 is already `dialout`, so `groupadd -g 20 app` exits 4. **`compose build` fails on every Mac**, not just this one | one line: `groupadd -g ${GID} app \|\| true` in `console/Dockerfile:17` |
| No credential | `~/.claude/.credentials.json` does not exist on macOS — the token lives in the login Keychain — so the `${HOST_HOME}/.claude` mount carries the directory and no token. Verified for real: `claude -p` in the built image returns `"Not logged in · Please run /login"` in 45 ms with `total_cost_usd: 0` | `claude setup-token` inside the container (Linux, so file-based), which creates a second independent session |
| `network_mode: host` | A Linux/Pi construct; on Docker Desktop for Mac it does not put the container on the host's loopback, and the compose file publishes no ports. Controlled test: the same server is reachable under `-p 8941:8941` and unreachable under `--network host` | a Mac-only compose override publishing on the bridge |

The workspace mount itself works fine — Thai client folder names resolve correctly through Docker
Desktop's file-sharing layer, which was not obvious in advance. Net: **the container path is a
Linux/Pi deployment story.**

### 4.2 Two small honesty fixes with no decision attached

Neither changes scope or contract, and both were identified with an obviously-correct answer:

- **`checks.orchestrator`** should be as honest as `checks.sqlite`: `{ok: false, reason:
  "orchestrator_not_wired"}` is the truthful analogue and costs nothing. It becomes moot at step 2.
- **`console/Dockerfile:17`** — the one-line GID fix above. Independent of everything else, and it
  currently makes `compose build` impossible on any macOS host.

---

## 5. What none of this found

Worth stating, because it bounds the above: **no logic error was found in the state machine, the
error model, the identity layer, or the projection assembly.** All four held up under a real
25-minute run against a real workspace, against a corrupt-artifact probe, and against synthetic
`blocked` / `stopped-for-human` states. Almost everything in §1.3 and §2 is one unwired port not
telling the truth about being unwired.

## 6. Provenance

The three investigations behind this document ran in disposable worktrees outside this repository
and their raw evidence (sample timelines, captured response bodies, per-trial stream logs) is not
preserved here. Everything load-bearing has been carried into the text above; nothing in this
document depends on retrieving them. To re-establish any of it from scratch: boot `keying-core`
and `console/` against the same workspace on different ports, register a job through `POST
/v1/jobs`, start the run through `POST /api/runs`, and sample `GET /v1/jobs/{jobId}` against `GET
/api/runs`, `run-state.yaml` and `pgrep -f ksk-stage` on a fixed interval.
