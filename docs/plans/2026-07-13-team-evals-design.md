# Team evals — stage-as-skill design (v3)

Date: 2026-07-13 (rev 3 — โครงเปลี่ยนจาก "stage-first เฉพาะใน eval" เป็น
**"stage เป็น skill จริง"** หลังคุยรอบสาม; ฉบับ agent-first (v1) และ stage-first (v2)
อยู่ใน git history ของไฟล์นี้)
Status: draft — ตกลงหลักการแล้ว (ออกแบบทั้ง 6 stage skills), รอเรียงคิว implement
เป้าหมายเดิมยังอยู่: ระหว่าง develop ทดสอบเป็น unit of work ได้ในหลักนาที โดยไม่ต้อง
รันทั้ง pipeline; pipeline เต็มรันน้อยครั้ง (สั่งเมื่อไหร่ค่อยรัน)

## 0. ทำไมต้อง v3 — stage ต้องมี "ตัวตน" ในโค้ด ไม่ใช่แค่หัวข้อ

v2 คิดถูกเรื่องเอา **stage** เป็นหน่วยทดสอบ แต่ติดกับดักหนึ่ง: ในโค้ดจริง stage
ไม่มีตัวตน — มันเป็นแค่ section (`### 2. Interpret …`) ใน `SKILL.md` ไฟล์เดียว
403 บรรทัด ผลคือ v2 §3 ต้องประดิษฐ์กลไกเทียมสองอย่างมาชดเชย:

- **"parent จำลอง"** — harness ที่ spawn parent แล้วสั่งให้ทำ *stage เดียว* บน clone
  (เพราะไม่มีหน่วยโค้ดที่แทน "stage 2" ให้เรียกตรงๆ)
- **`snapshot-stage.ts`** ที่ต้องรู้ว่า artifact ไหนเป็นของ stage ไหน จากการอ่าน
  prose ใน SKILL.md

v3 แก้ที่ราก: **ทำให้แต่ละ stage เป็น skill ย่อยจริง** พอ boundary ของ *โค้ด*
ตรงกับ boundary ของ *stage* หน่วย eval ก็คือ "รัน skill นั้นบน fixture แล้วดู artifact
ออก" — ตรงไปตรงมา ไม่ต้องจำลองอะไร และ dispatch prompt ที่เคยต้อง mirror ลง
`evals/dispatch.ts` คำต่อคำ ก็หายไปครึ่งหนึ่ง เพราะ stage eval **รัน skill ตัวจริง**
ไม่มีสำเนาให้ drift

### ข้อจำกัดที่ห้ามพัง (backbone ของดีไซน์ปัจจุบัน)

การแตกครั้งนี้ต้อง**ไม่**รื้อสิ่งที่ทำให้ unattended run เชื่อถือได้ — SKILL.md และ
memory (`ksk-autonomy-preference`) ย้ำไว้ชัด:

1. **parent เป็นเจ้าของ workflow state คนเดียว** — ถือ state ระหว่าง stage, ตัดสิน
   transition, ใช้ Decision Policy เอง (SKILL.md "the parent is the only workflow owner")
2. **context ของ parent คือทรัพยากรหายากสุด** — child เขียนเต็มลงดิสก์ ตอบ digest บาง;
   parent ส่ง path ไม่ส่ง content; ไม่มี narration turn
3. **Ledger Gate คือสมอความถูกต้อง** — ไม่ใช่การถามคนกลางรัน; ทุกหน้าต้องถึง terminal state
4. **agents judge, scripts copy** — งาน mechanical เป็น script ไม่ใช่ agent

ประวัติยืนยัน (ตรวจแล้วจาก git): `skills/ksk-keying` ถูก **ย้าย** ไป
`.claude/skills/ksk-keying` ใน `f1be3af` — ไม่ใช่ยุบจากหลาย stage-skill; "legacy
`ksk-xxx` stage-skill series" ที่เอกสาร `docs/ksk-team` พูดถึง คือ pipeline เก่า
*นอก* repo นี้ที่ถูกแทนด้วย subagent-team ทั้งยวง **ไม่มีหลักฐานว่าเคยลองแตก stage
เป็น skill แล้วล้มเหลว** — แต่ backbone 4 ข้อข้างบนคือของจริง v3 รักษามันโดย:
**stage skill เป็น "playbook ระดับ parent" ที่ parent โหลดทีละตัว ไม่ใช่ leaf ที่ถูก
เรียกแยกแล้วเป็นเจ้าของ state ของตัวเอง** (ดู §5)

