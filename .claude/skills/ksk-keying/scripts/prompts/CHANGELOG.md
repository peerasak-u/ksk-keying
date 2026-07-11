# Gate prompt changelog

## prompts maintenance — 2026-07-09 (promptfoo retired)

- The promptfoo eval suite that originally validated these prompts is retired —
  the keying workflow no longer uses it, and no eval configs exist (or are
  expected) in this repo. Prompt changes are maintained by keeping each prompt
  in sync with its distilled playbook in `references/extract-playbooks.md` and
  recording every change here. Older entries below that cite promptfoo results
  are historical records of runs that happened elsewhere.

## extract-*.v1.txt — 2026-07-09 (shared-rules sync)

- Mirror the three shared rules from
  `references/extract-playbooks.md` → "Three shared rules apply to every
  doc_kind" into every extract prompt so the playbook and the eval'd source
  prompts don't drift:
  - **document_no from the document only** — absent/illegible → `null`; never
    substitute a number from another page, another document, or a
    report/listing that mentions the same purchase.
  - **WHT observation** — printed หัก ณ ที่จ่าย line, attached WHT certificate,
    or paid amount cleanly lower than the total by 1/2/3/5% of the base; fill
    `wht` only from what the page shows, never compute or assume a rate.
  - **VAT by content, not paper format** — a slip printing a 7% VAT breakdown
    with the client/buyer identified is a tax invoice (`vat_treatment = 7`,
    fuel-station slips commonly are); VAT amount with no buyer identification
    stays 0 with confidence low.
- Adapted per doc_kind rather than pasted blindly:
  - `bank_statement`: no-borrowing + no-derived-VAT/WHT lines only
    (vat_treatment is fixed at 0; kind has no real document_no/VAT surface).
  - `pea_bill` / `pwa_bill`: document_no rule only (VAT handling is fixed by
    the bill block / always-7 rule; utility bills don't print WHT).
  - `wht_certificate`: document_no rule + "wht as printed, never from a rate"
    (VAT rule skipped — vat_treatment is usually null on certificates).
  - `delivery_note` / `global_house_invoice`: document_no + WHT rules (VAT is
    already decided by tax-invoice markings / fixed for VAT invoices).
  - `handwritten_bill`, `normal_bill_or_invoice`, generic: all three rules.
- Output schema unchanged: the flat eval envelope has no warnings field, so
  the playbook's `document_no_not_found` warning maps to `document_no: null`,
  and its "review flag" maps to low confidence.
- No promptfoo re-run: the eval suite is retired (see the entry above) — sync
  with the playbook + this changelog is the maintenance contract now.

## extract-delivery_note.v1.txt — 2026-06-28 (new)

- Created dedicated delivery_note extract prompt to replace the too-conservative
  generic fallback (`extract-generic_accounting_document.v1.txt`).
- Key behavioral rules:
  - Always extract full VAT breakdown (pre_vat_total, vat, gross_total) when
    the delivery note has tax invoice markings (ใบกำกับภาษี).
  - Derive pre_vat_total = gross_total / 1.07 when not separately printed but
    VAT applies.
  - net_payable = gross_total for delivery notes (no separate net figure).
  - Line amounts are typically pre-VAT; mark via amount_includes_vat.
  - Dates in DD/MM/BBBB Buddhist era format.
- Result: flash 100% (3/3 cases), flash-lite pass on 2/3 (case 3 fails: OCR
  precision on document_no + arithmetic error on pre_vat_total — model limit).
- Prompt map wiring: `extract.ts` PROMPT_BY_DOC_KIND and `extract.cases.js`
  PROMPT_MAP.
- Eval expected_net_payable corrected from pre_vat_total → gross_total
  (ponytail annotations were provisional; confirmed net = gross on these
  combined ใบส่งของ/ใบกำกับภาษี).

## gate.v3.txt — 2026-06-27

- Strengthen `expense_vat` routing for single purchase documents that visibly
  show VAT evidence.
- Treat visible `ใบกำกับภาษี`, `receipt/tax invoice`, VAT lines, separate VAT
  amounts, and supplier tax ID + buyer business details as strong positive
  signals for `expense_vat`, including handwritten bills.
- Reject terms/warranty/return-policy/installation-instruction attachments with
  no visible transaction data as `usable=false`,
  `unusable_kind=non_accounting_document`.
- Route combined delivery note/tax invoice pages such as `ใบส่งของ/ใบกำกับภาษี`
  by VAT evidence; supplier purchase pages with visible VAT go to `expense_vat`.
- Make register/list rejection the first mandatory decision, including
  `รายการซื้อน้ำมัน` / monthly VAT purchase tables with VAT columns and
  approval signatures.
- Prefer specific document labels over generic invoice labels; combined
  `ใบส่งของ/ใบกำกับภาษี` stays `doc_kind=delivery_note`.
- Keep handwritten/preprinted forms as `doc_kind=handwritten_bill` when the
  transaction fields are mainly handwritten, even if the printed form title is
  a tax invoice/receipt.
- Clarify override precedence: payment confirmations reject before routing;
  Thai utility bills and Global House keep their specific doc kinds before VAT
  or generic invoice handling.
- Add promptfoo coverage for `samples/realworld/_345 หจก.ประเสริฐเมืองเลย(คุณลัก)`
  fuel/oil pages and include that client's `client.json` in promptfoo to better
  match live gate context.

## gate.v2.txt — 2026-06-27

- Reject accounting-office cover/index/register pages as `usable=false`,
  `doc_kind=unknown`, `group=unknown`, `unusable_kind=cover_or_index`.
- Pattern: monthly sheets listing many separate source documents/vendors with
  document codes, dates, invoice/tax-invoice numbers, VAT/amount columns,
  totals, approval/signature blocks, or headings like `รายการซื้อ`,
  `รายการบิลเงินสด`, `รายการภาษีซื้อ`, `ใบสำคัญจ่าย`, `ประจำเดือน`,
  `ส่งสำนักงานบัญชี`.
- Preserve multi-page index context: first/middle/last page when the unusable
  register visibly continues.
- Triggered by review of `samples/realworld/_345 หจก.ประเสริฐเมืองเลย(คุณลัก)`
  page-001 false positives, especially `PSL ใบสำคัญจ่าย` and
  `ดอกเบี้ยเงินกู้-03-69`.
