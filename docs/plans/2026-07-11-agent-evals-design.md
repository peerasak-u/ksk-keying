# Agent evals — design (draft for discussion)

Date: 2026-07-11
Status: draft — not yet approved, nothing implemented

## Why

Running the full `/ksk-keying` workflow end-to-end to find out whether one agent
got better or worse takes hours and conflates every stage's errors. We want
unit-test-style evals: each agent (watson, poirot, sherlock, columbo, magnum) and
each deterministic script (future `stm-extract`) measured in isolation, on a
fixed dataset, with recorded scores — so a prompt or rule change is judged by a
number, not a feeling.

Trigger example (May run, client 216): the "watson missed WHT on doc 033" finding
turned out to be watson behaving correctly (it wrote `wht: null` because the
document prints no WHT, and raised `wht_expected?` with a precise reason). The
gap was downstream policy, not extraction. Without measurement we would have
"fixed" a prompt that wasn't broken. Evals exist to prevent exactly that.

## Principles

1. **Deterministic grading.** The only model in the loop is the agent under
   test. Grading is a Bun script diffing structured output against verified
   ground truth with explicit tolerance rules. No LLM-as-judge, no promptfoo.
2. **Production-fidelity dispatch.** An eval case replays the *same dispatch
   prompt shape* the parent uses in SKILL.md, through the same harness (Claude
   Code Agent tool), with the same agent definition in `.claude/agents/`. If we
   test a different prompt than production sends, the score measures nothing.
3. **Ground truth only from verified runs.** Fixtures are harvested from runs
   that passed the Ledger Gates *and* human review / answer-key comparison.
   Never auto-harvest unverified pipeline output as "expected".
4. **Trust = calibration, not just accuracy.** A wrong value with a review flag
   is a different (much smaller) failure than a silent wrong value. The grader
   scores these separately. "เชื่อใจ watson ได้มากกว่านี้" concretely means: high
   accuracy on critical fields AND near-zero *silent* errors.
5. **Client data never enters git.** Datasets and raw results live under
   `samples/evals/` (gitignored). Only the framework code, grading specs, and
   an aggregate scoreboard (numbers only, no client content) are committed.
6. **Evals are dev-repo tooling, not part of the shipped skill.** They live at
   repo root (`evals/`), not inside `.claude/skills/ksk-keying/` which
   customers install.

## Comparison philosophy (also applies to answer-key grading generally)

Recorded here per 2026-07-11 discussion; applies both to evals and to any
old-result comparison of a finished run:

- Compare **what our agents extracted vs the answer key**, only on the scope
  both sides cover.
