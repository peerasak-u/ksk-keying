# Team evals — stage-first design (v2)

Date: 2026-07-13 (rev 2 — โครงเปลี่ยนจาก agent-first เป็น stage-first หลังคุยรอบสอง;
ฉบับ agent-first ก่อนหน้าอยู่ใน git history ของไฟล์นี้)
Status: draft — ตกลงหลักการแล้ว รอเรียงคิว implement
เป้าหมาย: ระหว่าง develop ทดสอบเป็น unit of work ได้ในหลักนาที โดยไม่ต้องรันทั้ง
pipeline; pipeline เต็มรันน้อยครั้ง (สั่งเมื่อไหร่ค่อยรัน)

## 0. โครงสามชั้น — unit ของการ eval คืออะไร

| ชั้น | หน่วย | ใช้เมื่อแก้อะไร | ความเร็ว |
|---|---|---|---|
| 1 · Agent unit | agent เดียว + เคสเดียว (มีแล้ว: watson, sherlock) | playbook/prompt ของ agent ตัวเดียว | นาที — loop รายวัน |
| 2 · **Stage** | skill ย่อย 1 stage: artifact เข้า → artifact ออก | SKILL.md ของ stage, dispatch/wave, policy gate, script ใน stage | ~10 นาที — ก่อน merge |
| 3 · Pipeline (job) | ทั้ง workflow บน snapshot แช่แข็ง | ก่อน ship / เดือนใหม่ที่มี answer key | ชั่วโมง — ตามสั่ง |

หลักที่ทำให้ชั้น 2 เป็นไปได้: ทุก stage ของ ksk-keying จบด้วยการเขียนไฟล์ตาม
artifact contract — eval ของ stage จึงไม่สนว่าข้างในมีกี่ agent grader เห็นแค่
ไฟล์เข้ากับไฟล์ออก และ **stage N ทดสอบได้โดยไม่ต้องรัน stage 0..N-1** เพราะ
input ของมันคือ artifact ที่ certified แล้วของ stage ก่อนหน้า (clone มาวาง)

ชั้น 1 ไม่ถูกแทน — มันคือ loop ที่ทำให้ปิดบั๊กแบบ "วันที่ผี" ได้ในวันเดียว
(3 รอบวัด-แก้-วัด รอบละ 2-3 นาที) ชั้น 2 จับสิ่งที่ชั้น 1 มองไม่เห็น:
**บั๊กของกาว** — แจกงานผิด segment, wave merge ตกหล่น, policy gate ตัดสินผิด,
ธงจาก child ตายกลางทาง (ตระกูลเดียวกับเคส WHT 033 ที่เป็นเหตุตั้งต้นของ evals)

## 1. Certification flywheel — แหล่งเฉลยของทุกชั้น (คงเดิมจาก v1)

`samples/old-result/` verify เฉพาะปลายทาง (booking ใน PEAK export) ไม่รู้จัก
artifact กลางทาง ทางเดียวที่จะได้เฉลยกลางทางคือ **certification run** ต่อ
client-month ที่มี answer key:

```
freeze snapshot → blind full run (ห้ามแตะ old-result) → Ledger Gates + human review
→ diff peak_import_*.xlsx กับ old-result (ดู §7 grade-vs-answer-key)
→ adjudicate จุดต่างทุกจุด → เดือนนั้น "certified"
```

เดือน certified หนึ่งเดือนงอกข้อสอบให้**ทั้งสามชั้นพร้อมกัน**:
- ชั้น 1: harvest เคส agent จาก artifact ที่ verify แล้ว (ของเดิม)
- ชั้น 2: สภาพกลางทางทุกชั้น = fixture ของทุก stage (snapshot ตัดตามชั้น)
- ชั้น 3: run นั้นเองคือ job-eval regression หนึ่งรอบ

เมื่อ old-result เพิ่ม (จะเพิ่มเรื่อยๆ): เดือนใหม่ → certify หนึ่งครั้ง →
dataset ทุกชั้นโตเอง เคสน่าสนใจกลั่นเป็น mini-case must/must-not
ปัจจุบันมี answer key 3 ราย: 216, 345, 356

## 2. Stage ทั้งหมด 12 จุด + ชนิด eval

