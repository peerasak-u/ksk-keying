# review-data.json contract (`ksk_review_group_data.v1`)

One file per doc group at `_doc_groups/<category>/<vat_treatment>/<group-id>/review-data.json`
(bank statement groups live at `_doc_groups/bank_statement/<group-id>/`). It is the normalized
input for `bun run --cwd tools/ksk review-groups`, which merges every group in a bucket into
one interactive `review.html` at the bucket root.

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
| `bank_statement` | PEAK_ImportJournal | Import_Journal | `peak_import_bank_statement.xlsx` |

The reviewer's export button opens a save dialog pre-filled with that filename (Chrome/Edge
File System Access API); the reviewer drops the file at the bucket root next to review.html.