## 1. สถาปัตยกรรม skill 4 ชั้น

| ชั้น | คืออะไร | ทำไมต้องมี / eval tier |
|---|---|---|
| **Orchestrator** `ksk-keying` | เหลือแค่ลำดับ stage + วาง gate ระหว่าง stage + input/artifact-contract index + stop rules + completion check (~100–120 บรรทัด สารบัญล้วน) | ตัวที่ job-eval (ชั้น 3) รันทั้งเส้น |
| **Stage skills** (ใหม่, 6 ตัว §2) | 1 skill = 1 stage ที่มีการตัดสิน/orchestration: ถือ dispatch prompt + wave logic + gate call + artifact-out ของ stage นั้น | **หน่วยของ stage eval (ชั้น 2)** |
| **Shared references** (§3) | decision-policy, wave-dispatch, ledger-gates, schemas — ดึงออกจาก SKILL.md ให้ทุก stage skill ลิงก์ (single source, ห้าม duplicate) | กัน 6 skills drift ออกจากกัน |
| **Leaf agents** (เดิม, ไม่แตะ) | magnum, columbo, watson, marple, lestrade, sherlock, poirot | **หน่วยของ agent-unit eval (ชั้น 1)** |

## 2. 6 stage skills — ออกแบบครบทั้งชุด

หลักจับคู่ boundary: 1 skill = ช่วงงานที่จบด้วย **artifact contract + gate** พอดี
stage ที่เป็น script ล้วน (inventory, skeleton, review-data, HTML) ถูก**ดูดเข้าไปเป็น
ขั้นตอนปิดท้ายของ stage skill ที่มันสังกัด** — ไม่แยกเป็น skill (มัน eval ด้วย bun test
อยู่แล้ว §10) 2.5 profile-update ผูกกับ stage 2 จึงอยู่ในตัวเดียวกัน

### 2.1 `ksk-stage-profile` (Stage 0 + 0.5 inventory)

- **artifact เข้า**: โฟลเดอร์ client ดิบ
- **ทำ**: dispatch `ksk-magnum` (1 foreground Agent) → policy gate (ตัว parent
  resolve `needs_confirmation` ด้วย Decision Policy rule 1/2/7) → รัน `inventory` script
- **artifact ออก**: `CLIENT.md` (frontmatter + Decisions log), `coa.csv` (required —
  convert จาก ผังบัญชี ถ้าไม่มี), บันทึกว่ามี `coa_usage.json` ไหม,
  `ข้อมูลระบบ/_pages/inventory.yaml`
- **gate**: hard blocker เดียว = ไม่มีทั้ง coa.csv และ COA workbook
- **eval หน่วย**: fixture = โฟลเดอร์ดิบ; grade = hard facts (ชื่อ/tax id/buyer) +
  `must_flag_unknowns` (`vat_registered` ต้อง unknown ที่ Stage 0) — ไม่เกรด prose
  (มาจาก magnum agent-eval design เดิม §5-v2)

### 2.2 `ksk-stage-segment` (Stage 1)

- **artifact เข้า**: `inventory.yaml`, โฟลเดอร์ client, `CLIENT.md`
- **ทำ**: dispatch `ksk-columbo` (1 foreground Agent) → policy gate (rule 3/4/5/9 —
  บันทึก exclusion `declared_by: agent_policy`)
- **artifact ออก**: `ข้อมูลระบบ/_segments/manifest.yaml`, `SUMMARY.md`, policy
  exclusions ใน `dispositions.yaml`
- **gate**: 🚦 Ledger Gate `segment` (exit 0 = ทุกหน้าอยู่ ≥1 segment)
- **eval หน่วย**: fixture = โฟลเดอร์ + inventory; grade = **constraint file** (must-cover /
  must-together / must-separate / expected_exclusions) — ห้าม diff manifest ตรงๆ
  เพราะ segmentation ถูกได้หลายแบบ + ledger gate ต้อง pass