| # | Stage | ใครทำ | artifact เข้า → ออก | eval แบบ |
|---|---|---|---|---|
| 0 | Client profile | magnum + policy gate | โฟลเดอร์ดิบ → CLIENT.md, coa.csv, Decisions log | 🎯 stage |
| 0.5 | Inventory | script | โฟลเดอร์ → inventory.yaml | 🧪 bun test |
| 1 | Segment | columbo + policy gate + ledger gate `segment` | โฟลเดอร์+inventory → manifest.yaml, SUMMARY, policy exclusions | 🎯 stage |
| 2 | Interpret | ⚡ watson/marple + shape gate + **lestrade (ใหม่ §4)** + merge + ledger gate `interpret` | manifest → interpretation.json ต่อ segment, fragments, dispositions.yaml | 🎯 stage (ใหญ่สุด) |
| 2.5 | Profile update | parent ล้วน | interpretations + CLIENT.md → frontmatter patched | 🎯 stage (ถูกมาก) |
| 3 | Link | script prelink + sherlock | interpretations → links.draft.yaml → links.yaml | 🎯 stage |
| 4a | Group skeleton | script | links + interpretations → tree + ป้าย populate | 🧪 bun test |
| 4b | Group populate | script + ⚡ marple (`populate: agent`) | skeleton + interpretations → group interpretation.json | 🎯 stage |
| 5a | Categorize | ⚡ poirot | group interp + coa.csv + CLIENT.md → categorize.json | 🎯 stage |
| 5b | Review-data | script | interp + categorize + CLIENT.md → review-data.json | 🧪 bun test |
| 5c | Generate HTML | script | review-data → ตรวจทาน/*.html | 🧪 bun test |
| ✓ | Completion check | parent: gate `final` + รายงาน | ทุกอย่าง → รายงาน (auto-decisions, exclusions, cross-check) | อยู่ในชั้น 3 |

น้ำหนักงานของ 7 stage eval ไม่เท่ากัน:

- **เกือบฟรี (0, 1, 3, 5a, 2.5)** — "agent เดี่ยว + เปลือกบาง": stage eval ≈
  agent eval + policy gate/script รอบนอก (sherlock eval ปัจจุบัน clone client
  กลางทางอยู่แล้ว — แทบเป็น stage-3 eval แค่เพิ่ม prelink เข้า loop);
  2.5 เป็น parent ล้วน JSON→JSON
- **งานจริง (2, 4b)** — stage 2 มี orchestration เต็มรูปแบบ (wave, 15-page cap,
  sub-range, shape gate + re-dispatch, verify, merge fragments); 4b มี batch
  rule (ห้ามข้าม source interpretation)

## 3. กลไกกลางของ stage eval

- **`snapshot-stage.ts`** (สร้างครั้งเดียว): รับ client-month ที่ certified +
  หมายเลข stage → สำเนาโฟลเดอร์ที่มีเฉพาะ artifact ของ stage ≤ N-1
  (ตัด `ข้อมูลระบบ/` ส่วนที่เกิดทีหลังออก) — นี่คือ fixture ของ stage N
- **parent จำลอง**: ตัวถูกสอบของ stage eval คือ "parent ที่กำลังตาม SKILL.md
  ของ stage นั้น" ไม่ใช่ leaf — harness spawn parent ที่ถูกสั่งให้ทำ stage
  เดียวบน clone (ผ่าน Agent tool wrapper หรือ headless `claude -p`;
  เลือกตอน implement) แล้วหยุด
- **เกรด = gate ของ production + diff กับ certified**: ledger gate /
  validate-interpretation / group-gates ต้อง pass เป็นขั้นต่ำ แล้ว diff
  artifact ขาออกกับของ certified — ตรงไหนมีหลายคำตอบถูก (segmentation, การซอย
  sub-range) ใช้ constraint file แทน byte-diff (ปรัชญาเดียวกับ columbo §5)
- **invariant เดิมยังศักดิ์สิทธิ์**: dispatch prompt ที่ eval ใช้ mirror จาก
  SKILL.md คำต่อคำ — refactor แยก skill รายชิ้น (แผนแยก) ต้องแก้ eval
  dispatch ตามทันทีเสมอ และการ refactor นั้นใช้ eval ชุดนี้เป็น regression
  proof (รันก่อน-หลัง ตัวเลขต้องเท่าเดิม)

## 4. ใหม่: `ksk-lestrade` — claim auditor ท้าย Stage 2

**ปัญหา**: exclusion ที่ watson/marple ประกาศ (หน้า duplicate/blank) ไม่มีใคร
ตรวจซ้ำระหว่าง run — กลไกที่มีจับได้แค่ความครบ (ledger) ไม่ใช่ความถูก
ความผิดจะไปโผล่ทางอ้อม (เงินหาย, residue ค้าง) หรือรอตาคนตอน review
ซึ่งเห็นแค่เหตุผลข้อความ ไม่เห็นภาพหน้าจริง

**Contract** (ตกลงแล้ว 2026-07-13):

- lestrade เป็น **ผู้ตรวจคำกล่าวอ้าง ไม่ใช่ผู้อ่านรอบสอง** — input คือรายการ
  exclusion claims จาก artifact (parent ดึงจาก fragments/dispositions ให้)
- ต่อ 1 claim: **เปิดเอกสารจริงเฉพาะหน้าที่ถูกอ้าง** — claim `duplicate` เปิด
  หน้านั้น *และ* หน้าต้นฉบับที่ถูกอ้างว่าซ้ำ มาเทียบกัน (เลขที่เอกสาร วันที่
  ยอด คู่ค้า); claim `blank` เปิดหน้าเดียว; ตัดสิน จริง/เท็จ + หลักฐานสั้น
- **ไม่อ่านหน้า `used` เลย** — ภาระอ่านต่อเดือนจึงเล็กมาก (เฉพาะหน้า excluded
  + หน้าต้นฉบับอ้างอิง)
- **Verify, don't fix**: เขียนได้อย่างเดียวคือ verification report
  (verdict ต่อ claim) — ห้ามแตะ interpretation/fragment ใคร คง single-writer
  ownership และทำให้ตัวเลข eval ของ watson ไม่ถูกกลบ
- **Loop bound**: finding ที่ confirmed → parent re-dispatch เจ้าของเดิมพร้อม
  ข้อกล่าวหาเฉพาะจุด **1 รอบ** — verify ซ้ำไม่ผ่านอีก → ธงให้คน ไม่ ping-pong
- **Model: opus** — second opinion จาก model แข็งกว่า/คนละตัว ลด correlated
  error; ปริมาณงานน้อยจึงจ่ายไหว

**ตำแหน่งใน flow Stage 2**:

```
⚡ interpret wave (watson/marple)
→ shape gate + script sanity checks    ← รีดของ deterministic ก่อน (ดูล่าง)
→ ⚡ verify wave (lestrade, batch ตาม segment ที่มี excluded claims)
→ parent re-dispatch เฉพาะ confirmed findings (1 รอบ)
→ merge-dispositions → ledger gate interpret
```

**Script sanity checks ที่ต้องมาก่อน lestrade** (ของฟรี — อย่าจ่ายค่า opus
ให้สิ่งที่ script จับได้): ผลรวม line items = gross_total ±0.01, คณิต VAT 7%,
document_no ซ้ำข้าม segment (สัญญาณ duplicate หลุด/exclusion ผิด), เอกสาร used
ที่ไม่มี line item

**งานเสริมฝั่งคน (deterministic, แยกชิ้น)**: `review-groups` แสดง thumbnail
ของทุกหน้า excluded คู่เหตุผล (duplicate โชว์คู่หน้าต้นฉบับ) — ให้ human gate
ตัดสิน exclusion ด้วยตาในวินาทีเดียว ไม่ใช่อ่านแต่ข้อความเหตุผล

**Eval ของ lestrade — seeded-claim pattern** (สร้าง dataset ได้วันนี้ ไม่ต้องรอ
certification ใหม่):

- เอา interpretation + dispositions ที่ certified มา **ปลูกความผิด**: สลับ
  claim `duplicate` ให้ชี้หน้าที่ไม่ซ้ำจริง, ติดป้าย `blank` ให้หน้าที่มีเนื้อหา,
  ปลอม reason — ปนกับ claims จริงที่ถูกต้อง
- เกรดเป็น per-claim confusion matrix — สองตัวเลข trust:
  **miss rate** (ปล่อยผี — claim เท็จที่ไม่จับ) และ **false-positive rate**
  (ขี้ตกใจ — claim จริงที่ตีตกเป็นเท็จ ทำ re-dispatch บานโดยเปล่าประโยชน์)
- self-test: claims ทั้งชุดถูกต้อง → ต้อง 0 finding; negative: ปลูกครบทุกชนิด
  → จับครบ

## 5. Agent-unit evals ชั้น 1 ที่เหลือ (สรุปจาก v1 — รายละเอียดเต็มใน git history)

| agent | เฉลยจาก | หัวใจการเกรด |
|---|---|---|
| poirot | **ตรงจาก answer key** (รหัสบัญชีต่อบรรทัดใน PEAK export) | account_code ต่อบรรทัด; ผิด+needs_review = flagged; A/B with/without coa_usage.json |
| marple (spreadsheet) | certified interpretation | reuse `specs/watson.ts` ทั้งชุด (schema เดียวกัน) |
| marple (populate) | certified group interpretation | multiset บรรทัดที่เลือก (amount±0.01+desc) + totals + ห้าม invent |
| columbo | constraint file จาก certified manifest | must-cover / must-together / must-separate / expected_exclusions — ห้าม diff manifest ตรงๆ (คำตอบถูกมีหลายแบบ) |
| magnum | certified CLIENT.md + coa.csv | hard facts เท่านั้น (ชื่อ/tax id/buyer) + must_flag_unknowns (`vat_registered` ต้อง unknown ที่ Stage 0) — ไม่เกรด prose |
| lestrade | seeded claims (§4) | miss rate + false-positive rate |
| parent policy | `## Decisions (auto)` ของ certified run | action+rule ตรง; ห้าม escalate เกินจำเป็น |

## 6. bun tests — script ล้วน ไม่มีค่าโมเดล วิ่งใน CI

inventory, prelink, group-skeleton, group-populate (ฝั่ง script), build-review-data,
review-groups, ledger/gate (เคส dispositions ขัดแย้ง — ต้อง fail ถูกเคส ไม่
false-pass), merge-dispositions (ห้ามทับ human/agent_policy), validate-interpretation,
coa-to-csv + sanity checks ใหม่จาก §4

## 7. `grade-vs-answer-key.ts` — job grader ชั้น 3 (คอขวดของ flywheel)

- input: `peak_import_*.xlsx` ของ run ↔ old-result เดือนเดียวกัน
- จับคู่ doc_no → date+amount fallback; เทียบเฉพาะ scope ที่สองฝั่งมี
  (ไฟล์เฉลยหาย = dataset gap ไม่ใช่ agent fail)
- output: จุดต่างจัดกลุ่มเป็น scenario + ชนิด (amount/code/date/missing/extra)
  → เหลือรายการสั้นให้คน adjudicate
- **ทำก่อนเพื่อน** — ทุกอย่างในระบบรอเดือน certified ซึ่งรอตัวนี้

## 8. ต้องเตรียมอะไร + ลำดับ build

ต่อ client-month ใหม่: snapshot ดิบ (freeze) + ไฟล์เฉลยใน old-result +
1 certification run + เวลา adjudicate (หลักสิบจุดช่วงแรก) — จากนั้น dataset
ทุกชั้นโตเอง

ครั้งเดียวทั้งระบบ:

- [ ] `grade-vs-answer-key.ts` (§7)
- [ ] `ksk-lestrade`: agent definition + SKILL.md Stage 2 flow + script sanity
      checks + seeded-claim eval (§4) — คุณค่า production ทันที, dataset สร้างได้เลย
- [ ] `snapshot-stage.ts` + parent จำลอง (§3) — ปลดล็อก stage eval ทุกตัว
- [ ] poirot eval + `coa_usage.json` ของ 216 จากมีนา/เมษา (variant B)
- [ ] marple populate eval → marple spreadsheet (แทบฟรี)
- [ ] stage-2 eval เต็ม (ใช้กลไก §3; ตัว orchestration ใหญ่สุด)
- [ ] stage evals 0/1/3/5a (เปลือกบางรอบ agent eval) + 2.5 + 4b
- [ ] policy ชั้น 2, columbo constraints, magnum
- [ ] bun tests §6 — แทรกได้ตลอด ไม่ block ใคร

ลำดับแนะนำ: **1 grade-vs-answer-key → 2 lestrade → 3 poirot → 4 marple populate
→ 5 snapshot-stage + stage-2 eval → ที่เหลือตามคิว**
(lestrade ขยับขึ้นมาอันดับ 2 เพราะได้ทั้งคุณค่า production และ eval โดยไม่ต้อง
รอ certification ใหม่)

## ต้นทุนโดยประมาณต่อรอบ (หลัง dataset พร้อม)

| suite | เวลา | หมายเหตุ |
|---|---|---|
| agent unit (ชั้น 1) ต่อตัว | นาที | loop รายวัน |
| lestrade | นาที | อ่านเฉพาะหน้าที่ถูกอ้าง — น้อยมาก |
| stage eval (ชั้น 2) ต่อ stage | ~10 นาที | ก่อน merge เมื่อแตะ stage นั้น |
| pipeline (ชั้น 3) | ชั่วโมง | เดือนใหม่ / ก่อน ship / ตามสั่ง |
