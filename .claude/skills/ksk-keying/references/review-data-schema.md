# review-data.json contract (`ksk_review_group_data.v1` / `ksk_review_statement_data.v1`)

One file per doc group at `_doc_groups/<category>/<vat_treatment>/<group-id>/review-data.json`
(bank statement groups live at `_doc_groups/bank_statement/<group-id>/`). It is the normalized
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
_doc_groups/
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
  "pages": [
    {
      "ref": "บิลซื้อ/page-001",
      "short_ref": "page-001",
      "source_src": "บิลซื้อ เดือน เมษายน.pdf",
      "source_page": 5,
      "image_src": null,
      "extract_path": "_doc_groups/expense/vat/spaceco-marketing/interpretation.json",
      "categorize_path": "_doc_groups/expense/vat/spaceco-marketing/categorize.json",
      "facts": {
        "date": "2026-04-07",
        "document_no": "INV202604070001",
        "reference": null,
        "seller": "…", "seller_tax_id": "…",
        "buyer": "…", "buyer_tax_id": "…",
        "subtotal": 22500.0, "vat": 1575.0, "total": 24075.0, "paid": 23400.0,
        "summary": "…",
        "vat_treatment": "vat_7"
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
          "reason": "why this account was proposed",
          "needs_review": false
        }
      ],
      "initial_status": "reviewed"
    }
  ]
}
```

## Field rules

- One `pages[]` entry per reviewable document (a multi-page invoice is one entry with its
  primary page).
- **Preview source** — the review UI previews the *real* source document, not a rasterized
  page. Set:
  - `source_src`: the actual source file (**relative to the client root**) — the PDF, image,
    or xlsx that this document came from, e.g. `"บิลซื้อ เดือน เมษายน.pdf"`. Point at the file
    that physically exists in the client folder.
  - `source_page`: 1-based page number to open the source PDF to (the first page of this
    document within a concatenated scan). Use `null` for single-page images or when the whole
    file is the document.
  The generator rewrites `source_src` relative to the bucket, renders PDFs inline via
  `<iframe src="file.pdf#page=N">` opened to `source_page`, images via `<img>`, and other
  types (xlsx) as an "open source file" link. Always set these from real folder files — do
  **not** invent a path.
- `image_src` is a legacy rasterized fallback (`_pages/*.png`), **relative to the client
  root**; leave it `null` when `source_src` is set. The generator drops paths that don't
  exist. If neither `source_src` nor `image_src` resolves, the page shows "no document".
- `facts.vat_treatment`: `"vat_7"`, `"non_vat"`, `"unknown"`, or `""` — the document-level
  default used by the PEAK export.
- `lines[].vat_treatment`: set per line **only in `expense/mixed` groups** (`"vat_7"` /
  `"non_vat"`); leave `null` elsewhere so the document-level value applies. The export
  emits one PEAK row per (account, VAT treatment) combination.
- `amount` is the VAT-exclusive line value when `amount_includes_vat` is `false`.
- `facts.paid` = net amount actually paid/received (after WHT).
- `initial_status`: `"needs_attention"` whenever any line is `needs_review` or confidence
  is below high, or a review flag is unresolved; else `"reviewed"`.
- Amounts are numbers, not strings. Never fabricate a value — leave it `null` and flag it.

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

`_doc_groups/bank_statement/<group-id>/review-data.json` is a chronological transaction
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
  "source": { "source_src": "resultFile_20260623_115427  เม.ย.-พ.ค.pdf", "source_page": 1, "image_src": null },
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
      "reason": "Outbound payment to G-BIZ — matches recurring supplier pattern; contra to AP.",
      "needs_review": true
    }
  ]
}
```

### Field mapping (from PRD §D1)

| Field | Source | Notes |
|---|---|---|
| `schema` | constant | always `"ksk_review_statement_data.v1"` |
| `group_id` | folder name | same convention as document groups |
| `label` | authored | human-readable label shown in the UI's statement selector |
| `statement.bank`, `statement.account_no`, `statement.account_holder` | group `interpretation.json` top level (or `_segments/seg_XXX_kbiz_statement/interpretation.json`) | 1:1 copy; `account_holder` may be `null` |
| `statement.period` | `interpretation.json.statement_period` | 1:1 copy, e.g. `"01/04/2026 - 31/05/2026"` |
| `statement.opening_balance`, `statement.closing_balance` | `interpretation.json` top level | 1:1 copy, numbers |
| `statement.bank_account_code` / `statement.bank_sub_code` | **new** — proposed by poirot during categorize (COA lookup, e.g. ออมทรัพย์ → `111301`) | GL contra account for this bank account; reviewer can override in the UI; `null`/unset blocks export |
| `source.source_src`, `source.source_page`, `source.image_src` | same convention as `ReviewPage` in the invoice schema | client-root-relative; rewritten bucket-relative by the generator (`resolveSource`/`rewriteImageSrc`) |
| `rows[].date_iso`, `.time`, `.description`, `.counterparty`, `.direction`, `.amount`, `.balance` | `interpretation.json.transactions[]` | 1:1 copy; `amount` stays positive, `direction ∈ {"in","out"}` carries the sign |
| `rows[].account_code`, `.sub_code`, `.account_name_th`, `.confidence`, `.reason`, `.needs_review` | `categorize.json.lines[]` merged by `row_index = line_index` | same meaning as the invoice schema's `lines[]` fields |

The embedded HTML payload for this bucket (`ksk_review_statement_html_data.v1`, the
`DATA.kind === "statement"` branch alongside document buckets' `DATA.kind === "documents"`)
carries client info, COA rows, the content fingerprint, and one `statements[]` entry per
group folder (multiple bank accounts → multiple entries, one at a time in the UI). The
per-statement browser draft uses its own schema, `ksk_review_statement_draft.v1`
(`bank_account_key` plus per-row `account_key` / `description` / `amount` / `reviewed` /
`skipped` / `note`), keyed by the same fingerprint scheme as document drafts — see PRD §D4.