### 2.3 `ksk-stage-interpret` (Stage 2 + 2.5) — ตัวใหญ่สุด

- **artifact เข้า**: `manifest.yaml` (segments ที่ผ่าน gate), `CLIENT.md`
- **ทำ** (orchestration เต็มรูปแบบ):
  1. ⚡ interpret wave — 1 `Workflow`: `ksk-watson` ต่อ visual segment/sub-range
     (**15-page cap**, chunk เอง ถ้า columbo ไม่ให้ sub_ranges), `ksk-marple` ต่อ
     spreadsheet segment; ทุก child เขียน `interpretation.json` + fragment
  2. 🚦 shape gate — `validate-interpretation` (exit 1 → re-dispatch เจ้าของไฟล์ ✗,
     ห้าม hand-patch)
  3. ⚡ verify wave — `ksk-lestrade` ต่อ segment ที่มี exclusion claim (ข้ามถ้าไม่มี);
     refuted claim → re-dispatch เจ้าของเดิม **1 รอบ** → ยังไม่ผ่าน → ธงให้คน
  4. `merge-dispositions` → 🚦 Ledger Gate `interpret`
  5. **2.5 profile update** — parent patch `CLIENT.md` frontmatter จาก interpretation
     summaries (VAT registration rule 2, business_nature, COA/VAT conventions) — ไม่อ่าน
     เอกสารซ้ำ
- **artifact ออก**: `interpretation.json`/`interpretation-p*.json` ต่อ segment,
  fragments, `claim-audit/<segment>.yaml`, `dispositions.yaml` (merged), `CLIENT.md`
  patched
- **eval หน่วย**: fixture = clone หลัง stage 1; grade = shape gate + ledger `interpret`
  ต้อง pass (**tier ที่ใช้ได้เลย ไม่ต้องมี answer key**) + diff interpretation vs
  certified (tier ที่รอ certification) — จับบั๊กกาว: แจกงานผิด segment, 15-page cap
  ไม่ทำงาน, merge ตก fragment, lestrade loop ผิด

### 2.4 `ksk-stage-link` (Stage 3)

- **artifact เข้า**: interpretation files, `dispositions.yaml`
- **ทำ**: `prelink` script (exact matches + residue, document granularity) →
  dispatch `ksk-sherlock` 1 foreground (ตัดสินเฉพาะ residue, owns `links.yaml`)
- **artifact ออก**: `links.draft.yaml`, `links.yaml`
- **gate**: หยุดเมื่อ link กำกวม/หลักฐานอ่อน (Decision Policy); ข้าม stage ได้ถ้าทุก
  transaction อยู่ใน segment เดียว
- **eval หน่วย**: fixture = clone หลัง stage 2 (sherlock eval ปัจจุบันทำแบบนี้อยู่แล้ว —
  เกือบเป็น stage-3 eval แค่เพิ่ม prelink เข้า loop); grade = per-cluster membership +
  ห้าม invent bookable doc + ต้าน poisoned draft (มี mini-case แล้ว)

### 2.5 `ksk-stage-group` (Stage 4a + 4b)

- **artifact เข้า**: `links.yaml`, interpretation files
- **ทำ**: `group-skeleton` script (tree + ป้าย `populate: script|agent`) →
  `group-populate` script (คัด 1:1 majority) → ⚡ `ksk-marple` wave เฉพาะ
  `populate: agent` groups (**batch ≤20 ต่อ source interpretation, ห้ามข้าม source**)
- **artifact ออก**: `_doc_groups/manifest.yaml` + tree + `interpretation.json` ต่อ group
- **gate**: group-gates (script)
- **eval หน่วย**: fixture = clone หลัง stage 3; grade populate = multiset บรรทัดที่เลือก
  (amount±0.01 + desc) + totals + ห้าม invent (reuse `specs/watson.ts` ได้บางส่วน)

### 2.6 `ksk-stage-categorize` (Stage 5a + 5b + 5c)

- **artifact เข้า**: group `interpretation.json`, `coa.csv`, `coa_usage.json`, `CLIENT.md`
- **ทำ**: ⚡ `ksk-poirot` wave (batch ≤20 groups → `categorize.json`) →
  `build-review-data` script → `review-groups` HTML generator
