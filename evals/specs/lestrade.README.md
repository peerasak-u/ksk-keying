# ksk-lestrade eval — seeded-claim confusion matrix

First-cut eval for `ksk-lestrade`, the Stage-2 **exclusion-claim auditor**. lestrade
does not read documents to book them; it AUDITS claims another agent made —
"page N is excluded because duplicate / blank / summary sheet / …" — by opening
only the referenced pages and returning a binary verdict: `confirmed` (the
exclusion is legit) or `refuted` (the page is really bookable; the exclusion is
wrong). It never edits interpretations.

So its quality is **not** field accuracy — it is a detector's quality: does it
CATCH a bad exclusion (a real primary bookable wrongly marked excluded) without
FALSELY rejecting a good one? That is a confusion matrix, and that is what this
eval measures.

> Status: **scaffolding + tested grader + dataset, for human review.** No live
> baseline has been run or pinned yet — that is a deliberate follow-up.

## Confusion matrix

Positive class = "this exclusion should be **refuted**" (i.e. it is a bad
exclusion that must be caught). The decision read from lestrade's output is
`alarm = (verdict === "refuted")`. A `confirmed`, a **missing** verdict, or an
**unparseable** verdict all count as *no-alarm* — because the disposition merge
leaves an un-refuted exclusion in place, so the page is dropped either way; a
silently-unaudited bad exclusion is exactly as dangerous as an explicit wrong
`confirmed`.

| ground truth (from the page, never the answer key) | lestrade refutes | lestrade confirms / no verdict |
|---|---|---|
| `seeded_false` — real bookable mislabeled excluded (**positive**) | **TP** catch | **FN** miss ← *dangerous* |
| `true_exclusion` — page really is duplicate/blank/summary (**negative**) | **FP** false-alarm | **TN** confirm |

Reported rates (null when the denominator is 0):

- **miss-rate = FN / positives** — the trust number. A miss means a real primary
  bookable gets silently dropped from the books. Drive this to 0.
- catch-rate = TP / positives = 1 − miss-rate (recall / sensitivity).
- false-alarm-rate = FP / negatives — good exclusions wrongly reopened (noise, not danger).
- confirm-rate = TN / negatives (specificity).
- precision = TP / (TP + FP) — when it refutes, how often it is right.
- accuracy = (TP + TN) / total.

A case **passes** only when every claim is verdicted and every verdict is correct
(no miss, no false alarm, nothing unresolved).

## Dataset design (`samples/evals/lestrade/` — gitignored)

10 self-contained cases, each `cases/<id>/` holding: `case.yaml` (the claim as
watson/marple declared it — **no** ground truth), `expected.yaml` (the
ground-truth verdict), `GROUND-TRUTH.md` (the human-readable basis + seeding
method), and a `client/` clone containing just the referenced pages (extracted &
renumbered from the ship-run source PDFs) plus a minimal `interpretation.json`.

**5 true-exclusion cases** (expect CONFIRM):

| id | claim | one-line basis (why the exclusion is legit) |
|---|---|---|
| `t01-dup-identical-slip` | p2 `duplicate` of p1 | two identical copies of one tax invoice (same number / date / total) |
| `t02-cash-summary` | p1 `reference_report` | a `รายการปิดเงินสด` cash-closing recap sheet (many rows), not a primary doc |
| `t03-voucher-register` | p1 `summary_index_not_bookable` | a `รายงานใบสำคัญจ่าย` payment-voucher register (many rows), not a primary doc |
| `t04-orphan-bank-slip` | p1 `non_bookable_payment_slip` | a bank transfer slip only (payment evidence, no invoice content) |
| `t05-fuel-coversheet` | p1 `reference_report` | a `รายการภาษีซื้อ(น้ำมัน)` fuel cover/index sheet, not a primary doc |

**5 seeded-false cases** (expect REFUTE — a real primary bookable mislabeled):

