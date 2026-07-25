# review-data.json contract (`ksk_review_group_data.v1` / `ksk_review_statement_data.v1`)

One file per doc group at `ข้อมูลระบบ/_doc_groups/<category>/<vat_treatment>/<group-id>/review-data.json`
(bank statement groups live at `ข้อมูลระบบ/_doc_groups/bank_statement/<group-id>/`). It is the normalized
input for `bun run --cwd .claude/skills/ksk-keying/scripts review-groups`, which merges every group in a bucket into
one interactive `review.html` at the bucket root.

Every bucket except `bank_statement` uses the invoice-shaped `ksk_review_group_data.v1`
schema documented below. The `bank_statement` bucket uses its own schema,
`ksk_review_statement_data.v1` (a chronological transaction table, not an invoice) — see
[Bank statement schema](#bank-statement-schema-ksk_review_statement_datav1) further down.
`review-groups.ts` hard-errors if a group folder's `review-data.json` doesn't match the
schema expected for its bucket.

## Folder tree the generator expects

```text
ข้อมูลระบบ/_doc_groups/
  manifest.yaml                    # layout: category_vat_tree.v1
  expense/
    vat/
      review.html                  # generated — do not hand-write
      assets/                      # generated — vendored JS
      <group-id>/
        review-data.json           # this contract
        interpretation.json        # upstream evidence (kept for audit)
        categorize.json
    non_vat/…
    mixed/…                        # docs whose line items mix VAT and non-VAT
  income/
    vat/…
    non_vat/…
  bank_statement/
    <group-id>/…
```

## Schema

```json
{
  "schema": "ksk_review_group_data.v1",
  "group_id": "spaceco-marketing",
  "label": "SPACE&CO. Performance Marketing — INV202604070001",
  "review_flags": [],
  "pages": [
    {
      "ref": "บิลซื้อ/page-001",
      "short_ref": "page-001",
      "source_src": "บิลซื้อ เดือน เมษายน.pdf",
      "source_page": 5,
      "source_pages": [5, 6, 7],
      "source_sheet": null,
      "image_src": null,
      "extract_path": "ข้อมูลระบบ/_doc_groups/expense/vat/spaceco-marketing/interpretation.json",
      "categorize_path": "ข้อมูลระบบ/_doc_groups/expense/vat/spaceco-marketing/categorize.json",
      "facts": {
        "date": "2026-04-07",
        "document_no": "INV202604070001",
        "reference": null,
        "seller": "…", "seller_tax_id": "…",
        "buyer": "…", "buyer_tax_id": "…",
        "subtotal": 22500.0, "vat": 1575.0, "total": 24075.0, "paid": 23400.0,
        "wht": 675.0,
        "summary": "…",
        "vat_treatment": "vat_7",
        "currency": null,
        "original_currency": null,
        "original_amount": null,
        "exchange_rate": null
      },
      "lines": [
        {
          "line_index": 0,
          "description": "Performance Marketing",
          "qty": 1.5, "unit": "เดือน", "unit_price": 15000.0, "amount": 22500.0,
          "amount_includes_vat": false,
          "vat_treatment": null,
          "account_code": "520211", "sub_code": "",
          "account_name_th": "ค่าจ้างที่ปรึกษาการตลาด",
          "confidence": "high",
          "reason": "เหตุผลที่เลือกบัญชีนี้ — เขียนเป็นภาษาไทย",
          "needs_review": false
        }
      ],
      "initial_status": "reviewed"
    }
  ]
}
```

## Field rules

- One `pages[]` entry per reviewable document (a multi-page invoice is one entry that opens
  at its primary page but claims its full span via `source_pages`).
- **Preview source** — the review UI previews the *real* source document, not a rasterized
  page. Set:
  - `source_src`: the actual source file (**relative to the month run root**) — the PDF,
    image, or xlsx that this document came from, e.g. `"บิลซื้อ เดือน เมษายน.pdf"`. Point at
    the file that physically exists in the month folder.
  - `source_page`: 1-based page number to open the source PDF to (the first page of this
    document within a concatenated scan). Use `null` for single-page images or when the whole
    file is the document. This is only the iframe open-point — it is **not** the coverage claim.
  - `source_pages`: list of ints, **required going forward** — the FULL claimed span of the
    document, every page it occupies (e.g. `[5, 6, 7]` for a 3-page invoice), not just the
    first.
  - `source_sheet`: string, **required when the source is a multi-sheet workbook** — the exact
    sheet name this document came from; `null` otherwise.
  The generator rewrites `source_src` relative to the bucket, renders PDFs inline via
  `<iframe src="file.pdf#page=N">` opened to `source_page`, images via `<img>`, and
  workbooks (`.xlsx`/`.xls`) as an **inline sheet table** — at build time it reads the
  workbook and embeds the `source_sheet` rows into the page (file:// pages can't fetch the
  file), falling back to the first sheet when `source_sheet` is missing, so name the sheet
  precisely. Always set these from real folder files — do **not** invent a path.
- **Why `source_pages`/`source_sheet` are load-bearing**: the Page Ledger derives a page's
  Reviewed state *only* from these explicit claims — membership in a reviewed segment or
  reviewed file proves nothing (see `docs/adr/0001-derived-page-ledger.md`). A page of a
  multi-page invoice missing from `source_pages`, or an unnamed workbook sheet, is
  Unaccounted and blocks the final Ledger Gate.
- `image_src` is a legacy rasterized fallback (`ข้อมูลระบบ/_pages/*.png`), **relative to the client
  root**; leave it `null` when `source_src` is set. The generator drops paths that don't
  exist. If neither `source_src` nor `image_src` resolves, the page shows "no document".
- `facts.vat_treatment`: `"vat_7"`, `"non_vat"`, `"unknown"`, or `""` — the document-level
  default used by the PEAK export.
- `lines[].vat_treatment`: set per line **only in `expense/mixed` groups** (`"vat_7"` /
  `"non_vat"`); leave `null` elsewhere so the document-level value applies. The export
  emits one PEAK row per (account, VAT treatment) combination.
- `amount` is the VAT-exclusive line value when `amount_includes_vat` is `false`.
- `facts.paid` = net amount actually paid/received (after WHT).
- `facts.wht` = withholding tax amount as printed on the document; `null` when the
  document shows no WHT. Never derived — rates are never auto-filled (Decision Policy
  rule 10); the export layer computes any display values from this amount.
- **FX visibility fields (THB contract)** — the money fields above (`subtotal`/`vat`/
  `total`/`paid`/`wht`) always carry THB; these four surface the document's own
  foreign-currency face value so the reviewer sees the conversion without opening
  `interpretation.json`. All copied verbatim from the group's `accounting_facts`:
  - `facts.currency` = the currency of the money fields — `null` (or `"THB"`) in the
    normal case; a non-THB value signals the THB amounts are conversions.
  - `facts.original_currency` = the currency the document was actually printed in
    (e.g. `"USD"`), `null` when the document is THB.
  - `facts.original_amount` = the gross total in `original_currency`, `null` otherwise.
  - `facts.exchange_rate` = THB per one unit of `original_currency`, `null` otherwise.
- `initial_status`: `"needs_attention"` whenever any line is `needs_review` or confidence
  is below high, or a review flag is unresolved; else `"reviewed"`.
- Amounts are numbers, not strings. Never fabricate a value — leave it `null` and flag it.

### Group-level `review_flags`

- `review_flags`: `string[]` at the top level of the file (sibling of `pages`) — the
  group interpretation's own `review_flags`, plus the deterministic loan-draw warning
  when the income-bound loan-draw net fires at build time and the flag isn't already
  present. This is what tells the reviewer **why** a `needs_attention` group was
  flagged (the generator renders it near the group header). Empty array when the group
  is clean. Additive and optional — older files without it still load.
- **Every `reason` and `review_flags` string is Thai, not English.** The
  reviewer reading `review.html` is a Thai bookkeeper — write the explanation
  in the natural, professional Thai a bookkeeper would use, not a literal
  translation and not mixed with English prose. A flag *identifier* like
  `wht_expected?` stays as its code; the sentence explaining it (which line
  items, which seller, what evidence is missing) is Thai.

### `pages[].skipped` / `rows[].skipped` — the reviewer's export gate

- `skipped`: `boolean`, present on every `pages[]` entry (document buckets) and every
  `rows[]` entry (bank statements). **The builder always emits `false`** — this field is
  human-only, ticket #42's escape hatch for excluding a row/page from the PEAK export
  without disposing of it. Only the console review app (`review-edit.ts`) ever writes
  `true`. A missing field (files written before this existed) is still read as `false`
  by the console's parsers, so this is additive and backward-compatible.

### Rebuild sidecars: `review-data.ai.json`, `review-data.superseded.json`, `dropped-edits.json`

`build-review-data` rebuilds **every** group with both `interpretation.json` and
`categorize.json` present, on every run — including a Stage-3 repair re-run that
restarts a whole client-month at Stage 1. Three sibling files, all written next to
`review-data.json` in the same group folder, exist to carry a reviewer's saved edits
through that rebuild:

- **`review-data.ai.json`** — byte-for-byte the object the builder produced this run
  (`buildDocumentReviewData`/`buildStatementReviewData`'s return value), plus the same
  `source_content_hash` stamp. This is the *pristine AI baseline* the next rebuild diffs
  against to tell "did a human change this, or did the AI?" — never read or edited by
  the console, never hand-edit it. When a group has no saved reviewer edits,
  `review-data.json` and `review-data.ai.json` are byte-identical. Deleting it is safe —
  the next rebuild just costs that one group a degraded merge (see below); it self-heals
  from there.
- **`review-data.superseded.json`** — a verbatim copy of the pre-rebuild
  `review-data.json`, written only when a rebuild's merge outcome is `degraded` or
  `bailed` (overwritten each time). The last-resort guarantee that a human's document is
  never actually destroyed, no matter how a merge goes. **To restore it:** copy it back
  over `review-data.json` *and* delete that group's `review-data.ai.json` in the same
  step, accepting one more degraded merge on the next rebuild — restoring the file alone,
  with the sidecar left in place, makes the next rebuild treat every difference between
  the restored (older) document and the fresh build as a human edit (`current === baseline`
  no longer holds the way you'd expect) and silently pin the stale values forward with no
  drop record. Better still: hand-diff the superseded file and re-apply only the wanted
  values through the console review pages, so the sidecar relationship is never broken in
  the first place.
- **`dropped-edits.json`** (`ksk_review_dropped_edits.v1`) — append-only history (newest
  entry last, capped at 20) of every rebuild that dropped a human edit or ran
  degraded/bailed: `{ rebuilt_at, outcome, source_content_hash, carried, notes[], dropped[] }`,
  where each `dropped[]` entry names the item, the field, the human's value, the AI value
  before/after, and why it was dropped (`ai_changed` | `item_not_matched` | `no_baseline`).

**The rebuild contract, in one paragraph.** Every run rebuilds every group with both
inputs present — there is no skip-if-unchanged anymore. A saved reviewer edit is carried
forward whenever the edited item still matches between the previous AI baseline and this
run's fresh output (matched by content fingerprint, not position, so a re-interpretation
that shifts row/line indices doesn't silently re-apply an edit to the wrong item). When
the AI's own output for that field also changed since the baseline, **the new AI value
wins** — a repair exists to fix the AI's mistakes, and a stale human correction must not
block that. `pages[].skipped`/`rows[].skipped` and a confirmed bank contra account are the
exceptions: they have no AI source at all, so they always carry forward for a matched
item, in every merge mode. Every edit a rebuild drops is recorded in that group's
`dropped-edits.json` and surfaced as a Thai `review_flags` entry (rendered by the existing
`document-review.ts`/`bank-statement-review.ts` flag boxes — no console change needed),
and the group's pages are forced to `needs_attention` so a human re-checks it. **That
warning is sticky**: a later rebuild over the exact same `interpretation.json` +
`categorize.json` (same `source_content_hash`) that drops nothing new re-injects the same
`review_flags`/`needs_attention` from the last `dropped-edits.json` entry instead of
silently clearing them — otherwise a harmless retry of a *different* group in the same
client-month (build-review-data rebuilds every group every run) would erase the only
console-visible trace that this group lost an edit. It clears automatically the moment the
sources genuinely change again. See
`.claude/skills/ksk-keying/scripts/review-data-merge.ts` for the exact three-way merge
rules, fingerprint definitions, and degraded/bailed fallback behavior.

**Caveat — the transition path (rule 2) assumes the builder itself didn't change.** When no
sidecar exists yet, `fresh` is used as a stand-in for "what the previous build produced" —
correct as long as `buildDocumentReviewData`/`buildStatementReviewData` themselves didn't
change between that write and this rebuild. If the builder's own output for a field changed
(not the AI's interpretation — the deterministic code path), that difference looks
indistinguishable from a human edit and gets carried forward, then pinned once the sidecar
exists. This is bounded to one run per group (`build-review-data.ts` records a
`transition baseline (no review-data.ai.json sidecar): N field(s) carried…` note in
`dropped-edits.json` whenever this path carries anything, specifically so it's auditable)
and is a residual, accepted risk rather than a bug — the same category as the
`default_buyer` caveat: `source_content_hash` deliberately does *not* include CLIENT.md's
`default_buyer`, even though it feeds `pages[].facts.buyer`/`buyer_tax_id`, because folding
it in would invalidate the stamp on every group already on disk and push the whole
installed base through a degraded merge on the first run after this shipped. See
`build-review-data.ts`'s `contentHash`/baseline-selection comments for the full rationale
of both.

## Bucket → PEAK export mapping (built into the page)

| Bucket | Template | Sheet | Saved file |
|---|---|---|---|
| `expense/vat` | PEAK_ImportExpense | Import_Expenses | `peak_import_expense_vat.xlsx` |
| `expense/non_vat` | PEAK_ImportExpense | Import_Expenses | `peak_import_expense_non_vat.xlsx` |
| `expense/mixed` | PEAK_ImportExpense | Import_Expenses | `peak_import_expense_mixed.xlsx` |
| `income/vat` | PEAK_ImportReceipt | Import_Receipts | `peak_import_income_vat.xlsx` |
| `income/non_vat` | PEAK_ImportReceipt | Import_Receipts | `peak_import_income_non_vat.xlsx` |
| `bank_statement` | PEAK_ImportJournal | Import Multiple Journal | `peak_import_bank_statement.xlsx` |

The reviewer's export button opens a save dialog pre-filled with that filename (Chrome/Edge
File System Access API); the reviewer drops the file at the bucket root next to review.html.
The `bank_statement` export writes real `PEAK_ImportJournal` rows: two balanced
debit/credit rows per transaction sharing one ลำดับที, dated per-transaction — see the
bank statement schema section below and `docs/improve-bank-stm-review/PRD.md` §D5.

## Bank statement schema (`ksk_review_statement_data.v1`)

`ข้อมูลระบบ/_doc_groups/bank_statement/<group-id>/review-data.json` is a chronological transaction
table, not an invoice: no `pages`, no invoice `facts`. Full design context:
`docs/improve-bank-stm-review/PRD.md` §D1.

```json
{
  "schema": "ksk_review_statement_data.v1",
  "group_id": "044-bank-statement-221-1-90947-4",
  "label": "Kasikornbank K-Deposit — บัญชีออมทรัพย์ 221-1-90947-4 (เม.ย.-พ.ค. 2569)",
  "statement": {
    "bank": "Kasikornbank",
    "account_no": "221-1-90947-4",
    "account_holder": "บริษัท วู้ดแลนด์230 จำกัด",
    "period": "01/04/2026 - 31/05/2026",
    "opening_balance": 84826.72,
    "closing_balance": 78252.79,
    "bank_account_code": "111301",
    "bank_sub_code": ""
  },
  "source": {
    "source_src": "resultFile_20260623_115427  เม.ย.-พ.ค.pdf",
    "source_page": 1,
    "source_pages": [1, 2, 3],
    "source_sheet": null,
    "image_src": null
  },
  "review_flags": [],
  "questions_for_user": [],
  "rows": [
    {
      "row_index": 0,
      "date_iso": "2026-04-01",
      "time": "14:16",
      "description": "โอนเงิน (K BIZ)",
      "counterparty": "X9286 บจก. จี-บิซ ดิจิท++",
      "direction": "out",
      "amount": 5130.24,
      "balance": 79696.48,
      "account_code": "212101",
      "sub_code": "",
      "account_name_th": "เจ้าหนี้การค้า",
      "confidence": "medium",
      "reason": "เงินโอนออกให้ G-BIZ ดิจิท เข้าเกณฑ์รายการจ่ายประจำให้ผู้ขายรายนี้ บันทึกล้างเจ้าหนี้การค้า",
      "needs_review": true
    }
  ]
}
```

### Field mapping (from PRD §D1)

- **`source.source_pages`/`source.source_sheet` are load-bearing, same as the
  invoice schema's `pages[].source_pages`/`pages[].source_sheet`** (M1): the
  Page Ledger derives a statement document's Reviewed state *only* from these
  explicit claims (see `docs/adr/0001-derived-page-ledger.md`) — membership
  in a reviewed segment or file proves nothing. `source.source_pages` is a
  list of ints, **required going forward** — the FULL page span of the
  statement document within its source PDF (e.g. `[1, 2, 3]` for a 3-page
  statement), not just the page it opens to. `source.source_page` remains
  only the iframe open-point (1-based page to open the source PDF to);
  `source.source_sheet` is the exact sheet name (string) when the statement
  source is a multi-sheet workbook, `null` otherwise. A statement doc missing
  `source_pages` leaves its non-primary pages Unaccounted and blocks the
  final Ledger Gate.

| Field | Source | Notes |
|---|---|---|
| `schema` | constant | always `"ksk_review_statement_data.v1"` |
| `group_id` | folder name | same convention as document groups |
| `label` | authored | human-readable label shown in the UI's statement selector |
| `statement.bank`, `statement.account_no`, `statement.account_holder` | group `interpretation.json` top level (or `ข้อมูลระบบ/_segments/seg_XXX_kbiz_statement/interpretation.json`) | 1:1 copy; `account_holder` may be `null` |
| `statement.period` | `interpretation.json.statement_period` | 1:1 copy, e.g. `"01/04/2026 - 31/05/2026"` |
| `statement.opening_balance`, `statement.closing_balance` | `interpretation.json` top level | 1:1 copy, numbers |
| `statement.bank_account_code` / `statement.bank_sub_code` | **new** — proposed by poirot during categorize (COA lookup, e.g. ออมทรัพย์ → `111301`) | GL contra account for this bank account; reviewer can override in the UI; `null`/unset blocks export |
| `source.source_src`, `source.source_page`, `source.source_pages`, `source.source_sheet`, `source.image_src` | same convention as `ReviewPage` in the invoice schema | run-root-relative; `source_pages`/`source_sheet` are the Page Ledger's coverage claim (see above), `source_page` is only the open-point; rewritten bucket-relative by the generator (`resolveSource`/`rewriteImageSrc`) |
| `review_flags[]`, `questions_for_user[]` | group `interpretation.json` top level (which itself carries the segment interpretation's own arrays through, 1:1) | **optional** top-level arrays; a consumer reading a review-data.json written before these existed must treat a missing field as `[]`, never as an error. Number/boolean/object/array entries are coerced to display text (see below) rather than rendered as `[object Object]`; `null`/`undefined`/empty-string entries are dropped, not coerced — see the string-coercion rule below for the exact keep-or-drop behavior |
| `rows[].date_iso`, `.time`, `.description`, `.counterparty`, `.direction`, `.amount`, `.balance` | `interpretation.json.transactions[]` | 1:1 copy; `amount` stays positive, `direction ∈ {"in","out"}` carries the sign. **Canonical field names are `description`/`counterparty`** — some interpretations in the wild mirrored the statement's own column names instead (`channel` for what the statement itself labels "ช่องทาง", `detail` for "รายละเอียด"); the builder falls back to those only when `description`/`counterparty` is genuinely absent (`null`/undefined), never when it's an explicit empty string |
| `rows[].account_code`, `.sub_code`, `.account_name_th`, `.confidence`, `.reason`, `.needs_review` | `categorize.json.lines[]` merged by `row_index = line_index` | same meaning as the invoice schema's `lines[]` fields |

### `review_flags[]` / `questions_for_user[]` string coercion

`interpretation.json`'s `review_flags`/`questions_for_user` are typed as
free-form arrays (an authoring agent could in principle write a number or an
object entry, not just a string), but the review page renders every entry as
plain text. The builder coerces each entry to a display string rather than
passing it through as-is, and the rule is a straight keep-or-drop, not a
"becomes an empty string" step: a string entry is kept verbatim *unless* it's
empty, in which case it's dropped; `null`/`undefined` is dropped directly (no
intermediate empty string is ever produced); a number/boolean is stringified
with `String(value)`; anything else (an object or array entry) is
`JSON.stringify`'d instead of hitting `String()` directly — `String({...})`
produces the literal text `"[object Object]"`, which tells the reviewer
nothing, while the JSON text at least shows the content.

The embedded HTML payload for this bucket (`ksk_review_statement_html_data.v1`, the
`DATA.kind === "statement"` branch alongside document buckets' `DATA.kind === "documents"`)
carries client info, COA rows, the content fingerprint, and one `statements[]` entry per
group folder (multiple bank accounts → multiple entries, one at a time in the UI). Each
`statements[]` entry also carries `review_flags[]`/`questions_for_user[]`, copied through
from the group's review-data.json with the same `?? []` default for files written before
these fields existed — the shipped `review-groups.ts`/`review-template.ts` render them above
the statement's header fields as two bullet lists (`.group-flags`, amber, one per
`review_flags[]` entry; `.group-questions`, blue, one per `questions_for_user[]` entry),
the statement branch's equivalent of the document branch's `.group-flags` list. The per-statement browser draft uses its own schema,
`ksk_review_statement_draft.v1` (`bank_account_key` plus per-row `account_key` /
`description` / `amount` / `reviewed` / `skipped` / `note`), keyed by the same fingerprint
scheme as document drafts — see PRD §D4.