- A missing answer-key file (e.g. May's absent "PEAK Expense Grab") is a
  **dataset gap**, not an agent failure — report it, skip that category.
- Month-to-month patterns from other months are *hints* for investigation,
  never ground truth.
- Empty source folders (client didn't deliver documents) are not pipeline
  misses.

## Directory layout

```
evals/                                  # committed
  README.md                             # how to run, philosophy (above), dataset rules
  runner.ts                             # dispatch cases, collect outputs (shared)
  grade.ts                              # deterministic grader engine (shared)
  report.ts                             # per-run report + baseline regression diff
  harvest.ts                            # build fixtures from a verified client run
  agents/
    watson.spec.ts                      # field spec: critical fields, tolerances, matchers
    poirot.spec.ts
    sherlock.spec.ts                    # (phase 3)
    columbo.spec.ts                     # (phase 3)
    magnum.spec.ts                      # (phase 3)
  SCOREBOARD.md                         # committed aggregates only (dataset version, %s)

samples/evals/                          # gitignored (client-derived data)
  watson/cases/<case-id>/
    case.yaml                           # dispatch params + provenance (see below)
    input/                              # copied source pages (pdf/png) — self-contained
    expected.json                       # verified ksk_segment_interpretation.v1
  poirot/cases/<case-id>/
    case.yaml
    input/                              # interpretation.json, coa.csv, CLIENT.md, [coa_usage.json]
    expected.json                       # verified categorize.json
  _runs/<agent>/<run-id>/               # raw outputs + per-case grades (local only)
    <case-id>/output.json
    <case-id>/grade.json
    summary.json
  _runs/<agent>/baseline.json           # pinned reference run for regression diff
```

`case.yaml` (watson example):

```yaml
schema: ksk_eval_case.v1
agent: ksk-watson
case_id: 216-may-seg006-rt001
dispatch:                # values interpolated into the SKILL.md dispatch template
  segment_id: seg-006
  files: ["input/Doc_ RT-20260500001.pdf"]
  page_range: "1-4"
  client_context: { default_buyer: { name: "บริษัท ชามหวาน จำกัด", tax_id: "…" } }
template_version: skill-md@<git-sha-of-SKILL.md-when-harvested>
provenance:
  client: "216 บจก.ชามหวาน"
  month: "เดือนพฤษภาคม"
  source: "รายได้ vat/Doc_ RT-20260500001.pdf"
  verified_by: answer_key + human_review
  harvested: 2026-07-11
```

## Grading model

Per case, the grader emits one of four states **per field**:

| state | meaning |
|---|---|
| `correct` | matches expected within tolerance |
| `wrong_flagged` | mismatch, but the agent raised a relevant review flag / question |
| `wrong_silent` | mismatch with no flag — the dangerous one |
| `missing` / `spurious` | field absent that should exist / invented field-value |

Field classes per agent spec:

- **watson critical**: `document_no`, `document_date`, `seller_tax_id`,
  `buyer_tax_id`, `gross_total`, `vat`, `wht`, `direction`, `doc_kind`.
  Amounts tolerance ±0.01; dates exact ISO; ids exact string.
  Line items matched by amount (±0.01) then description similarity; unmatched
  lines count as missing/spurious.
- **watson soft**: `description`, `seller_name`/`buyer_name` (normalized
  compare), line descriptions.
- **poirot**: `account_code` exact per line; `confidence`+`needs_review`
  feed the calibration metric (a wrong code marked low-confidence =
  `wrong_flagged`).

Aggregates per run:

- **field accuracy** per critical field across cases
- **case pass rate** = all critical fields correct
- **silent error rate** = `wrong_silent` / total critical fields ← the trust number
- optional **stability mode**: `--repeat 3` reruns each case, reports per-field
  variance (catches nondeterministic extraction)

`report.ts` prints the table, diffs against `baseline.json`, and exits 1 on
regression in any critical-field accuracy or silent-error rate — usable as a
gate before merging a prompt change. `--set-baseline` pins the current run.

## Runner mechanics

Two modes, same case format:

1. **Skill mode (phase 1, works today)** — `/ksk-eval watson [--cases …]`:
   a parent Claude Code session reads the case list, dispatches `ksk-watson`
   via the Agent tool per case (parallel batches), pointing `resultPath` into
   `samples/evals/_runs/…`, then runs `grade.ts` + `report.ts`. Same harness,
   same model config as production dispatches.
2. **Headless mode (later)** — `runner.ts` shells `claude -p` per case for
   unattended batch runs. Exact CLI invocation (agent selection flags,
   permission mode) to be verified during implementation; not a phase-1
   dependency.

Isolation rules:

- Eval agents write only inside `samples/evals/_runs/`; they never see the
  original client folder (inputs are copied into `input/`), so an eval can
  never contaminate a production run — and a production run never reads
  `samples/evals/` (add to the CLAUDE.md hard rules alongside the old-result
  rule).
- `harvest.ts` refuses to build a case from a month whose ledger gate isn't
  `pass` or that lacks a verification source (human review / answer key).

## Dataset to prepare (harvest plan)

From client 216 (answer keys exist for มีนาคม/เมษายน/พฤษภาคม) and clients
345/356 where verified:

- **watson**: one case per verified segment/sub-document — target ≥30 cases
  covering: normal invoices, the Grab zip sub-invoices, WHT-printing docs
  (034) vs WHT-absent-but-expected docs (033 — expected output *is*
  `wht: null` + `wht_expected?` flag), multi-page income docs (seg-006),
  bank-statement summary behavior.
- **poirot**: every verified categorize decision, in two variants —
  `with-coa-usage` / `without-coa-usage` — to measure exactly how much
  history closes gaps like 410101→410201. (coa_usage.json for 216 gets built
  from verified มีนาคม/เมษายน data — separate small task, feeds this.)
- **stm-extract (script, future)**: May STM text-PDF → expected rows derived
  from the answer-key STM xlsx (140 ถอน + 186 ฝาก). This is a plain unit test
  (deterministic in/out), but shares the same dataset folder + provenance
  format.

## Phasing

1. **Phase 1 — framework core + watson**: layout, `harvest.ts`, `runner`
   (skill mode), `grade.ts` + `watson.spec.ts`, `report.ts`, first dataset
   from 216, baseline pinned, SCOREBOARD.md seeded.
2. **Phase 2 — poirot** (+ the coa_usage build for 216): cheapest agent to
   eval (JSON→JSON, no vision), directly measures the point-2 hypothesis.
3. **Phase 3 — sherlock / columbo / magnum + stm-extract tests** as those
   features/datasets mature.

## Side findings recorded (out of scope here, need their own fixes)

- **Windows/PowerShell compatibility**: scripts already hard-depend on poppler
  (`pdfinfo` in `inventory.ts`, `pdftoppm` in `prepare.ts`) but detect it with
  `which` and advise `brew install poppler` — both mac-only. Poppler does ship
  Windows builds (winget/choco/scoop or poppler-windows zips), so the fix is
  detection via `Bun.which` + platform-neutral install guidance in README —
  and it means a future `stm-extract` can safely use `pdftotext` (same poppler
  install, no new dependency).
- **`wht_expected?` flags need a consumer**: a Decision Policy / review-stage
  rule so a flagged, convention-covered WHT (e.g. juristic landlord rent) gets
  booked instead of silently staying null.
