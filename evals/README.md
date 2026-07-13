# Agent evals

Unit-test-style evals for the ksk-keying agents: each agent measured in
isolation on a fixed, verified dataset, with recorded scores. Dev-repo tooling
only — none of this ships with the skill. Design doc:
`docs/plans/2026-07-11-agent-evals-design.md`.

## Layout

```
evals/                      # committed: framework + specs + aggregate scoreboard
  harvest.ts  dispatch.ts  grade.ts  report.ts  lib.ts  specs/<agent>.ts
  SCOREBOARD.md
samples/evals/              # gitignored: client-derived data
  watson/VERSION            # dataset version — bump when any expected.json changes
  watson/cases/<case-id>/   # case.yaml + input/ + CLIENT.md + expected.json
  fixtures/<stage>/<client>/# per-stage frozen snapshots — input to a stage eval
  _runs/<agent>/<run-id>/   # raw outputs, grade.json per case, summary.json
  _runs/<agent>/baseline.json
samples/clients/<client>/   # gitignored: raw client folders (prepared from Dropbox)
samples/answer-keys/<client>/  # gitignored: PEAK-export ground truth (was old-result)
```

## Running an eval (the `/ksk-eval` skill automates this)

```bash
cd evals && bun install          # once
bun run dispatch.ts -- watson [--cases a,b] [--replicates 3] [--note "why"]
# → prints one dispatch prompt per case/replicate and creates the run dir.
#   The parent Claude session spawns ksk-watson (Agent tool) per block, in
#   parallel batches, then:
bun run grade.ts  -- watson --run <run-id>
bun run report.ts -- watson --run <run-id>            # exit 1 on regression
bun run report.ts -- watson --run <run-id> --set-baseline
```

Update `SCOREBOARD.md` (aggregates only — never client data) after a run worth
recording.

## How expectations are set

`expected.json` is **what a correct agent returns under its own contract**, not
the idealized answer-key booking. Watson's contract is "record what the
document shows, flag what it can't" — so a rent invoice that prints no WHT has
`wht: null` **plus** an expected flag (`expected_flags: [wht]` in `case.yaml`),
even though the accountant books WHT downstream. Grading a leaf agent against
downstream policy outcomes would punish correct behavior.

Ground-truth precedence when harvesting:
1. values confirmed by the answer key (`samples/answer-keys/…`) after a blind run
2. values confirmed by human eye-check
3. fields the answer key doesn't cover: taken from the human-reviewed run

`harvest.ts` refuses months whose ledger gate isn't `final`/`pass`. Cases whose
verification is incomplete are marked `provisional: true` — they run and are
reported, but the headline **silent-error rate** counts solid cases only.

## Grading model

Only the agent under test is a model; grading is deterministic. Per critical
field (`document_no`, dates, tax ids, `gross_total`, `vat`, `wht`, `direction`,
`doc_kind`): `correct` / `wrong_flagged` (mismatch but a review flag mentions
the field) / `wrong_silent` / `missing_value` / `spurious_value`. Amounts
tolerate ±0.01; names compare normalized; doc-kind aliases in the spec.

**The trust number is the silent-error rate** — a wrong value with a flag gets
caught by human review; a silent wrong value walks into PEAK. Case pass =
every critical field correct + all expected flags present + no missing/spurious
documents.

`--replicates N` spawns N independent subagents per case **in parallel** (same
prompt, separate `output-rN.json`); the grader adds a per-field agreement check
across replicates to separate instability from bad rules.

## Comparison philosophy (applies to all answer-key grading)

- Compare extracted output vs the answer key only on scope both sides cover.
- A missing answer-key file is a dataset gap, not an agent failure.
- Month-to-month patterns from other months are hints, never ground truth.
- Empty client source folders are not pipeline misses.

## Dataset hygiene

- Never harvest unverified pipeline output as expected.
- Production runs must never read `samples/evals/` (and eval cases are
  self-contained copies, so eval runs never touch client folders).
- When an expected.json turns out wrong: fix it, bump `VERSION`, re-run and
  re-pin the baseline. Never edit an expectation silently.
