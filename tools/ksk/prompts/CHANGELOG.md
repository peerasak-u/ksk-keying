# Gate prompt changelog

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
