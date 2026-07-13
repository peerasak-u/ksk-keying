# Team evals — ออกแบบ eval ครบทีม agent (draft for discussion)

Date: 2026-07-13
Status: draft — ต่อยอดจาก `2026-07-11-agent-evals-design.md` (watson + sherlock ใช้งานจริงแล้ว)
เป้าหมาย: agent ทุกตัว + policy ของ parent สอบแยกได้ในหลักนาที โดยไม่ต้องรันทั้ง pipeline

## 1. หลักการกลาง: answer key verify ปลายทาง — certification run แปลงมันเป็นเฉลยของทุกชั้น

`samples/old-result/` (ไฟล์ PEAK export ที่รับรองแล้ว) บอกความจริงเฉพาะ **ปลายทาง**:
เอกสารไหนถูก book เป็นเลขที่/วันที่/ยอด/รหัสบัญชีอะไร มันไม่รู้จัก artifact กลางทาง
(segment boundary, interpretation, links, populate) เลย

ทางเดียวที่จะได้เฉลยของ agent กลางทางคือ **certification run** — หนึ่งครั้งต่อ
client-month ที่มี answer key:

```
freeze snapshot (ready-for-test)                     ← กันโฟลเดอร์ขยับใต้เท้า
  → blind full run (ห้ามแตะ old-result ตาม hard rule เดิม)
  → Ledger Gates ผ่าน + human review
  → diff peak_import_*.xlsx กับ old-result (ตอนนี้ manual → ดู §6)
  → จุดต่างทุกจุด adjudicate: ใครผิด (pipeline / answer key / นอก scope)
  = เดือนนั้นได้สถานะ "certified" — artifact กลางทางทุกไฟล์กลายเป็น
    ground truth ที่ harvest ได้สำหรับทุก agent
```

certification run แพง (ชั่วโมง) แต่จ่าย **ครั้งเดียวต่อเดือนข้อมูลใหม่** จากนั้น
unit eval ทุกตัววิ่งจากของที่ harvest ไว้ — นาทีเดียวจบ ไม่มีทางลัดอื่นที่ไม่โกง:
เฉลยกลางทางที่ไม่ได้มาจาก run ที่ถูก verify คือการเอา pipeline มาตรวจ pipeline

## 2. Flywheel เมื่อ old-result เพิ่มขึ้นเรื่อยๆ

เดือนใหม่ของ client เดิม (หรือ client ใหม่) ที่มี answer key มาถึง:

1. วางไฟล์: `ready-for-test/<client>/` (สภาพดิบ) + `old-result/<client>/` (เฉลย)
2. blind full run = ตัวมันเองคือ **job eval ชั้น 3** ฟรีหนึ่งรอบ (จับ regression ระดับ pipeline)
3. adjudicate จุดต่าง → certify
4. `harvest.ts` งอก unit case ใหม่ให้ทุก agent จากเดือนนั้น (เริ่ม `provisional`,
   ปลด solid เมื่อ verify ครบ) → bump `VERSION` ของ dataset agent ที่ได้เคสใหม่
5. เคสน่าสนใจ (failure mode ใหม่, เอกสารทรงใหม่) → กลั่นเป็น mini-case
   ออกแบบ must/must-not แบบ sherlock mini-live

ผลคือ dataset ทุก agent โตตาม old-result โดยอัตโนมัติ และของเก่าไม่เสื่อม
(เคสเป็นสำเนา self-contained — snapshot เดิมแก้ไม่ได้แล้ว)

## 3. ภาพรวมทั้งทีม — หน่วยสอบ / เฉลย / ตัวเลขหลัก

