# Eval scoreboard

Aggregate numbers only — no client data. One row per recorded run.
Numbers are comparable only within the same dataset version.

## ksk-watson

| date | run id | dataset | cases pass (solid) | silent-error rate (solid) | note |
|---|---|---|---|---|---|
| 2026-07-11 | first-live | v2 | 1/1 (5/6 all) | 0.00% (36 fields) | first run, pre-fix; 1 provisional FAIL = document_date misread on a scanned rent invoice (took a service-period date) |
| 2026-07-11 | after-date-rule | v3 | 3/3 (6/6 all) | 0.00% (63 fields) | **baseline** — playbook rule: document_date = header issue date, never line-item periods |
| 2026-07-11 | date-stability ×3 | v3 | 2/3 replicates | — | stability probe pre-zoom-rule: date digit flips on low-res scan (05 read as 03) |
| 2026-07-11 | date-stability-2 ×3 | v3 | 1/3 replicates | — | conditional "zoom when unsure" rule does NOT fix silent misreads (agent never feels unsure) |
| 2026-07-11 | date-stability-3 ×3 | v3 | 3/3 replicates, all fields agree | 0.00% | unconditional zoom-verify rule for raster-scan headers in ksk-watson.md — closes the failure mode |
| 2026-07-11 | b3-refix | v4 | 1/1 | 0.00% | page_disposition grading added (v4 fixed a harvest gap: b3 case was missing the duplicate-source file); duplicate correctly excluded 9/9 pages |
| 2026-07-13 | 20260713-0408 | v4 | 3/3 (5/6 all) | 0.00% (70 fields) | pre-refactor line before skill split; b3 provisional "fail" = symmetric-duplicate flip (agent excluded the other identical copy — expectation over-specified, spec fix pending) |
| 2026-07-13 | 20260713-0416 | v4 | 3/3 (6/6 all) | 0.00% (70 fields) | post-refactor proof: schema moved to references/schemas/, watson.md 226→100 lines, marple rewritten — all fields 37/37, page_disposition 38/38; recommended v4 baseline |

## ksk-sherlock

| date | run id | dataset | cases pass (solid) | silent-error rate (solid) | note |
|---|---|---|---|---|---|
| 2026-07-11 | mini-live | v2 | 1/1 | 0.00% (12 fields) | **baseline** — hand-curated voucher-chain scenario (5 must-link clusters incl. amount-mismatch slip, 1 must-not-link decoy); also refuted a poisoned draft cluster and an invented bookable doc |
| 2026-07-11 | first-live (full 403) | v2 | 0/0 solid (provisional case) | — | scale probe, 22 min / 296k tokens: 393/410 memberships match; 7 disagreement scenarios, all null/duplicate doc-no docs — expected is booking-verified but NOT per-cluster-verified, so each scenario needs adjudication → future mini cases. Run sparingly (integration tier). |
| 2026-07-13 | 20260713-0408 + -0416 | v2 | 1/1 both | 0.00% (12 fields) | mini re-run pre/post skill refactor (marple rewrite, schema refs): identical result both sides, poisoned draft refuted both times — no regression vs baseline |