- **artifact ออก**: `categorize.json` ต่อ group, `review-data.json`,
  `ตรวจทาน/<หมวด>/<ภาษี>/ตรวจทาน.html`
- **gate**: feeds Ledger Gate `final` (อยู่ที่ orchestrator completion check)
- **eval หน่วย**: fixture = clone หลัง stage 4; grade = **account_code ต่อบรรทัดตรงจาก
  answer key** (ผิด + `needs_review` = flagged นับแยก); A/B with/without `coa_usage.json`

## 3. Shared references — อะไรย้ายออกจาก SKILL.md

ดึงส่วน cross-cutting ออกเป็นไฟล์เดียวใน `references/` ให้ทุก stage skill **ลิงก์
ไม่ copy** (drift = บั๊กเงียบ):

- `references/decision-policy.md` — Decision Policy 11 ข้อ + stop rules + auto-decision
  logging (ตอนนี้ 24 บรรทัดใน SKILL.md; profile/segment/interpret อ้าง rule คนละชุด)
- `references/wave-dispatch.md` — "how to run a wave": `Workflow` template, context
  hygiene, write-full-return-thin, no-child-spawns-subagent, 15-page cap ปรัชญา, batch ≤20
- `references/ledger-gates.md` — gate semantics (exit codes, clear-a-block ด้วย new
  evidence/human declaration, `declared_by` rules)
- เดิมมีแล้ว: `references/schemas/{segment,group}-interpretation.md`,
  `review-data-schema.md`, `extract-playbooks.md`
- **artifact-contract index** — คงไว้ที่ orchestrator (มันคือแผนที่ไฟล์ทั้งหมด);
  รายละเอียด schema ต่อไฟล์อยู่ที่ `references/schemas/` อยู่แล้ว

## 4. Orchestrator ที่เหลือ

`ksk-keying/SKILL.md` เหลือเฉพาะ: frontmatter + input contract + artifact-contract
index + **ลำดับ stage (เรียก stage skill ทีละตัว) + วาง gate ระหว่าง stage** + Stop
rules + Completion check (Ledger Gate `final` + รายงาน auto-decisions/exclusions/2.5/
cross-check) เป้า ~100–120 บรรทัด — จาก 403

## 5. Stage skills ประกอบกันตอน runtime อย่างไร (รักษา backbone)

**หัวใจ: stage skill เป็น playbook ระดับ parent ไม่ใช่ leaf agent** — parent ตัวเดิม
(หรือ eval stage-runner) เป็นคน "โหลด skill ของ stage ที่กำลังทำ ทีละตัว" แล้ว
execute stage นั้นเอง รวมถึงยิง wave ผ่าน `Workflow`

ทำไมต้องเป็นแบบนี้ ไม่ใช่ push ทั้ง stage ลง subagent:

- ถ้า stage 2 ทั้งก้อนไปอยู่ใน subagent ตัวเดียว subagent นั้นต้องยิง wave watson/marple
  = **child spawns subagents** ซึ่งผิดกฎเหล็ก wave ต้องอยู่ระดับ parent
- ดังนั้น: **parent โหลด instruction ของ stage ทีละอัน** → context เบา (โหลดแค่ stage
  ปัจจุบัน ทิ้งเมื่อจบ) → waves ยังอยู่ระดับ parent → single-owner-of-state ไม่พัง

**invocation จริง**: orchestrator อ่าน stage skill (ผ่าน Skill tool หรือ reference
pointer) ทำ stage นั้นจนจบ gate เก็บ digest บาง แล้วโหลด stage ถัดไป

**eval symmetry** (จุดที่ทำให้ v3 คุ้ม): harness spawn agent ระดับ parent (มี Agent +
Workflow) สั่งบรรทัดเดียว — "รัน `ksk-stage-<X>` บน fixture นี้ แล้วหยุด" agent ตัวนั้น
ทำหน้าที่ parent-สำหรับ-stage-เดียว ยิง wave ได้ตามปกติ **นี่คือ "parent จำลอง" ของ v2
แต่เหลือ prompt บรรทัดเดียว** เพราะ stage skill สเปคทั้ง stage ให้แล้ว —
`snapshot-stage.ts` ลดเหลือ utility คัดโฟลเดอร์ (เอา artifact ≤ stage N-1) ไม่ใช่ harness
จำลอง parent อีกต่อไป