| agent | หน่วยสอบ (fixture) | เฉลยมาจาก | เกรดอะไร | ตัวเลข trust |
|---|---|---|---|---|
| ksk-magnum | โฟลเดอร์ client ดิบ (สำเนา ตัดเหลือไฟล์ context-relevant) | certified CLIENT.md + coa.csv | hard facts + coa.csv conversion + must-flag unknowns | silent wrong fact |
| ksk-columbo | โฟลเดอร์ + inventory.yaml | constraint file จาก certified manifest | must-cover / must-together / must-separate / policy exclusions | silent constraint break |
| ksk-watson | 1 visual segment (มีแล้ว v4) | certified interpretation + answer key + eye-check | 9 critical fields + page_disposition + expected flags | silent-error rate |
| ksk-marple (spreadsheet) | 1 xlsx/report segment | certified interpretation | ชุดเดียวกับ watson (schema เดียวกัน) — spec reuse | silent-error rate |
| ksk-marple (populate) | 1 batch populate:agent groups + source interpretation | certified group interpretation.json | line-selection multiset (amount±0.01 + desc) + totals + no invented lines | silent wrong/missing line |
| ksk-sherlock | interpretations 1 client (มีแล้ว v2) | mini-case must/must-not + certified links | cluster membership multiset + bookable docs | silent wrong link |
| ksk-poirot | batch ≤20 groups: interpretation + coa.csv + CLIENT.md ± coa_usage.json | **ตรงจาก answer key** (PEAK export มีรหัสบัญชีต่อบรรทัด) | account_code ต่อบรรทัด; ผิดแต่ needs_review/low-conf = flagged | silent wrong code |
| parent policy (ชั้น 2) | flag/question + CLIENT.md (JSON→JSON) | `## Decisions (auto)` ของ certified run | action + rule number ตรง; ห้ามหลุดไปถามคน | silent wrong decision |

จุดที่ต้องเน้น:

- **poirot คือตัวเดียวที่เฉลยมาจาก answer key ตรงๆ** — รหัสบัญชีต่อบรรทัดอยู่ใน
  PEAK export อยู่แล้ว harvest ง่ายสุด และเป็น agent ถูกสุด (JSON→JSON ไม่มี vision)
  → ควรทำเป็นตัวถัดไป
- **marple โหมด spreadsheet ไม่ต้องมี spec ใหม่** — output คือ
  `ksk_segment_interpretation.v1` ตัวเดียวกับ watson ใช้ `specs/watson.ts` ร่วม
  ต่างแค่ dispatch template กับชนิด input
- **columbo ห้ามเกรดด้วยการ diff manifest ตรงๆ** — segmentation ที่ถูกมีได้หลายแบบ
  (ลำดับ/การซอย id ต่างกันแต่ book เหมือนกัน) เฉลยจึงเป็น **ไฟล์ constraint**
  ไม่ใช่ manifest ทั้งใบ (ดู §4)

## 4. Grading design รายตัว (ตัวที่ยังไม่มี)

### ksk-poirot — `specs/poirot.ts`

- หน่วยเกรด: `(group_id, line_index) → account_code`
- states: `correct` / `wrong_flagged` (โค้ดผิดแต่ needs_review หรือ confidence ต่ำ)
  / `wrong_silent` / `missing` / `spurious`
- เพิ่มเมตริก **calibration**: ในบรรดาโค้ดที่ผิด กี่ % ที่ถูกยกธง —
  poirot ที่ดีคือ "ผิดได้ แต่ต้องรู้ตัว"
- ทุกเคสรัน **2 variants: with / without `coa_usage.json`** — ตอบ hypothesis
  เดิม (history ปิด gap แบบ 410101→410201 ได้แค่ไหน) ด้วย A/B บน dataset เดียว
- เตรียมเพิ่ม: สร้าง `coa_usage.json` ของ 216 จากมีนา/เมษา (งานเล็กแยก งานนี้ block variant B)

### ksk-columbo — `specs/columbo.ts`

เฉลยเป็น constraints ที่ทุก segmentation ที่ถูกต้องต้องสอดคล้อง:

