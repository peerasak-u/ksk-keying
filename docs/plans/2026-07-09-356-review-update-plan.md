# Update plan — findings from the 356 answer-key review (2026-07-09)

Source: human review of the case-by-case diff between a finished blind run and the
client's verified PEAK exports (`samples/old-result`, comparator + reports archived in
the client's `ตรวจทาน/_เทียบ-old-result-data/`, local-only). Per repo policy the
answer key was only consulted *after* the run passed its Ledger Gates.

Everything below is written as **general rules** — no run-specific anecdotes go into
agent prompts (see memory/commit convention). Case IDs (A1…H) refer to the reviewed
diff report and appear here only as evidence pointers.

## 1. Review scoreboard

| Case | Verdict (human review) | Pipeline change needed? |
|---|---|---|
| A1 | pipeline wrong on **both** amount and account (hire-purchase sub-account) | W6 |
| A2 | pipeline wrong account (hire-purchase sub-account) | W6 |
| A3 | **human keyed wrong, pipeline right** (repair, not fuel) | none |
| A4 | pipeline doc-no right; account wrong (internet, not phone); WHT presence must be recorded per transaction | W3, W6 |
| B1 | pipeline misread amount (same doc as A1) | W6 |
| B2 | **human keyed wrong, pipeline right** | none |
| B3 | doc number unreadable → pipeline **borrowed a number from a report row** | W1, W2 |
| C1 | **pipeline right** (date), human keyed wrong | none |
| C2 | pipeline wrong account + missed WHT 3% | W3, W6 |
| D  | all this client's fuel docs carry VAT (buyer + VAT amount printed) — pipeline routed ~28 to non-VAT | W4 |
| E  | unknown — leave marked, no change yet | parked |
| F  | no answer key exists for these docs | none |
| G1 | date gaps are conventions: use tax-invoice date; **cross-year → Jan 1 of current year** | W5 |
| G2 | agent confusion traced to reading report rows (dates/amounts) | W1 |
| H  | stop using derived reports as inputs — disposition them | W1 |

Net: pipeline beat the human key on 3 documents (A3, B2, C1); its systematic losses are
report contamination (W1/W2), VAT routing on slip-format tax invoices (W4), WHT capture
(W3), sub-account precision + amount sanity (W6), and the cross-year date convention (W5).

## 2. Workstreams

### W1 — Derived reports become reference-only: disposition at intake  *(H, B3, G2)*

**Rule.** A source that is a *listing about documents* rather than a document itself —
sales/purchase VAT reports (รายงานภาษีขาย/ซื้อ), receipt reports, expense summaries —
is never interpreted into facts, never linked into Doc Groups, and never a source for
document numbers, dates, or amounts. At the Stage 1 policy gate its pages get an
Exclusion Declaration with a new reason **`reference_report`** (`declared_by:
agent_policy`), giving every page a terminal state the Page Ledger can read.

**Touch points**
- `SKILL.md` — add to the Decision Policy (new rule) + Stage 1 policy-gate text.
- `.claude/agents/ksk-columbo.md` — classify report-shaped sources as `reference_report`
  segments (it already detects shape; add the type and stop proposing them for interpretation).
- `.claude/agents/ksk-sherlock.md` — hard rule: report pages are not linkable evidence.
- `scripts/merge-dispositions.ts`, `scripts/ledger.ts` — **verified in Phase 2: no code
  change needed.** Exclusion reasons are free-text end-to-end, and `ledger.ts` already
  warns loudly when a unit is both reviewed and excluded (the failure mode a report page
  sneaking into a group would produce).
- `scripts/prelink.ts` / `scripts/groups-lib.ts` — no assertion added: report segments
  are excluded at the Stage 1 gate, so they never get interpretations and can never
  enter prelink/grouping; the ledger conflict warning covers the residual case.

**Decision (Peerasak, 2026-07-09).** Full separation during the run — watson,
sherlock, poirot, marple must never see report pages (real client folders may not even
contain such reports, and when they do they can mislead). The pages are still kept and
marked so that an **isolated, read-only, totals-only cross-check** can run at the very
end (final-report stage only): compare final ledger totals against report totals and
show the result to the human. Nothing from the cross-check flows back into facts.

### W2 — Unreadable document numbers get a loud sentinel  *(B3)*

**Rule.** A document number may only come from the page being read. If it is absent or
illegible the agent must not substitute a number from any other page or source; it
records `document_no: null` plus a note. Deterministic code then assigns the group id
sentinel **`ID_NOT_FOUND_<n>`** (unique per client run) and marks the group
`needs_review`, so the review UI shows explicitly that no number was found.

**Touch points**
- `scripts/prompts/extract-*.txt` + `references/extract-playbooks.md` — "never borrow a
  number; null + note when not printed/legible".