## 6. Eval taxonomy บนโครงใหม่

| ชั้น | หน่วย | กลไก | dispatch-mirror? |
|---|---|---|---|
| 1 · Agent unit | leaf agent + เคส (watson, sherlock มีแล้ว) | harness เดิม (`dispatch.ts` → Agent → grade) | ยังต้อง mirror — แต่ mirror จาก **stage skill** ที่ dispatch มัน ไม่ใช่ SKILL.md ยักษ์ |
| 2 · Stage | 1 stage skill บน fixture | spawn stage-runner (prompt บรรทัดเดียว) → grade | **ไม่ต้อง** — รัน skill ตัวจริง = ตัว dispatch เอง |
| 3 · Pipeline (job) | orchestrator ทั้งเส้นบน snapshot | blind run + `grade-vs-answer-key.ts` | — |

**stage eval มี 2 grading tier** (สำคัญ — ทำให้ไม่ต้องรอ certification ถึงจะเริ่ม):

- **tier A · gate-based (ใช้ได้วันนี้ ไม่ต้องมี answer key)** — ledger/shape/group-gates
  ต้อง pass; จับบั๊กกาวได้เลย (แจกงานผิด, merge ตก, cap ไม่ทำงาน, gate misfire)
- **tier B · certified-diff (รอเดือน certified)** — diff artifact ออก vs certified
  (constraint file ตรงที่มีหลายคำตอบถูก)

`snapshot-stage.ts` (คัด fixture) เหลือเป็น pure file-copy — ต่างจาก v2 ที่คิดเป็น harness
จำลอง parent; invariant "dispatch prompt mirror จาก SKILL.md คำต่อคำ" ตายไปสำหรับ stage
eval (เหลือเฉพาะ agent eval ที่ mirror จาก stage skill)

## 7. Certification flywheel + lestrade (คงจาก v2, ย่อ)

`samples/old-result/` verify เฉพาะปลายทาง (booking ใน PEAK export) ไม่รู้จัก artifact
กลางทาง — เฉลยกลางทางมาจาก **certification run** ต่อ client-month ที่มี answer key:
freeze snapshot → blind run (ห้ามแตะ old-result) → Ledger Gates + human review →
`grade-vs-answer-key.ts` diff กับ old-result → adjudicate → เดือนนั้น certified

เดือน certified หนึ่งงอกข้อสอบให้ทั้งสามชั้น: ชั้น 1 harvest เคส agent; ชั้น 2 สภาพ
กลางทางทุก stage = fixture (`snapshot-stage.ts` ตัดตาม stage) — **certified-diff tier B**;
ชั้น 3 คือ run นั้นเอง ปัจจุบันมี answer key 3 ราย: 216, 345, 356 — **ยังไม่มีเดือนไหน
certified**

**lestrade seeded-claim eval** (สร้าง dataset ได้เลย ไม่ต้องรอ certification): เอา
interpretation + dispositions ที่ verify แล้วมาปลูกความผิด (สลับ duplicate ให้ชี้หน้าที่
ไม่ซ้ำ, ติด blank ให้หน้ามีเนื้อหา, ปลอม reason) ปนกับ claim จริง → grade per-claim
confusion matrix: **miss rate** (ปล่อยผี) + **false-positive rate** (ขี้ตกใจ);
self-test (claim ถูกหมด → 0 finding) + negative (ปลูกครบ → จับครบ)

## 8. ความเสี่ยง + วิธีคุม

