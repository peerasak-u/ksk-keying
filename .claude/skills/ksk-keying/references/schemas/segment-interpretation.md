# `ksk_segment_interpretation.v1` — canonical Stage 2 result-file schema

Single source of truth for the interpretation file every Stage 2 child
(`ksk-watson` visual segments, `ksk-marple` spreadsheet/report segments)
writes. Deterministic scripts (prelink, group-skeleton, group-populate) parse
this file — an invented shape breaks the pipeline stages after the child is
gone. The `validate-interpretation` script enforces this shape; exit 0 is
required before a child replies.

The file has **exactly one schema** with two document shapes, discriminated by
`relationship.same_transaction`. Never improvise top-level arrays
(`transactions` as a document list, `document_groups`, `sub_documents`, …),
never repeat one document as several `documents[]` entries, and never scatter
facts outside the places named below. Adapt *field values* to what's actually
visible (never fabricate a field's content); do not adapt the *structure*.

## Shared rules — every result file

- Top level always carries `schema: "ksk_segment_interpretation.v1"`,
  `segment_id`, `documents[]`, `relationship`, `review_flags[]`,
  `questions_for_user[]`, `page_disposition[]`.
- **One `documents[]` entry per physical document — never per page.** A
  multi-page document is one entry; list its pages in `page_disposition` (and
  optionally `source_pages: [5, 6]` on the entry). A duplicate copy of a
  document already recorded is one entry with `usable_for_booking: false` and
  `evidence_role: "duplicate_copy"` — not a second entry repeating its
  `document_no`.
- Every `documents[]` entry carries `source_file`, `source_page`, `doc_kind`.
  (Spreadsheet children: `source_sheet` instead of / alongside `source_page`.)
- **Counterparties are structured fields**: every `accounting_facts` carries
  `seller_name`, `seller_tax_id`, `buyer_name`, `buyer_tax_id`. The 13-digit
  เลขประจำตัวผู้เสียภาษี goes in the `*_tax_id` field (string, `null` when the
  document doesn't show one) — **never appended inside the name string**.
  `prelink`'s exact matching and the PEAK export key on the structured tax id;
  a tax id buried in `seller_name` free text is invisible to them. Branch
  numbers ("สาขาที่ 00486") and addresses also stay out of the name — name
  means the party's name.
- **A document number comes only from the document itself.** When the number
  is absent or illegible, write `document_no: null` and add a warning
  `document_no_not_found` — never substitute a number from another page,
  another document, or any report/listing that mentions this purchase. A
  borrowed number silently corrupts the booking; a null with a warning gets a
  loud placeholder id downstream, which is the correct outcome.
- **Look for WHT on every document**: a printed หัก ณ ที่จ่าย line, an
  attached WHT certificate, or a paid amount cleanly lower than the total by
  1/2/3/5% of the base. Record exactly what the document shows in `wht`
  (`null` when it shows nothing) — never compute or assume a rate the document
  doesn't print. For a service-type expense (rent, professional fees,
  transport, repair services) from a juristic seller that shows no WHT
  evidence, add a review flag `wht_expected?`.
- **All money fields are THB.** `gross_total`, `vat`, `wht`, `net_paid`, and
  every `line_items[].amount` carry Thai-baht values; `currency` stays
  `"THB"`. For a foreign-currency document, preserve the face-value evidence
  in three optional fields alongside them: `original_currency` (ISO code,
  e.g. `"USD"`), `original_amount` (the foreign-currency gross), and
  `exchange_rate` (THB per unit of the foreign currency). Choose the THB
  figure in this priority order: **(a)** the document prints a THB settlement
  amount (payment block, payment memo, receipt line) — use that printed
  figure **verbatim**, never recompute it from the rate; the printed THB is
  what gets booked, and recomputation drifts by satang. **(b)** No printed
  THB but a printed exchange rate — compute `original_amount ×
  exchange_rate`, round to 2 decimals, and add a review flag saying the THB
  was computed. **(c)** Neither — keep the foreign face value in the money
  fields, set `currency` to the foreign code, and flag `needs_review`. Case
  (c) is the **only** situation where `currency` ≠ `"THB"` may leave this
  stage, and it must always carry a flag.
- **A money-in document that is a loan, not a sale, must say so in
  `document_role`.** Loan/OD draws, promissory-note proceeds, and director
  loans satisfy `direction: income` structurally (money comes in), so the
  category tree would file them under income unless the role carries the
  signal: use a role containing `loan` (e.g. `"loan_receipt"`), keep the loan
  wording (เงินกู้ยืม, OD, ตั๋วสัญญาใช้เงิน) in `description`, and flag
  `needs_review` — financing inflows are never revenue and a human must route
  the booking.
- **A credit note / return document books as a negative reduction, never a
  positive line.** ใบลดหนี้, ใบรับคืนสินค้า, or any document that reduces a
  referenced invoice: set `document_role` to name it (e.g. `"credit_note"`)
  **and** record `gross_total`, `vat`, and `net_paid` as **negative** even
  though the document prints them positive — the printed positive figure
  belongs in `description`/line-item text as evidence, never in the money
  fields. Tagging the role correctly but leaving the amount positive silently
  books the reduction as *more* expense instead of less, and the group looks
  otherwise unremarkable (high confidence, no flags) — invisible to a human
  reviewer skimming review-data.
- Per-line VAT evidence: each line reports `vat_rate` (7 or 0) or
  `vat_treatment` (`vat_7`/`non_vat`) and whether the amount includes VAT,
  when the document shows it. Downstream grouping uses this to detect
  documents that mix VAT and non-VAT line items; note explicitly when line
  items differ in VAT treatment.
- `transactions[]` at the top level exists **only** for bank-statement
  segments (rows with `date_iso`, `direction: in|out`, `amount`, `balance`) —
  never as a container for interpreted documents. Bank-statement segments keep
  the statement shape with top-level `transactions[]` rows.

## Shape A — one transaction

`relationship.same_transaction: true` — always used when the unit is a single
document, e.g. an invoice plus its receipt/payment slip. Facts and line items
live **at the top level only**. `documents[]` entries carry no
`accounting_facts`, no `document_no`, no `line_items` — the booking's number
is `accounting_facts.document_no`; a supporting document's own number goes in
`accounting_facts.reference`.

```json
{
  "schema": "ksk_segment_interpretation.v1",
  "segment_id": "segment-001",
  "documents": [
    {
      "artifact": "path/to/page-001.png",
      "source_file": "บิลซื้อ เดือน เมษายน.pdf",
      "source_page": 5,
      "doc_kind": "normal_bill_or_invoice",
      "document_role": "supplier_invoice",
      "evidence_role": "primary_accounting_doc",
      "usable_for_booking": true,
      "confidence": "high",
      "warnings": []
    }
  ],
  "relationship": { "same_transaction": true, "reason": "Same PO number / same seller / same payment evidence" },
  "accounting_facts": {
    "direction": "expense",
    "document_date": "2026-05-22",
    "document_no": "JTI69050020",
    "reference": null,
    "seller_name": "...",
    "seller_tax_id": "0105535099511",
    "buyer_name": "...",
    "buyer_tax_id": "0403552002592",
    "gross_total": 1234.56,
    "vat": 80.76,
    "wht": null,
    "net_paid": 1234.56,
    "currency": "THB",
    "description": "Purchase of goods"
  },
  "line_items": [],
  "review_flags": [],
  "questions_for_user": [],
  "page_disposition": [
    { "file": "บิลซื้อ เดือน เมษายน.pdf", "page": 5, "disposition": "used" },
    { "file": "บิลซื้อ เดือน เมษายน.pdf", "page": 6, "disposition": "excluded", "reason": "duplicate" }
  ]
}
```

## Shape B — bundle of independent documents

`relationship.same_transaction: false` — a dispatch window covering several
unrelated documents, e.g. "pages 1–15, ten separate supplier invoices".
**Every** `documents[]` entry nests its **own complete** `accounting_facts`
(including `direction` and `document_no` — write `"document_no": null`
explicitly when a document carries no number) and its own `line_items`.
Nothing document-specific at the top level: no top-level `accounting_facts`,
no top-level `line_items`. Do not rely on siblings or file-level context to
complete a document's facts — each entry must stand alone.

```json
{
  "schema": "ksk_segment_interpretation.v1",
  "segment_id": "segment-004",
  "documents": [
    {
      "source_file": "บิลซื้อ เดือน เมษายน.pdf",
      "source_page": 1,
      "doc_kind": "normal_bill_or_invoice",
      "document_role": "supplier_invoice",
      "evidence_role": "primary_accounting_doc",
      "usable_for_booking": true,
      "confidence": "high",
      "warnings": [],
      "accounting_facts": {
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
      "line_items": [
        { "description": "...", "qty": 2, "amount": 800.0, "amount_includes_vat": false, "vat_rate": 7 }
      ]
    },
    {
      "source_file": "บิลซื้อ เดือน เมษายน.pdf",
      "source_page": 2,
      "source_pages": [2, 3],
      "doc_kind": "handwritten_bill",
      "document_role": "supplier_invoice",
      "evidence_role": "primary_accounting_doc",
      "usable_for_booking": true,
      "confidence": "medium",
      "warnings": ["handwritten totals unclear"],
      "accounting_facts": {
        "direction": "expense",
        "document_date": "2026-04-05",
        "document_no": null,
        "seller_name": "...",
        "seller_tax_id": null,
        "buyer_name": null,
        "buyer_tax_id": null,
        "gross_total": 1500.0,
        "vat": null,
        "wht": null,
        "net_paid": 1500.0,
        "currency": "THB",
        "description": "..."
      },
      "line_items": [
        { "description": "...", "amount": 1500.0, "vat_treatment": "non_vat" }
      ]
    }
  ],
  "relationship": { "same_transaction": false, "reason": "independent purchases from different suppliers" },
  "review_flags": [],
  "questions_for_user": [],
  "page_disposition": [
    { "file": "บิลซื้อ เดือน เมษายน.pdf", "page": 1, "disposition": "used" },
    { "file": "บิลซื้อ เดือน เมษายน.pdf", "page": 2, "disposition": "used" },
    { "file": "บิลซื้อ เดือน เมษายน.pdf", "page": 3, "disposition": "used" }
  ]
}
```

## Page Disposition fragment — companion file, same dispatch

Every Stage 2 child also writes a fragment
`ข้อมูลระบบ/_pages/fragments/<segment_id>[-p<start>-<end>].yaml`
(schema `ksk_disposition_fragment.v1`): every page/sheet in the assigned range
exactly once, `used` or `excluded`-with-reason — silence about a page becomes
Unaccounted and blocks the Ledger Gate. Spreadsheet children use `sheet:`
instead of `page:`.

```yaml
schema: ksk_disposition_fragment.v1
segment_id: segment-001
entries:
  - {file: "บิลซื้อ เดือน เมษายน.pdf", page: 5, disposition: used}
  - {file: "บิลซื้อ เดือน เมษายน.pdf", page: 6, disposition: excluded, reason: duplicate}
```
