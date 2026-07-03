# Extraction playbooks — classify first, then read by document kind

`ksk-watson` (and `ksk-marple` spreadsheet interpretation) reads *every* Thai
accounting document with the same generic instinct — which loses the hard rules
each document type needs (a PEA bill's real total is in the lower block; a WHT
certificate's seller is the withholder, not the preparer). This file carries
those rules, distilled from the eval-validated extraction prompts in
`.claude/skills/ksk-keying/scripts/prompts/extract-*.v1.txt` and their promptfoo assertions.

**Use it in two steps per document:**

1. **Classify** — decide the `doc_kind` from the signals below.
2. **Apply the matching playbook** — read the fields per that kind's rules.

Record the `doc_kind` you chose in the interpretation (e.g. on the document/role
block) so downstream stages and the reviewer can see which playbook applied.

> **Provenance / keeping honest.** Each playbook below is distilled from the
> eval-validated source prompt `.claude/skills/ksk-keying/scripts/prompts/extract-<doc_kind>.v1.txt`,
> which is regression-tested by `evals/promptfoo/extract-<doc_kind>.promptfooconfig.yaml`
> (`assert-extract.js`). When you change a rule here, change the source prompt and
> re-run its promptfoo eval so the two don't drift.

The playbooks describe *how to read each field*; emit the values into the normal
interpretation shape (`accounting_facts`, `line_items` with per-line VAT
evidence) — not the flat eval JSON envelope. Never fabricate a field; leave it
null and flag it.

## Classifier — pick the doc_kind

Taxonomy (from `gate.v4.txt`):

| doc_kind | Signal |
|---|---|
| `handwritten_bill` | Details mainly **handwritten** on a cash bill/receipt/preprinted tax-invoice form |
| `pwa_bill` | การประปา / การประปาส่วนภูมิภาค / Provincial Waterworks Authority (PWA) |
| `pea_bill` | การไฟฟ้า / การไฟฟ้าส่วนภูมิภาค / Provincial Electricity Authority (PEA) |
| `global_house_invoice` | Global House receipt / tax invoice / purchase document |
| `wht_certificate` | หนังสือรับรองการหักภาษี ณ ที่จ่าย (withholding tax certificate) |
| `delivery_note` | ใบส่งของ / delivery order (even when combined with ใบกำกับภาษี) |
| `bank_statement` | Bank statement / account movement report / passbook page |
| `normal_bill_or_invoice` | Ordinary printed receipt/bill/invoice/tax invoice that fits none of the above |
| *(generic)* | Usable accounting page (quotation, PO, credit/debit note, payment page) that fits no specialized kind — use the **generic** playbook |

**Priority — specific beats generic.** Choose `handwritten_bill`, `pwa_bill`,
`pea_bill`, `global_house_invoice`, `wht_certificate`, and `delivery_note`
*before* `normal_bill_or_invoice`. Two hard overrides:

- **ใบส่งของ anywhere in the title → `delivery_note`** (even with tax-invoice
  markings and one line).
- **Details mainly handwritten → `handwritten_bill`** (even on a preprinted
  tax-invoice/receipt form; VAT wording affects VAT treatment, not the kind).

If the page is not an accounting document (cover sheet, index, blank), it is not
a usable segment — flag it rather than forcing a kind.

---

## handwritten_bill

- Extract from the **printed item grid only**. Ignore free-write notes not inside
  fixed columns/slots — มัดจำ, เหลือ, โทร, transfer notes, circled margin totals,
  side annotations — even when written over the table.
- **Be conservative on descriptions.** Copy a handwritten description only when
  every important character is clearly readable end-to-end. If any key word is
  messy, crossed by notes, or ambiguous, use `"ไม่สามารถระบุได้"`. Never invent
  common product names (โทรศัพท์/โทรทัศน์) from shape, qty, unit, price, or seller
  type. If a guess conflicts with the visible unit/seller type → `"ไม่สามารถระบุได้"`.
- Every line must be a purchased item **with a visible amount**. Drop any line
  whose amount is blank/null. Do not emit printed choices, labels, or blank rows.
- Fuel forms: extract only rows with handwritten qty **and** amount; ignore blank
  preprinted fuel choices (they are menu options). Usually exactly one line.
- Totals: prefer the item-row amount column or a labeled total box. Simple
  one-item non-VAT cash bill → `pre_vat_total` = `gross_total` = that amount,
  `vat` = 0. Never use circled/deposit/balance notes as any total.
- `seller` = the printed header/business issuing the bill (top of form). Do **not**
  use the known accounting client as seller just because it's known. `buyer` is
  usually null unless clearly printed (use the client as buyer if a visible
  customer section matches it).
- `document_date`: read only the วันที่ / เดือน / พ.ศ. line — day, Thai month
  word/abbrev, year. Output **DD/MM/BBBB Buddhist year** (69 = 2569). Thai month
  mapping: ม.ค.=01, มี.ค.=03, ก.ย.=09, etc. The middle field is a month abbrev,
  not a number.
- `document_no`: the เลขที่/No. value — **not** เล่มที่ (book number).
- `vat_treatment`: usually 0; use 7 only when claimable VAT amount/rate is visible.
- `amount_includes_vat`: usually true for a simple cash-bill total; null if unclear.

## pea_bill (PEA electricity)

- Use **only the lower receipt/tax block** at or below ใบเสร็จรับเงิน/ใบกำกับภาษี.
  Ignore the upper notification, meter, usage-tier, Ft, and preview-totals section.
- `vat_treatment`: 7 when the lower block includes ใบกำกับภาษี and prints VAT at
  7% (ใบเสร็จรับเงิน **and** ใบกำกับภาษี together = tax invoice → 7). 0 when
  receipt-only without VAT. null only when genuinely unreadable.
- `seller.name` from the lower issuer block (การไฟฟ้าส่วนภูมิภาค or its abbrev).
- `document_date` from the lower bill/receipt section (issue/print date of the
  current-month charge).
- `pre_vat_total` = charge items before VAT (รวมเงิน above ภาษีมูลค่าเพิ่ม).
  `vat` = printed VAT in the lower block. `gross_total` = all-in payable
  (รวมเงินค่าไฟฟ้าเดือนปัจจุบัน or similar).
- Emit **one** line: the electricity charge (ค่าไฟฟ้า + period). Line amount = the
  pre-VAT charge total; `amount_includes_vat` = false.
- `document_no` from the lower block's bill/invoice number — not the meter or
  customer reference.

## pwa_bill (PWA water)

- `vat_treatment` = **7 for ALL PWA bills** (government utility, always full VAT
  invoice). Do not use buyer name to decide this.
- Emit only charge rows: **ค่าน้ำประปา** and **ค่าบริการทั่วไป**. Do **not** emit as
  lines: ภาษีมูลค่าเพิ่ม, ส่วนลด, ค่าน้ำค้างชำระ (arrears), รวมเงินครั้งนี้,
  รวมเงินที่ต้องชำระทั้งสิ้น. `amount_includes_vat` = false for charge rows.
- `document_no` = the water-bill number (เลขที่ใบแจ้งค่าน้ำ), **not** the customer
  account (รหัสผู้ใช้น้ำ). Put รหัสผู้ใช้น้ำ in `reference_no`.
- `pre_vat_total` = ค่าน้ำประปา + ค่าบริการทั่วไป (before VAT; **not** arrears).
  `gross_total` = "รวมเงินครั้งนี้" (subtotal after VAT, before arrears; =
  pre_vat_total + vat). `net_payable` = "รวมเงินที่ต้องชำระทั้งสิ้น" (final, with
  arrears).
- Date: DD/MM/BBBB Buddhist era (e.g. 12/05/2569).

## global_house_invoice

- Treat as a supplier purchase document. Prefer the Thai legal seller name.
  Extract seller and buyer tax IDs when readable.
- `vat_treatment` = 7 for VAT invoices. `gross_total` = printed grand total incl.
  VAT when shown; `pre_vat_total` = before VAT when visible.
- `document_no` = the tax-invoice number (เลขที่ใบกำกับภาษี), **not** the branch/
  store number (เลขที่สาขา) — Global House prints both; the invoice number is the
  longer alphanumeric identifier.
- Each line states `amount_includes_vat` (null if the printed column basis is
  unclear).

## wht_certificate

Roles (do not swap):

- `seller` = the **withholder** (ผู้มีหน้าที่หักภาษี ณ ที่จ่าย) — the payer who
  deducted tax.
- `buyer` = the **withholdee** (ผู้ถูกหักภาษี ณ ที่จ่าย) — the recipient who was paid.
- **Ignore any preparer** (ผู้ทำบัญชี / ผู้จัดทำ / "prepared by", or a name with
  บัญชี/accounting terms) — never assign it to seller or buyer.

Rules:

- Match field **labels** first, then read the value.
- `vat_treatment` usually null — WHT certificates don't show VAT; do not force 7.
- `wht` is the key amount when printed. `gross_total` = total paid to the
  withholdee (often จำนวนเงินที่จ่าย). `pre_vat_total`/`net_payable` stay null
  unless clearly labeled.
- Lines: only rows with a filled-in description **and** amount. Skip blank/
  template rows (unselected gray items like เงินเดือน ค่าจ้าง, ค่าธรรมเนียม,
  ดอกเบี้ย) unless they have real filled values.

## delivery_note (ใบส่งของ, may combine with ใบกำกับภาษี)

- `seller` = issuer (ผู้ขาย, ผู้จำหน่าย, ออกโดย, letterhead). `buyer` = addressee
  (ผู้ซื้อ, ลูกค้า, Ship To, ลูกค้า/ผู้รับสินค้า).
- `vat_treatment`: 7 when the page shows tax-invoice markings (ใบกำกับภาษี or a
  printed 7% VAT line); 0 for a pure delivery note clearly non-VAT; null when
  unreadable.
- `document_no`: header เลขที่ / ใบส่งของเลขที่ / ใบกำกับภาษีเลขที่. **Not** barcodes,
  13-digit tax IDs, product codes, or machine serials. `reference_no` = any
  secondary ref (PO No., เลขที่อ้างอิง).
- `document_date`: DD/MM/BBBB Buddhist era (05/03/2569, not 2026-03-05, not 05/03/69).
- Amounts: `pre_vat_total` = base before VAT (มูลค่าก่อนภาษี/มูลค่าสินค้า/Subtotal);
  `vat` = printed ภาษีมูลค่าเพิ่ม 7%; `gross_total` = รวมเงินทั้งสิ้น/TOTAL;
  `net_payable` = gross_total. On a tax-invoice-marked page always fill the full
  VAT breakdown; if only gross is printed and vat_treatment = 7, derive
  `pre_vat_total = gross_total / 1.07`, `vat = gross_total − pre_vat_total`.
- Lines: each item row (description, qty, unit, unit_price, amount); mark
  `amount_includes_vat` (typically pre-VAT on tax-invoice delivery notes). Include
  ขนส่ง (delivery charge) rows as separate lines. Never emit the VAT line as an item.

## bank_statement

- Support material, **not** a PEAK import document. `vat_treatment` = 0.
- `seller`/`buyer` usually null. `summary` briefly identifies the statement page.
- Lines optional — emit only when the transaction table is clearly readable and
  useful. `amount_includes_vat` always null.

## normal_bill_or_invoice

- Copy only visible facts.
- `seller` = issuer (ผู้ขาย, ผู้จำหน่าย, ออกโดย, letterhead). `buyer` = addressee
  (ผู้ซื้อ, ลูกค้า, นามผู้ซื้อ, Bill To, Ship To). When no buyer label, the party
  matching the client `business_name`/`tax_id` is the buyer; else null. Never swap
  seller/buyer; never use numbers/codes as a buyer name.
- `vat_treatment`: 7 for tax invoices (ใบกำกับภาษี) with seller tax ID visible; 0
  for cash/delivery receipts or no tax-invoice markings; prefer 7 when client
  context says `vat: true` and the page has tax-invoice markings; null only when
  truly ambiguous.
- `document_no`: header เลขที่ / Invoice No. / ใบกำกับภาษีเลขที่ (often TI…, IV…, B…).
  **Not** barcodes, 13-digit tax IDs, product codes (รหัสสินค้า), or machine
  serials near timestamps.
- `gross_total` = printed grand total (รวมเงิน/TOTAL/largest bold summary number).
  `pre_vat_total` = pre-VAT base (มูลค่าก่อนภาษี/Subtotal); for non-VAT receipts it
  equals gross_total (set vat = 0 only when explicitly printed as 0).
- Mark each line's `amount_includes_vat`. Discounts/promos shown negative (ส่วนลด,
  ของแถม with a minus) → separate lines with negative amounts.

## generic (fallback — usable page fitting no specialized kind)

- Copy only visible facts; keep the chosen `doc_kind`.
- seller/buyer/tax IDs only when readable. `vat_treatment`: 7 for a clear VAT/tax
  invoice, 0 for clearly non-VAT or payment/summary pages, null if unclear.
- `gross_total` = printed grand/transferred total when visible. `pre_vat_total`,
  `vat`, `wht`, `net_payable` stay null unless the page clearly prints them.
- Lines may be empty for payment confirmations/summaries. For quotations, POs,
  delivery notes, credit/debit notes: extract document number, date, parties,
  totals, and item rows when present. Never invent a more specific kind.
</content>
</invoke>