| เสี่ยง | คุมยังไง |
|---|---|
| **6 skills drift ออกจากกัน** (decision policy/schema คนละสำเนา) | ดึงเป็น shared reference เดียว (§3) ทุก skill **ลิงก์ ไม่ copy** |
| **ไม่มี job-level regression** — refactor โครง deliverable โดยไม่มีตาข่ายรับ end-to-end | **แตกแบบ behavior-preserving**: รอบแรกเป็น "ย้ายข้อความ" (เนื้อหา stage เหมือนเดิม ย้ายที่) → รัน watson + sherlock eval **ก่อน/หลัง ตัวเลขต้องเท่าเดิม** = พิสูจน์ว่าไม่พัง |
| **ทำลาย single-owner-of-state / context hygiene** (สิ่งที่ทำให้ unattended run เชื่อได้) | stage skill = playbook ระดับ parent โหลดทีละตัว (§5) waves อยู่ระดับ parent ไม่ push ลง subagent — ownership ไม่แตก |
| **แตกทั้ง 6 ทีเดียวแล้วเจ๊งเงียบ** | ถึงจะออกแบบครบ 6 build ก็ **นำร่อง stage 2 (interpret) ก่อน** — ใหญ่/คุ้มสุด + มี fixture watson/marple/lestrade พิสูจน์ stage-eval กลไกได้ทันที (build order §9) |

## 9. Build order (v3)

**Phase A — โครง (behavior-preserving, พิสูจน์ด้วย eval เดิม):**

1. **ดึง shared references** (decision-policy, wave-dispatch, ledger-gates) ออกจาก
   SKILL.md → `references/` (SKILL.md ยังลิงก์เหมือนเดิม, zero behavior change, ย่อ
   SKILL.md, เป็น prereq ให้ stage skill สะอาด)
2. **นำร่อง `ksk-stage-interpret`** (แกะ stage 2+2.5) + **กลไก stage-eval**:
   `snapshot-stage.ts` (fixture builder) + stage-runner (prompt บรรทัดเดียว) +
   **tier-A grading** (gate-based) → รัน watson eval ก่อน/หลัง ตัวเลขต้องเท่า
3. **แกะอีก 5 stage skills** (profile, segment, link, group, categorize) — behavior-
   preserving ทีละตัว, guard ด้วย re-run agent/gate ที่เกี่ยว → **ย่อ orchestrator เป็น
   sequencer**

**Phase B — dataset/grader (track ขนาน, แทรกได้):**

4. **lestrade seeded-claim eval** (§7 — สร้าง dataset ได้เลย, คุณค่า production ทันที)
5. **certification run** เดือนแรก (216 มีนา/เมษา) → ปลดล็อก **tier-B certified-diff**
   ให้ทุก stage → แล้ว `grade-vs-answer-key.ts` (job grader ชั้น 3, §7)
6. poirot eval (+`coa_usage.json` 216) / marple populate / columbo constraints / magnum /
   parent policy — เติมตามคิว; **bun tests §10 แทรกได้ตลอด ไม่ block ใคร**

ลำดับแนะนำ: **1 shared refs → 2 นำร่อง interpret + stage-eval กลไก → 3 แกะที่เหลือ +
ย่อ orchestrator → 4 lestrade eval → 5 certification + grade-vs-answer-key → 6 ที่เหลือ**

## 10. bun tests — script ล้วน ไม่มีค่าโมเดล วิ่งใน CI (คงจาก v2)

inventory, prelink, group-skeleton, group-populate (ฝั่ง script), build-review-data,
review-groups, ledger/gate (เคส dispositions ขัดแย้ง — ต้อง fail ถูกเคส ไม่ false-pass),
merge-dispositions (ห้ามทับ human/agent_policy), validate-interpretation, coa-to-csv +
script sanity checks (ผลรวม line = gross ±0.01, VAT 7%, document_no ซ้ำข้าม segment,
used ที่ไม่มี line item)

## 11. ต้นทุนต่อรอบ (หลัง dataset พร้อม, คงจาก v2)

| suite | เวลา | หมายเหตุ |
|---|---|---|
| agent unit (ชั้น 1) ต่อตัว | นาที | loop รายวัน |
| lestrade | นาที | อ่านเฉพาะหน้าที่ถูกอ้าง |
| stage eval (ชั้น 2) ต่อ stage | ~10 นาที | ก่อน merge เมื่อแตะ stage นั้น; tier A รันได้แม้ยังไม่ certified |
| pipeline (ชั้น 3) | ชั่วโมง | เดือนใหม่ / ก่อน ship / ตามสั่ง |
