# Decision Policy — decide by rule, don't ask

Shared reference for the ksk-keying workflow. The **orchestrator and every stage skill**
apply these rules; nothing here is agent-specific. Cited by rule number across
`ksk-stage-profile`, `ksk-stage-segment`, and `ksk-stage-interpret`.

Mid-run questions kill unattended runs. When a child raises a question or a
`needs_confirmation` item, the parent first answers it from this policy + `CLIENT.md`; it
asks the human **only** for hard blockers:

- no `coa.csv` **and** no COA workbook anywhere in the client folder (the run cannot map accounts at all)
- a required source file is unreadable or missing, so a Page can never reach a terminal state
- two policy rules give contradicting answers for the same money

Everything else is decided by rule and **logged, not asked**: append each decision to
`CLIENT.md` under `## Decisions (auto)` (one line: decision, rule number, evidence),
record any resulting exclusion in `ข้อมูลระบบ/_pages/dispositions.yaml` with
`declared_by: agent_policy`, and list every auto-decision in the final report so the human
can veto it during review. An auto-decision is a proposal with a paper trail — never
silently final.

## Default rules

1. **Client identity** — no identity documents yet → take the company name from the folder name (`_<id> <thai company name>`), mark it provisional. Confirm/correct it later from document evidence (Stage 2.5), not by asking.
2. **VAT registration** — starts `vat_registered: unknown`; settled at Stage 2.5 from the client's own income documents. Never guessed at Stage 0.
3. **Example / import artifacts** — files that are PEAK-import examples or outputs (`ไฟล์นำเข้า*`, or a workbook matching the PEAK import template headers) → excluded, reason `reference_example`. They are never a booking source.
4. **Duplicate / overlapping reports** — when several files cover the same money: the most granular per-transaction report (settlement/transfer report with per-order rows) is authoritative; summary/balance reports covering the same period → excluded, reason `superseded_by <seg-id>`; archives (`.zip`/`.rar`) whose contents already exist extracted → excluded, reason `redundant_archive`.
5. **Marketplace double-counting** — platform fees: when proper VAT tax invoices for the fees exist, book fees from those invoices and treat the settlement's fee lines as reference; the settlement books income (and refunds) only. Marketplace-channel sales invoices that also appear in a settlement → book once from the settlement, mark the PDF duplicates `do_not_book`. Channels **not** covered by any settlement (e.g. Lazada/LINE invoices when only a Shopee settlement exists) book from their invoices.
6. **File names lie** — trust document content over file/folder names (a "Non vat" file may be full of 7% tax invoices). Route every document by its own evidence, and flag the mismatch in the segment summary.
7. **Account specificity** — map to the most specific `coa.csv` account the document evidence supports (freight, entertainment, fuel, travel, taxes, training…); generic resale/raw-material codes only for actual goods purchases; never invent codes. When no account fits conservatively → suspense + `needs_review`, not a guess.
8. **Input VAT** — a valid 7% tax invoice with the client as buyer → claim input VAT, unless `CLIENT.md` says the client is not VAT-registered. **Tax-invoice validity is judged by document content, not paper format**: a slip-sized document that prints a 7% VAT breakdown and identifies the client as buyer is tax-invoice evidence (fuel-station slips commonly are); a document showing a VAT amount but no buyer identification stays `non_vat` + `needs_review` — neither silently claimed nor silently dropped; a document with no VAT evidence at all stays non-VAT. Follow a `CLIENT.md` `vat_conventions` entry when one exists. Legally doubtful claims (e.g. entertainment) → follow the `CLIENT.md` convention when one exists, else book the expense and flag the VAT line `needs_review`.
9. **Derived reports are reference-only** — a source that *lists* documents rather than being one (sales/purchase VAT reports รายงานภาษีขาย/ซื้อ, receipt reports, expense summaries — PDF or spreadsheet) is never interpreted, never linked, and never a source for document numbers, dates, or amounts: report-borrowed numbers corrupt real bookings, and report rows confuse date/amount matching. At the Stage 1 policy gate its pages are excluded with reason `reference_report` (`declared_by: agent_policy`). Excluding a report is not the same as confirming its rows are covered elsewhere — a report can be the *only* surviving evidence for some of its rows even though it isn't itself a booking source. The pages stay in the folder for exactly one later, deterministic use — the `reference-report-check` script at the Completion check sums each excluded report's rows and checks how much is booked anywhere else in the client's output; nothing from a report ever flows back into facts automatically, but an unaccounted amount is a mandatory review point for the human, not something a run may quietly skip.
10. **WHT from documents only** — record หัก ณ ที่จ่าย per transaction exactly as the document shows it (a printed WHT line, an attached WHT certificate, a paid amount cleanly lower than the total); never auto-fill a rate, not even from a convention. A service-type expense (rent, professional fees, transport, repair services) from a juristic seller with no WHT evidence gets `needs_review` (`wht_expected?`) — flagged, not silently keyed at full amount.
11. **Keying date** — the PEAK document date follows the tax-invoice date; when the invoice date falls in a year **before** the accounting period's year, key it as Jan 1 of the period's year ("ข้ามปี ให้ใช้วันที่ 1"). Derived deterministically at populate — `facts` keep the printed date, and the review page shows both when they differ; agents never shift dates themselves.

Rules 3–5 and 9 resolve most of what segmentation (`ksk-columbo`) flags; rules 6–8 and 10
resolve most of what interpretation surfaces. A question no rule covers that does **not**
materially change the books → pick the conservative option, log it, continue. Only a
no-rule question that **does** materially change the books is a blocker.

## Stop rules

The run stops for the human only on the hard blockers above: no COA source at all, a
required source file missing/unreadable (a Page that can never reach a terminal state), or
a no-rule ambiguity that materially changes the books. Everything else: apply the policy,
or take the conservative option (suspense + `needs_review`, exclusion proposal, flagged
row) and keep going — the review pages and the decision log are where the human weighs in.
Park unresolved output where a human can review it; never let an open question stall the
rest of the pipeline.
