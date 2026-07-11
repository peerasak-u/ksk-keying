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
