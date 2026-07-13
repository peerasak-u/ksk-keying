# T04 grader (`grade-vs-answer-key.ts`) — known issues

Recorded 2026-07-14 after an adversarial correctness audit of the layer-3 "ruler"
(the job-level grader that scores a finished run against a client-month PEAK-export
answer key). 24-agent audit: 17 findings raised, **13 confirmed** (each reproduced
with runnable code against the real functions), 4 refuted.

**Overall verdict: trustworthy-with-caveats.** No confirmed defect fires on an
ordinary clean client-month — every trigger needs blank/garbled doc_no, same-day
identical-gross collisions, Buddhist-era dates leaking from the LLM, or a
hand-assembly slip in the answer-key folder. The headline numbers on run #1b
(`recall 83/86 · value 78/83 · account 74/83 · invented 89`) are sound and were
reproduced byte-identically after the fixes below.

## Fixed 2026-07-14 (the high-value cluster)

TDD'd red→green, verified end-to-end on run #1b (metrics unchanged, new fields
populated, zero spurious flags). Commit: see `fix(evals): harden T04 grader …`.

| # | Bias | Defect | Fix |
|---|------|--------|-----|
| 1 | hides bug | tier-4 (gross+date) fallback let a duplicate/invented run doc satisfy a *different* blank-docNo key doc → flawless score masks a missing document | `matchDocs` now surfaces those pairs on an `ambiguous` channel; `gradeRun` exposes `ambiguous_matches` + per-doc `ambiguous`, CLI prints a ⚠ caution — the masking is no longer silent |
| 2 | hides bug | key-workbook discovery matched only `.xlsx` → a legacy `.xls`/macro `.xlsm` answer-key file silently skipped, shrinking the recall denominator | `findKeyWorkbooks` accepts `.xlsx`/`.xls`/`.xlsm` and warns on any other non-hidden file |
| 3 | false alarm | `normalizeDocDate` 8-digit `YYYYMMDD` branch skipped BE→Gregorian → `25690401` stayed 2569 | branch now applies the 2400–2600 BE conversion its siblings use |
| 4 | false alarm | `normalizeDocDate` 2-digit year did `+2000` → `01/04/69` became 2069, not 2026 | 2-digit years resolved as Buddhist short-form (`69` → พ.ศ. 2569 → 2026) |
| 6 | diagnosability | `DocGrade` exposed the gross pair but no dates → a `value_match` fail couldn't be attributed to gross vs date (the blind spot that let the cellDates artifact present as an unexplained 20/79) | added `date_expected`/`date_actual`; on run #1b all 5 residual value fails now read as DATE-only at a glance (2 are key-side `1969` quirks, 3 real disagreements) |

## Deferred — logged, not fixed before ship

Real but narrow (all `rare`/`theoretical`, mostly false-alarm or self-limiting).
Revisit post-ship in the eval-expansion phase.

- **#5 (matcher, high/rare, false alarm).** A blank-docNo expected doc processed
  first can consume (via the gross+date fallback) an actual that a *later*
  exact-doc_no expected doc needed → wrong `missed` entry + a fabricated
  account mismatch. **Fix direction:** two-pass `matchDocs` — assign every
  docNo-bearing expected via tiers 1–3 first, blank/fallback-only expecteds
  second. (Related to #1; the #1 `ambiguous` flag already lights up the riskiest
  variant.)
- **#7 (account_match, med/rare, false alarm).** `account_match` compares only
  the single largest-|amount| `primaryAccountCode`; a penny/exact tie between two
  lines lets each side pick a different primary though the booked account *set* is
  identical. **Fix:** deterministic secondary tiebreak (`|| accountCode.localeCompare`)
  on both sides + an `account_set_match` companion.
- **#8 (matcher tier-1, med/rare, false alarm).** Exact-doc_no tier has no
  gross/date tiebreak among multiple actuals sharing one doc_no → first
  array-order candidate wins even when a later one is the true match; `invented`
  still increments so the bug signal isn't hidden, but the wrong twin is blamed.
  **Fix:** prefer an exact-doc_no actual that also agrees on gross+date before
  first-in-order.
- **#9 (key parsing, med/rare, false alarm).** `keyDocsFromRows` groups by
  `source-file#seq`; the same document present in two xlsx files in the key folder
  becomes two key docs → phantom `missed`. **Fix:** dedupe across sources by
  `(normalizedDocNo, gross, date)` and union `sources`, warn on collision.
- **#10 (matcher tier-4, low/rare, false alarm).** Tier-4 pairing among ≥2 tied
  gross+date docs flips `account_match` on array order alone. Subsumed by #1's
  `ambiguous` flag + #5/#7's disambiguation.
- **#11 (`parseVatRate`, low/theoretical, false alarm).** No sanity bound — a bare
  `7` meant as 7% reads as 700% (gross ×7.5). Guarded in practice by the answer
  key being a human-reconciled reference. **Fix:** clamp `n>1 → n/100`, flag
  out-of-range.
- **#12 (`normalizeDateCell`, low/theoretical, false alarm).** A raw out-of-range
  BE 8-digit literal (`25690401`) falls into the serial branch → blank date. **Fix:**
  sniff `24000101–26001231` before the serial fallback. (The run-side sibling is
  fixed as #3.)
- **#13 (`loadKeyDocs`, low/theoretical, hides bug).** The `sheetName ===
  "Description"` skip runs before `detectPeakColumns`; a document-shaped sheet
  named "Description" would be dropped. **Fix:** gate the skip on
  `!detectPeakColumns(grid[0])` so shape is dispositive, not the name.

## Not yet examined — the completeness-critic list

Error classes no audit dimension covered; candidates for the next audit round:

1. **Normalizer identity semantics** — `normalizeDocNo`/`tailNo`/`normText` applied
   *to doc numbers*: `tailNo` collapses `66/22` and `99/22` to tail `22` (false-merge
   at equal gross); `normText`'s บริษัท→บจก. / จำกัด-stripping runs on `docNoRaw` and
   could mangle an alphanumeric document number.
2. **Run-side `review-data.json` robustness** — `numOrNull` silently nulls a
   malformed `facts.total` (value_match fails with no signal); `page.ref` collisions
   can yield duplicate `RunDoc.key` (breaks `consumed`-set bookkeeping); a group
   missing `review-data.json` is silently skipped (distorts recall/invented).
3. **WHT / net-vs-gross alignment** — `keyDocsFromRows` computes gross ignoring the
   หัก ณ ที่จ่าย column and never checks the run side (`facts.total`) defines "gross"
   the same way; a net-vs-gross mismatch shows as an unexplained value fail.
4. **Account-code string normalization** — `account_match` is a raw trimmed `===`
   (Thai vs Arabic numerals, sub-account suffixes, stray formatting all read as a
   wrong-account false alarm).
5. **Negative / credit-note / zero-gross docs** — `amountEq(0,0)` is true, so a
   zero-gross doc can tier-4-match any other zero-gross doc on date alone; refund
   (negative gross) matching is unaudited.
6. **Degenerate aggregate framing** — empty-key-set renders `0/0`; the multi-run
   min-recall/max-invented worst-case framing is unchecked when runs disagree on
   which docs matched.
7. **Cross-scope leakage** — a document the key-preparer booked only via the
   out-of-scope `PEAK_ImportJournal` sheet but which the pipeline placed in an
   expense group is still counted as `invented` (metric-boundary, not a code bug).