| id | seeded claim | one-line basis (why it is provably false) |
|---|---|---|
| `s01-blank-taxinvoice` | p1 `blank` | a full printed tax invoice (its own number & amount) mislabeled blank |
| `s02-dup-sameseller-diffdoc` | p2 `duplicate` of p1 | two DIFFERENT invoices from the same seller — different doc numbers & materially different totals — mislabeled duplicate (adversarial) |
| `s03-blank-fuel` | p1 `blank` | a full printed fuel tax invoice (its own number & amount) mislabeled blank |
| `s04-dup-fuel-xseller` | p2 `duplicate` of p1 | two fuel invoices from different sellers (different numbers & amounts) mislabeled duplicate |
| `s05-dup-sameseller-bigamt` | p2 `duplicate` of p1 | same seller, two different invoices (different doc / date / total) mislabeled duplicate |

### Ground-truth method (no answer key)

Per the hard rule, `samples/answer-keys/` is never read. Ground truth comes from
the pages' own content:

- **true-exclusion cases** — candidate pages were taken from a completed ship run's
  own `dispositions.yaml` + `claim-audit/` under `samples/evals/_runs/` (pages the
  pipeline itself excluded), then **independently re-verified by reading the page** (a
  summary/register/slip/duplicate is self-evident). The ship run's prior verdict
  is only a pointer, not the ground truth — grading lestrade against lestrade
  would be circular.
- **seeded-false cases** — a page that is unmistakably a PRIMARY bookable (a
  printed tax invoice with its own doc number and amount, verified by reading it)
  is paired with an authored claim asserting it is `blank` or a `duplicate` of an
  unrelated page. The claim is refutable purely from the page's own content, so no
  answer key is needed to know the correct verdict is REFUTE. The two `duplicate`
  seeds against the *same* seller (s02, s05) are deliberately adversarial — a
  careless auditor could rubber-stamp them.

Rebuild the dataset with `python3 samples/evals/lestrade/prepare.py` (needs the
ship run present; reads only client source PDFs).

## Running it

```bash
cd evals
bun run dispatch.ts -- lestrade [--cases t01-dup-identical-slip,s01-blank-taxinvoice] [--replicates 3] --note "why"
# → creates samples/evals/_runs/lestrade/<run-id>/ with one client-rN clone per
#   case/replicate, and prints one dispatch block per clone. Each block reproduces
#   the PRODUCTION ksk-stage-interpret lestrade invocation verbatim.
# Spawn one ksk-lestrade (Agent tool) per block with the printed prompt VERBATIM;
# each writes ข้อมูลระบบ/_pages/claim-audit/<segment_id>.yaml into its own clone.
bun run grade.ts  -- lestrade --run <run-id>     # confusion matrix vs expected.yaml
bun run report.ts -- lestrade --run <run-id>     # renders the matrix; exit 1 on regression
bun run report.ts -- lestrade --run <run-id> --set-baseline
```

`report.ts` regresses (exit 1) when **miss-rate** or **false-alarm-rate** rises
vs the pinned baseline.

## Design decisions / caveats for a human reviewer

- **Dispatch verbatim-ness.** The production invocation (in
  `.claude/skills/ksk-stage-interpret/SKILL.md`) fixes the sentence
  *"Audit exclusion claims. Client … Segment … Interpretation: … Claims: … Write
  report to ข้อมูลระบบ/_pages/claim-audit/<seg>.yaml. Reply digest only."* but
  leaves the **claims-list rendering** free ("file, page|sheet, reason, and the
  claimed original page for duplicates"). `dispatch.ts` renders it as a numbered
  list of flow maps carrying exactly those fields. If production later pins a
  stricter claim format, mirror it here or the measurement drifts.
- **Missing verdict = no-alarm = danger.** Folding an unresolved verdict into the
  no-alarm side (FN for a positive) is the conservative choice; `unresolved` is
  also surfaced as its own count so a reviewer can tell a wrong-judgment miss from
  a never-audited claim.
- **Page renumbering.** Each case PDF is the extracted pages renumbered from 1;
  claims/interpretation use those local numbers. `GROUND-TRUTH.md` records the
  source page mapping.
- **Modest size, characterization not gate.** 5 + 5 is enough to exercise every
  matrix cell, not to pin a stable rate — treat first numbers as a map of where
  lestrade fails, not a pass/fail bar. Grow the seeded set (especially adversarial
  same-seller duplicates and near-identical doc numbers) before trusting the rate.
- **Before this becomes a trusted measurement:** a human should eyeball each
  `GROUND-TRUTH.md` against its case PDF, confirm the seeded claims read as
  plausible watson/marple mistakes (not strawmen), then run a live baseline over
  ≥3 replicates and pin it.
