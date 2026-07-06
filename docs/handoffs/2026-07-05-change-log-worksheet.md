# Handoff: Change_Log worksheet for ksk-keying review.html export

**Date:** 2026-07-05
**Status:** Plan approved in conversation — implementation not started
**Goal:** Record what the agent team proposed vs what the human reviewer corrected, as an extra worksheet in the exported PEAK xlsx (phase 1), and optionally as a machine-readable feedback file (phase 2).

## Background

The ksk-keying review stage generates a single-file Vue 3 review page per doc-group bucket (`_doc_groups/<bucket>/review.html`). The human reviews/corrects agent-proposed account codes, descriptions, amounts, etc., then exports `peak_import_<bucket>.xlsx`. Today the diff between agent output and human corrections is discarded at export — there is no audit trail and no feedback loop into `coa_usage.json`.

Key discovery: **both copies of the data already coexist in the page**, so no pipeline or schema changes are needed:

- Agent original: `review-data.json` embedded verbatim as inline JSON (never mutated).
- Human working copy: Vue `this.states[]`, cloned from the original at load, auto-saved to localStorage (draft key includes `content_fingerprint`, so the baseline is stable).

## Code map (all paths relative to repo root)

All work happens in `.claude/skills/ksk-keying/scripts/review-template.ts` (the template is a template-literal HTML/JS file; line numbers as of commit `75fb8b5`):

| Concern | Location |
|---|---|
| Data embedding (`__DATA__` placeholder → `<script id="reviewData">`) | `review-template.ts:261-267`, `:720-722` |
| Document state cloning (`makeState()`) — facts, lines, status, note, skipped | `review-template.ts:880-904` |
| Statement state cloning — group_id, bank_account_key, rows | `review-template.ts:941-968` |
| Editable fields (document form) | `review-template.ts:488-577` |
| Editable fields (statement table) | `review-template.ts:580-677` |
| Export modal (stats tiles, warnings, preview) | `review-template.ts:680-718`, `:1279-1344` |
| PEAK row builders (expense/receipt/journal) | `review-template.ts:1313-1437` |
| Existing indirect original-vs-edited comparison (`groupLinesForExport`) | `review-template.ts:1439-1465` |
| XLSX download (`downloadExportXlsx`, appends sheets) | `review-template.ts:1484-1515` |
| Template callers | `review-groups.ts:413-530` (doc groups), `review.ts:432-453` (gate groups) |

Schema reference: `.claude/skills/ksk-keying/references/review-data-schema.md` — `ksk_review_group_data.v1` (pages/lines with `account_code`, `sub_code`, `confidence`, `reason`, `needs_review`) and `ksk_review_statement_data.v1` (statement + rows).

## Phase 1 — Change_Log worksheet (the deliverable)

All client-side, inside the Vue app in `review-template.ts`:

1. **`buildChangeLog()`** — walk `DATA.pages` vs `this.states[]` (and `DATA.statements` vs statement states), emitting one row per changed field. Track exactly the fields the UI can edit:
   - Document facts: date, seller, buyer, tax IDs, document_no, vat_treatment, subtotal, total, reference, vat, paid, summary.
   - Lines: `account_code`/`sub_code` (report as `code:sub — name`), description, qty, unit, unit_price, amount, vat_treatment.
   - Status: skipped toggle, status (reviewed/needs_attention), note added.
   - Statements: `bank_account_key` (bank GL account), per-row account/description/amount, reviewed/skipped.
2. **Worksheet columns (Thai headers to match PEAK sheets):** เอกสาร/กลุ่ม (+document_no), บรรทัด, ฟิลด์, ค่าจาก AI, ค่าหลังตรวจ, AI confidence, เหตุผล AI, ประเภทการแก้ (changed / skipped / added-note).
3. **Export modal:** add a "แก้ไข N รายการ" stat tile next to the existing committed/uncommitted tiles.
4. **`downloadExportXlsx()`:** append the sheet via `XLSX.utils.book_append_sheet(wb, changeSheet, 'Change_Log')`. PEAK ignores extra sheets, so the import file stays valid.

Decisions already made in conversation:
- Log **only changes** (plus skipped items), not confirmed-unchanged lines — keeps the audit trail readable. ("Confirmed correct" rows can be added later with a filter flip if accuracy metrics are wanted.)
- Diff is computed at export time from in-page data; no changes to review-data.json schema, the pipeline scripts, or the subagents.

## Phase 2 (optional, after phase 1 ships) — feedback loop

- Add a "ดาวน์โหลด changes.json" button emitting `ksk_review_changelog.v1`: `{ client_key, group, content_fingerprint, changes: [{ location, field, agent_value, human_value, confidence, reason }] }`.
- A small script (new `scripts/learn.ts` or similar) aggregates changes.json files into the client's `coa_usage.json` so ksk-poirot's account mapping learns from corrections. Note: SKILL.md currently declares `coa_usage.json` read-only for downstream agents — update SKILL.md if this lands.

## Verification

- `bun` is the runtime for `scripts/` (see `scripts/package.json`, `bun.lock`). Regenerate a review.html from an existing client's `_doc_groups` bucket via `review-groups.ts`, open it in a browser, edit a few fields, export, and confirm the Change_Log sheet contains exactly those edits (and the PEAK sheet is unchanged).
- Test both branches: a document bucket (expense/income) and a bank_statement bucket — the state shapes differ.
- Edge cases: line added/removed? (UI doesn't support adding lines — verify), skipped page, statement row skipped, account cleared to blank.

## Suggested skills

- `/tdd` — not applicable (browser template, no test harness in scripts/); skip.
- `/verify` — after implementing, drive the generated review.html end-to-end (agent-browser or claude-in-chrome skill can automate the click-through if no sample client folder is handy).
- `/commit` — read before committing; repo convention is conventional-commit style scoped to `ksk-keying` (see `git log`).
- `/code-review` — run at medium effort on the diff before committing; the template file is one large template literal, easy to break quoting/escaping.
