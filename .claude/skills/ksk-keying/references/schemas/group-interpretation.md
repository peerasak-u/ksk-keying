# `ksk_group_interpretation.v1` — doc-group interpretation schema

Single source of truth for each doc group's `interpretation.json` under
`ข้อมูลระบบ/_doc_groups/<category>/<vat_treatment>/<group-id>/`. Written by the
deterministic `group-populate` script for `populate: script` groups (the 1:1
majority) and by `ksk-marple` for `populate: agent` groups. The deterministic
`build-review-data` script consumes it, so the shape is load-bearing.

## Top-level fields

| field | content |
|---|---|
| `schema` | `"ksk_group_interpretation.v1"` |
| `group_id` | the group's id — copy from the group's entry in `ข้อมูลระบบ/_doc_groups/manifest.yaml` |
| `category` / `vat_treatment` / `bookable_doc` / `segments` | copy verbatim from the group's manifest entry |
| `transaction` | `{transaction_id, evidence}` from links, or `null` when the group has no cross-segment transaction |
| `facts` | this bookable doc's `accounting_facts` — carry `seller_tax_id`/`buyer_tax_id` through from the source; a 13-digit เลขประจำตัวผู้เสียภาษี belongs in those structured fields, never inside the name string |
| `documents[]` | each with `source_file`, `source_page`, `source_pages` (**every** page/sheet this group claims), `source_sheet` when from a workbook, and `lines_owner: true` on the document(s) the line items belong to, `false` on shared payment/evidence docs |
| `line_items[]` | this group's lines only — real descriptions, amounts, per-line VAT evidence |
| `review_flags[]`, `questions_for_user[]` | as usual |

## Line-selection rules (populate: agent groups)

- Select **that group's** facts and line items from the upstream segment
  interpretation — typically a subset of a large settlement/report sheet.
- Carry real line-item descriptions, amounts, and per-line VAT evidence —
  never collapse a purchase bill to just vendor + invoice number.
- Never pull in lines belonging to another group's bookable document; treat
  each group as its own bounded unit and never blend lines across groups.

## Bank-statement groups — extra top-level fields

| field | content |
|---|---|
| `statement` | `{bank, account_no, account_holder, period, opening_balance, closing_balance}` |
| `source` | `{source_src, source_page, source_pages, source_sheet, image_src: null}` |
| `transactions[]` | `{date_iso, time, description, counterparty, direction: in|out, amount, balance}` |

## Skeleton example (non-bank group)

```json
{
  "schema": "ksk_group_interpretation.v1",
  "group_id": "expense-vat-0012",
  "category": "expense",
  "vat_treatment": "vat",
  "bookable_doc": "IV6804-0101",
  "segments": ["seg-004"],
  "transaction": { "transaction_id": "txn-0007", "evidence": "slip 2026-04-05 amount 856.00" },
  "facts": {
    "direction": "expense",
    "document_date": "2026-04-03",
    "document_no": "IV6804-0101",
    "seller_name": "...",
    "seller_tax_id": "0105535099511",
    "buyer_name": "...",
    "buyer_tax_id": "0403552002592",
    "gross_total": 856.0,
    "vat": 56.0,
    "wht": null,
    "net_paid": 856.0,
    "currency": "THB",
    "description": "..."
  },
  "documents": [
    { "source_file": "บิลซื้อ เดือน เมษายน.pdf", "source_page": 1, "source_pages": [1], "lines_owner": true },
    { "source_file": "สลิปโอน.pdf", "source_page": 1, "source_pages": [1], "lines_owner": false }
  ],
  "line_items": [
    { "description": "...", "qty": 2, "amount": 800.0, "amount_includes_vat": false, "vat_rate": 7 }
  ],
  "review_flags": [],
  "questions_for_user": []
}
```