- `scripts/groups-lib.ts` — group-id fallback: sentinel instead of borrowing/seg-id when
  the doc has pages but no number (today's fallback produced ids like `*-seg-005`).
- `scripts/build-review-data.ts` / `scripts/review-template.ts` — surface the sentinel
  as a warning badge on the review page.

### W3 — WHT (หัก ณ ที่จ่าย) recorded per transaction  *(A4, C2)*

**Rule.** Every expense/income transaction records WHT explicitly: `wht_amount`,
`wht_rate`, `pnd` (ภ.ง.ด. form) — or an explicit "no WHT evidence on document". For
service-type expenses paid by a juristic client (rent, professional fees, transport,
repair services, telecom) where the document shows no WHT, the line is flagged
`needs_review: wht_expected?` rather than silently keyed at full amount.

**Decision (Peerasak, 2026-07-09).** WHT values come **from the document only** — no
auto-filled rates, not even from a `CLIENT.md` convention. What changes is observation:
`ksk-watson` is explicitly instructed to look for WHT evidence on every document it
reads (a printed หัก ณ ที่จ่าย line, a WHT certificate attached to the invoice, a paid
amount lower than the total by a clean 1/2/3/5% of the base) and to record what it saw.

**Touch points**
- `scripts/extract.ts` (has `wht` already) — add `wht_rate`/`pnd`; extraction prompts +
  playbooks tell agents to actively look for WHT lines.
- `references/review-data-schema.md` + `scripts/build-review-data.ts` — carry the fields
  into `review-data.json` facts.
- `scripts/review-template.ts` — add a หัก ณ ที่จ่าย column to ตรวจทาน (PEAK headers
  already contain it).
- `scripts/group-populate.ts` — fill PEAK's หัก ณ ที่จ่าย / ภ.ง.ด. columns from facts.
- `.claude/agents/ksk-poirot.md` + `scripts/prompts/categorize-line_items.v1.txt` —
  service-category → WHT-expected hint.

### W4 — VAT routing judged by document content, not paper format  *(D)*

**Rule.** Amend Decision Policy rule 8: a document that prints a VAT breakdown (7%
amount) **and** identifies the client as buyer is input-VAT evidence, regardless of
format (slip-sized tax invoices from fuel stations count). Slip documents with a VAT
amount but *no* buyer identification → `non_vat` + `needs_review` (not silently
claimed, not silently dropped). Additionally `CLIENT.md` frontmatter gains a
per-client convention block, e.g.:

```yaml
vat_conventions:
  fuel_receipts: vat_7   # this client's fuel docs are full tax invoices
```

`ksk-magnum` (Stage 0) drafts it as unknown; the Stage 2.5 profile update settles it
from real documents; `ksk-watson`/extract prompts and `ksk-poirot` consume it.

**Touch points**: `SKILL.md` rule 8 + Stage 2.5 section, `.claude/agents/ksk-magnum.md`,
`.claude/agents/ksk-watson.md`, `scripts/prompts/extract-*.txt`. (Group routing in
`groups-lib.ts` already follows `vat_treatment` — no change there.)

### W5 — Keying-date convention: invoice date, but cross-year → Jan 1  *(G1)*

**Rule.** The PEAK document date is derived deterministically at populate time, never by
an agent: use the tax-invoice date as-is; **if the invoice date falls in a year before
the accounting period's year, use Jan 1 of the period's year** ("ข้ามปี ให้ใช้วันที่ 1").
`facts.date` keeps the true document date; ตรวจทาน shows both when they differ.

**Touch points**: `scripts/group-populate.ts` (or wherever the PEAK row date is
assembled in `review-template.ts`), `references/review-data-schema.md` (document the
derived field), `SKILL.md` policy note.

### W6 — Numeric sanity gate + sub-account precision  *(A1/B1, A2, A4, C2)*

1. **Arithmetic gate** (deterministic): for `vat_7` documents require
   `|vat − 0.07 × subtotal| ≤ 0.02` and `subtotal + vat = total` (±0.02). Violation →
   `needs_review: vat_arithmetic_mismatch`. This catches single-digit OCR misreads (the
   A1/B1 500-baht error was internally inconsistent and detectable).
   → `scripts/validate-interpretation.ts` + `scripts/group-gates.ts`.
2. **Per-contract sub-accounts**: when the COA contains a family of per-contract /
   per-vehicle sub-accounts (e.g. hire-purchase creditors 2211xx), poirot must map by
   the contract/vehicle identifier printed on the document (against `coa.csv` names +
   `coa_usage.json` history). If it cannot match confidently it flags `needs_review` —
   it never silently picks a sibling or a generic account in the family.
   → `.claude/agents/ksk-poirot.md`, `scripts/prompts/categorize-line_items.v1.txt`.
3. **Telecom split**: for phone-vs-internet accounts, decide from the service named on
   the document; when ambiguous follow the `CLIENT.md`/`coa_usage.json` convention and
   flag low confidence. → poirot prompt hint.

### Parked

- **E (rent-like row with no source doc)**: human doesn't know either — stays marked.
  If later confirmed recurring, add a `recurring_items` block to `CLIENT.md` and have
  the final report check the period for expected-but-absent recurring items. Not built now.
- **A3 / B2 / C1**: human-key errors; no pipeline change. Keep as evidence that the
  comparator must not treat `old-result` as infallible (grade both directions).

## 3. Sequencing

| Phase | Content | Why this order |
|---|---|---|
| 1 ✅ | W1 + W4 policy text (SKILL.md, agent prompts, magnum/watson/poirot) and W2 prompt wording | Cheap, prompt-only; removes the two biggest error sources at their origin |
| 2 ✅ | Script plumbing: `reference_report` disposition path, `ID_NOT_FOUND_<n>` group ids, WHT fields end-to-end, date derivation, arithmetic gate. **Also**: sync the eval'd source prompts `scripts/prompts/extract-*.v1.txt` + their promptfoo configs with the new shared playbook rules (Phase 1 added them at playbook + agent level only, to avoid prompt/eval drift without a rerun) | Deterministic code; each lands with unit tests in `scripts/tests` |
| 3 | Blind re-run of the 356 fixture, then re-grade with the archived comparator | Validation only — answer key stays out of the run itself |

**Phase 1 landed (2026-07-09)** — SKILL.md: rule 8 amended (VAT by content), new rules
9 (`reference_report`), 10 (WHT from documents only), 11 (keying date / cross-year →
Jan 1), Stage 1 gate + Stage 2.5 `vat_conventions` + Completion-check cross-check item;
`ksk-columbo` (classify `source_class: derived_report`), `ksk-sherlock` (reports are not
linking evidence), `ksk-watson` (never borrow doc numbers, WHT observation, VAT by
content), `ksk-poirot` (sub-account families, look-alike pairs, `wht_expected?`),
`ksk-magnum` (`vat_conventions` frontmatter), `references/extract-playbooks.md`
(three shared rules).

**Phase 2 landed (2026-07-09)** — `groups-lib.ts`: sentinel `ID_NOT_FOUND_<n>` ids for
document groups with no bookable number (statements keep segment-id slugs) + warning,
and `facts.wht` passed through to review-data (amount as printed, never derived).
`review-template.ts`: PEAK หัก ณ ที่จ่าย/ภ.ง.ด. columns filled from `facts.wht` (rate
snapped to standard Thai rates ±0.002, else empty + warning; ภ.ง.ด. 53/3 inferred from
the counterparty's legal-form markers, else empty + warning), cross-year keying date
(modal period year; prior-year docs → Jan 1 + วันที่จริงบนใบ note; future-year docs
warned, never shifted), WHT shown on the review page + Change_Log.
`validate-interpretation.ts`: non-fatal `vat_arithmetic_mismatch` warnings —
`|vat − 7%×(gross−vat)| > 0.02` and `net_paid > gross_total` — both interpretation
shapes. `merge-dispositions`/`ledger`: verified no change needed (free-text reasons;
reviewed+excluded conflict already warned). Prompts: shared rules mirrored into all
nine `extract-*.v1.txt` with per-kind adaptations + CHANGELOG entry. **Note:** the
promptfoo eval configs the playbooks referenced do not exist in this checkout —
resolved by the follow-up below (suite retired, not pending).
Tests: 99 pass across 5 files (20 new review-template, 6 new validator, 3 new
groups-lib), `tsc --noEmit` clean.

**Follow-up (Peerasak, 2026-07-09): promptfoo retired.** The eval suite is no longer
used in the keying work at all — the dangling references were removed rather than
left "pending": the playbook provenance note now names the sync-with-prompts +
CHANGELOG contract as the maintenance mechanism, and `scripts/prompts/CHANGELOG.md`
opens with a retirement entry (older entries citing promptfoo stay as history).
No eval rerun is pending anywhere.

## 4. Acceptance criteria (checked on the blind re-run)

- No Doc Group contains a page from a report-shaped source; all such pages are
  Excluded with reason `reference_report`; Ledger Gate still passes.
- Fuel documents with printed VAT + buyer route to `expense/vat`; client-level VAT
  claim total reconciles with the answer key within rounding.
- Every group whose document number was unreadable shows `ID_NOT_FOUND_<n>` — zero
  groups carry a number that exists only on some other page.
- Review pages and populate output carry WHT columns; service invoices without WHT
  evidence are flagged, not silently keyed.
- Documents dated in a prior year get a Jan-1 keying date while `facts.date` keeps the
  printed date.
- The A1-style internally-inconsistent amount triple is flagged by the arithmetic gate.
- No agent prompt references client 356 or this run's numbers.

## 5. Decisions log

- **2026-07-09 / W1**: reports fully separated from the run (watson/sherlock never see
  them); kept + marked for a totals-only cross-check at the final-report stage.
- **2026-07-09 / W3**: WHT from documents only — no auto-filled rates ever; watson
  gains explicit WHT-observation instructions.
