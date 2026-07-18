---
name: ksk-stage-categorize
description: Stage 5 of the ksk-keying workflow — map each doc group to chart-of-accounts codes (⚡ ksk-poirot wave), build review-data, and generate the human review HTML. Invoked by the ksk-keying orchestrator after grouping; NOT a standalone entry point. Do not trigger from a user request — run ksk-keying instead.
compatibility: Claude Code `Agent` + `Workflow` tools with the project custom agent `ksk-poirot` in `.claude/agents/`. Runs the bundled `build-review-data` and `review-groups` Bun scripts.
---

# ksk-stage-categorize — Stage 5 (categorize, review-data, generate)

Assign account codes to every group, merge the pieces into review data, and render the human
deliverable. One poirot wave, then two deterministic parent-run scripts. This stage's output
feeds the orchestrator's `final` Ledger Gate and Completion check.

Shared rules this stage applies:

- **Orchestration rules** → `.claude/skills/ksk-keying/references/orchestration.md` (batch ≤20)
- **Decision Policy** → `.claude/skills/ksk-keying/references/decision-policy.md` (rules 7, 8 for account/VAT mapping)
- **Schema** → `.claude/skills/ksk-keying/references/review-data-schema.md`

## Input → output

- **in**: `<group>/interpretation.json`, `coa.csv`, `coa_usage.json` (optional), `CLIENT.md` (the context files live at the client root — the parent folder of `${monthPath}`; legacy layouts keep them at the run root)
- **out**:
  - `<group>/categorize.json` per group (ksk-poirot)
  - `<group>/review-data.json` (build-review-data)
  - `ตรวจทาน/<หมวด>/[<ภาษี>/]ตรวจทาน.html` — the human deliverable

## 5a — Categorize (⚡ one wave workflow)

One `ksk-poirot` unit per **batch of ≤20 groups** (chunk the manifest's group list in order,
keeping a batch inside one category/vat bucket when convenient — never one agent per group):

```
Agent({ description: "Categorize ×${n}", subagent_type: "ksk-poirot",
  prompt: `Categorize batch. Run root "${monthPath}". Groups (${n}): ${groupPathList}. Write categorize.json in each group folder.` })
```

## 5b — Review-data (deterministic, parent-run once)

After the categorize wave, merge each group's `interpretation.json` + `categorize.json` +
`CLIENT.md` buyer into `review-data.json`:

```bash
bun run --cwd .claude/skills/ksk-keying/scripts build-review-data -- "${monthPath}"
```

Exit 1 names groups with missing inputs — re-dispatch those, then re-run.

## 5c — Generate HTML (deterministic, parent-run once)

After all `review-data.json` exist (not a subagent):

```bash
bun run --cwd .claude/skills/ksk-keying/scripts review-groups -- --force "${monthPath}"
```

Writes each non-empty bucket's `ตรวจทาน/<หมวด>/[<ภาษี>/]ตรวจทาน.html` — all-Thai names
(`ค่าใช้จ่าย`/`รายได้`/`รายการเดินบัญชี` × `มีภาษี`/`ไม่มีภาษี`/`คละภาษี`;
`รายการเดินบัญชี` has no VAT level). Each is a **single self-contained** file (vendored JS
inlined — no `assets/` folder) so the reviewer can open just the one HTML; the browser's
XLSX export downloads as `นำเข้า PEAK - <หมวด ภาษี>.xlsx`. The reviewer previews the **real
source document** inline — the generator points each page at its `source_src` file (PDF via
`<iframe ...#page=N>`, images inline, xlsx as an embedded sheet table), so every
`review-data.json` page must carry a valid `source_src`/`source_page`, and spreadsheet pages
a valid `source_sheet`. Confirm each non-empty bucket produced its
`ตรวจทาน/<หมวด>/[<ภาษี>/]ตรวจทาน.html`.

## Hand-off

Control returns to the orchestrator for the Completion check (`final` Ledger Gate + the final
report). AI outputs are proposals, not final bookkeeping truth — human review remains
mandatory.