```yaml
schema: ksk_eval_columbo_expected.v1
must_cover: inventory          # ทุก page/sheet ใน inventory.yaml ถูก assign หรือ excluded-มีเหตุผล
must_together:                 # เอกสารหลายหน้าเดียวกัน ห้ามโดนผ่า
  - [fileA.pdf p1, fileA.pdf p2, fileA.pdf p3]
must_separate:                 # คนละเอกสาร ห้ามถูก merge เป็น segment เดียว
  - [scanB.pdf p4, scanB.pdf p5]
expected_exclusions:           # policy rules 3/4/9 ต้องทำงาน
  - {file: รายงานภาษีขาย.pdf, reason: reference_report}
expected_routes:               # ประเภทที่ผิดแล้วพาไปตกเหว
  - {page: fileC.pdf p1, route: bank_statement}
```

- เกรดต่อ constraint: pass / broken-flagged (SUMMARY.md พูดถึงความไม่แน่ใจตรงนั้น)
  / broken-silent
- ที่มา constraints: certified manifest + จุดที่เคย adjudicate — ไม่ต้อง
  enumerate ทุกหน้า เอาเฉพาะจุดที่ "ผิดแล้วเจ็บ"

### ksk-marple (populate) — `specs/marple-populate.ts`

- input fixture: source interpretation ใหญ่ (เช่น settlement ทั้งเดือน) +
  รายการ group ที่ skeleton ติดป้าย `populate: agent`
- เกรด: เทียบ multiset ของบรรทัดที่เลือกเข้าแต่ละ group (จับคู่ amount ±0.01 →
  normalized description) + ยอดรวม group + ห้ามมีบรรทัดที่ source ไม่มี
- silent = บรรทัดเงินหาย/เกิน โดยไม่มีธง — นี่คือความเสี่ยงเงินตรงๆ รองจาก watson

### ksk-magnum — `specs/magnum.ts`

- เกรดเฉพาะ **hard facts** ที่เขียนเป็นโครงสร้างได้: company name (normalized),
  tax id (exact), buyer identity, มี/ไม่มี coa.csv+coa_usage, และ
  **must_flag_unknowns** (เช่น `vat_registered` ต้องยัง unknown ที่ Stage 0 — 
  ทายเองคือผิดแบบ silent)
- `coa-to-csv` conversion เกรดแบบ deterministic แยกไป §5 (ไม่ใช่หน้าที่ eval โมเดล)
- ไม่เกรด prose ของ CLIENT.md — เนื้อความอิสระเปลี่ยนได้โดยไม่ผิด

### parent policy — ชั้น 2 (JSON→JSON, ไม่มี vision, ถูกมาก)

- case = หนึ่ง `needs_confirmation` item หรือหนึ่ง flag (เช่น `wht_expected?`)
  + CLIENT.md ณ ตอนนั้น
- expected = บรรทัด `## Decisions (auto)` ของ certified run: action + rule number
- เกรด: action ตรง (rule number ตรงเป็น soft), และ **ห้าม escalate ไปถามคน**
  ในเคสที่ policy ครอบ — escalation เกินจำเป็นคือ fail แบบหนึ่ง
- นี่คือชั้นที่จับบั๊กตระกูล "ธง WHT ตายกลางทาง" ที่เป็นเหตุตั้งต้นของ evals ทั้งระบบ

## 5. ของที่ไม่ใช่โมเดล — plain unit tests (bun test, วิ่งใน CI ได้)

script พวกนี้ deterministic — ไม่ต้องเข้า eval framework ใช้ fixture เล็ก + `bun test`:

| script | fixture | assert |
|---|---|---|
| coa-to-csv | ผังบัญชี workbook ตัวอย่าง | rows/codes ตรง byte-for-byte |
| inventory | โฟลเดอร์จำลอง (pdf หลายหน้า, xlsx หลาย sheet, ไฟล์ junk) | census ตรง + skip-list ทำงาน |
| prelink | interpretations สังเคราะห์ | exact matches ครบ, residue ถูก |
| group-skeleton / group-populate | links.yaml + interpretations เล็ก | tree ถูก, populate:script copy 1:1, ป้าย populate:agent ถูกตัว |
| build-review-data | group ครบเครื่อง | source_src/source_page ทุกหน้า valid |
| ledger / gate | dispositions + inventory ขัดแย้งกันแบบต่างๆ | gate fail ถูกเคส ไม่ false-pass |

หลัก: **บั๊กที่จับได้ด้วย unit test ธรรมดา อย่าไปจ่ายค่า eval โมเดล**

## 6. Job-eval grader (ชั้น 3) — `evals/grade-vs-answer-key.ts`

ตัว certify ตอนนี้เป็นการนั่ง diff มือ ทำให้ flywheel ทั้งเส้นช้า ควรเป็น script:

- input: `peak_import_*.xlsx` ของ run ↔ ไฟล์ old-result เดือนเดียวกัน
- จับคู่เอกสารด้วย doc_no → date+amount fallback; เทียบเฉพาะ scope ที่สองฝั่งมี
  (ตาม comparison philosophy เดิม: ไฟล์เฉลยที่หายคือ dataset gap ไม่ใช่ agent fail)
- output: รายการจุดต่าง จัดกลุ่มเป็น scenario พร้อมชนิด (amount / code / date /
  missing / extra) — เหลือให้คน adjudicate เป็นรายการสั้นๆ แทนการไล่ทั้งไฟล์
- อันนี้ **ควรทำก่อนเพื่อน** เพราะมันคือคอขวดของการได้เดือน certified ใหม่
  ซึ่งเป็นวัตถุดิบของ eval ทุกตัว

## 7. สิ่งที่ต้องเตรียม (checklist)

ต่อ client-month ใหม่ที่จะเข้าระบบ:

- [ ] snapshot ดิบใน `ready-for-test/` (freeze แล้วไม่แตะอีก)
- [ ] ไฟล์เฉลยครบใน `old-result/` (ขาดหมวดไหนจดเป็น dataset gap)
- [ ] เวลา 1 certification run (blind) + human review ตามปกติ
- [ ] เวลา adjudicate จุดต่างจาก grade-vs-answer-key (คาดหลัก 10-20 จุดต่อเดือนแรกๆ)

ครั้งเดียวทั้งระบบ:

- [ ] `grade-vs-answer-key.ts` (§6)
- [ ] `coa_usage.json` ของ 216 จากมีนา/เมษา (ปลดล็อก poirot variant B)
- [ ] spec + harvest/dispatch branch ต่อ agent ใหม่ (poirot → marple → columbo →
  policy → magnum) — แต่ละตัวผ่าน 6 ขั้นเดิม (spec → branch → self-test →
  negative test → harvest → live + baseline + SCOREBOARD)
- [ ] bun test สำหรับ script ใน §5

## 8. ลำดับความคุ้ม (แนะนำ)

1. **grade-vs-answer-key** — ปลดคอขวด certification; ทุกอย่างรอตัวนี้
2. **poirot** — เฉลยตรงจาก answer key, JSON→JSON ถูกสุด, ได้คำตอบ coa_usage A/B
3. **marple (populate)** — ความเสี่ยงเงินสูงสุดที่ยังไม่มีตาข่าย
4. **marple (spreadsheet)** — แทบฟรี (reuse watson spec)
5. **parent policy ชั้น 2** — จับ class บั๊กที่เป็นเหตุตั้งต้นของระบบ
6. **columbo** — ต้องออกแบบ constraint harvest เพิ่ม
7. **magnum** — เสี่ยงต่ำสุด hard-fact ไม่กี่ช่อง
8. script unit tests — แทรกได้ตลอด ไม่ block ใคร

## ต้นทุนโดยประมาณต่อรอบ (หลัง dataset พร้อม)

| suite | เวลา | token |
|---|---|---|
| poirot (ทั้ง dataset, 2 variants) | นาที | ต่ำ (ไม่มี vision) |
| marple populate | นาที | ต่ำ-กลาง |
| columbo (ต่อ client) | ~5 นาที | กลาง (สแกนโฟลเดอร์) |
| magnum | ~นาที | ต่ำ-กลาง |
| policy ชั้น 2 | วินาที-นาที | ต่ำมาก |
| watson / sherlock mini (เดิม) | นาที | ตามเดิม |
| job eval ชั้น 3 | ชั่วโมง | สูง — เฉพาะเดือนใหม่/ก่อน ship |
