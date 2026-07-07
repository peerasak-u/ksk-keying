---
name: ksk-keying
description: Orchestrate the KSK client document keying workflow (classify, extract, review, export to PEAK account data) with a parent session and bounded Agent-tool subagents. Use when asked to "run ksk-keying", "key this client", "process this client with subagents", "segment and review this client", "run the new KSK workflow", or move a client from folder inspection to ข้อมูลระบบ/_segments, ข้อมูลระบบ/_doc_groups, and review artifacts.
compatibility: Claude Code `Agent` tool with project custom agents in `.claude/agents/` (`ksk-magnum`, `ksk-columbo`, `ksk-watson`, `ksk-sherlock`, `ksk-poirot`, `ksk-marple`, `ksk-lestrade`). No external subagent framework, no vision extension — Claude reads images natively via `Read`.
---

# ksk-keying

Run the KSK workflow through a parent-orchestrated subagent team. The parent (this session) is the only workflow owner — it holds state, decides stage transitions, and applies the Decision Policy so the run goes end-to-end without stopping. Do not route work through the legacy `ksk-xxx` stage-skill series unless the user explicitly asks for the old pipeline.

The workflow is built for **long unattended runs**: reliability comes from the deterministic Ledger Gates (every page must reach a terminal state), not from asking the human mid-run. Human review happens once, at the end, on the review pages and the decision log.

## Hard rule — the parent delegates, never does the work

The parent does **zero** document work. Every stage runs inside a subagent via the `Agent` tool — except the mechanical copy/transform steps, which are **deterministic scripts, not agents** ("agents judge, scripts copy"). The parent only: dispatches children, holds state between stages, runs the deterministic shell commands (`inventory`, `merge-dispositions`, `ledger`, `review-groups`), and stops at the human gates and Ledger Gates. Never read/interpret/link/map/group documents in the parent — doing so blows the context budget the whole design exists to protect.

Two things to maximize speed:

- **Fan out every independent unit in parallel** — issue all the `Agent` calls for a stage in **one message**; Claude Code runs them concurrently. Parallel stages are marked ⚡ below.
- **Keep dispatch prompts caveman-short** — each agent's `.md` already holds the full how-to. The prompt carries only the variable data: task tag, client path, exact ids, exact file paths. Do not restate rules the agent already knows.

## Hard rule — children write full to disk, return thin digests

Every subagent's final reply becomes part of the parent's permanent context and rides along every later parent turn. A child that echoes its full result (all documents, every line item, full JSON) is what balloons the parent's context across dozens of runs. So the whole team follows **write full, return thin**:

- Each child **persists its full result to a file** (watson/marple spreadsheet → `ข้อมูลระบบ/_segments/<segment_id>/interpretation.json` at the `resultPath` the parent names; sherlock → `links.yaml`; poirot → `categorize.json`; marple populate → the group's `interpretation.json`; magnum → `CLIENT.md`) and **replies with a compact digest only** — paths written, counts, flags, questions. Stage 2 children also write their **full Page Disposition to a fragment file** (`ข้อมูลระบบ/_pages/fragments/<segment_id>.yaml`, schema `ksk_disposition_fragment.v1`) — never into the digest; the digest carries only the fragment path and `N used / M excluded` counts, and the parent's `merge-dispositions` script folds the fragments into `dispositions.yaml` (Page Ledger accountability depends on every page appearing in a fragment).
- **The parent passes files (paths), not content.** When a later stage needs an earlier stage's result, the dispatch prompt hands the child the **file path** to read — never a summary the parent composed by reading fat replies. The parent must not read/interpret those result files itself either (that reloads the context this design protects); it only forwards paths.

## Bundled scripts

Deterministic Bun tools live inside this skill at `scripts/` (repo path:
`.claude/skills/ksk-keying/scripts/`). Run from the repo root:

```bash
bun run --cwd .claude/skills/ksk-keying/scripts <command> -- [args]
```

Main workflow commands: `coa-to-csv`, `review-groups`, `inventory`, `ledger`, `merge-dispositions`. Install deps once:
`bash scripts/install.sh` (repo root).

## Input contract

One user-pointed client folder under `samples/realworld/...`, `samples/ข้อมูลครบ/...`, or the production Dropbox workspace (same shape). Treat it as the source of truth.

## Artifact contract

In order:

0. Context files, ensured by `ksk-magnum` at Stage 0:
   - `CLIENT.md` — client profile (identity, tax id, business nature, buyer identity, COA conventions). Consumed downstream by `ksk-watson` (buyer identity), `ksk-poirot` (business nature + COA conventions — a hand-authored stand-in when `coa_usage.json` is absent), and `ksk-marple` review-data (stamps `buyer`/`buyer_tax_id` into `facts`).
   - `coa.csv` — **required** (poirot's only source of account codes). If absent, `ksk-magnum` converts it from the client's `ผังบัญชี` chart-of-accounts workbook via `bun run --cwd .claude/skills/ksk-keying/scripts coa-to-csv`. If no workbook exists either, the run is blocked until the client supplies a chart of accounts.
   - `coa_usage.json` — optional historical hints; `ksk-magnum` records whether it's present, never fabricates it.
1. `ข้อมูลระบบ/_pages/inventory.yaml` (schema `ksk_inventory.v1`) — deterministic file/page census, written once by the parent's `inventory` command immediately before Stage 1. Every client file except the closed skip-list (the generated containers `ข้อมูลระบบ/` and `ตรวจทาน/`, plus `CLIENT.md`, `coa.csv`, `coa_usage.json`, OS junk), with true `pdfinfo` page counts and xlsx sheet names. This is the fixed denominator the Page Ledger validates every later claim against — never agent-reported.
2. `ข้อมูลระบบ/_segments/manifest.yaml` (schema `ksk_segments.v1`)
3. `ข้อมูลระบบ/_segments/SUMMARY.md`
3b. `ข้อมูลระบบ/_segments/<segment_id>/interpretation.json` (and `interpretation-p<start>-<end>.json` for each sub-document page range) — the **full** Stage 2 interpretation each `ksk-watson` / `ksk-marple`-spreadsheet child writes (facts, all line items, page disposition). Children return only a digest; this file is where the detail lives, and it is what Stage 3/4 children are pointed at.
3c. `ข้อมูลระบบ/_pages/fragments/<segment_id>[-p<start>-<end>].yaml` (schema `ksk_disposition_fragment.v1`) — each Stage 2 child's Page Disposition fragment, one per child, every assigned page/sheet `used` or `excluded`-with-reason. Merged into `dispositions.yaml` by the parent's `merge-dispositions` command; never carried in reply digests.
4. `ข้อมูลระบบ/_doc_groups/links.yaml` — same-transaction clusters across segments (when any cross-segment linking applies)
5. `ข้อมูลระบบ/_doc_groups/manifest.yaml` (`layout: category_vat_tree.v1`)
6. `ข้อมูลระบบ/_doc_groups/<category>/<vat_treatment>/<group-id>/...` — human-readable tree:

   ```text
   ข้อมูลระบบ/_doc_groups/
     expense/
       vat/        all line items VAT 7%
       non_vat/    no VAT lines
       mixed/      one document mixing VAT and non-VAT line items
     income/
       vat/
       non_vat/    (rare)
     bank_statement/
   ```

7. `categorize.json` + `review-data.json` inside each group folder (schema: `references/review-data-schema.md`)
8. `ข้อมูลระบบ/_pages/dispositions.yaml` (schema `ksk_dispositions.v1`) — written by the **parent only** (`file`, `page`|`null`, `sheet`|`null`, `disposition` used|excluded, `reason` when excluded, `declared_by`, `note`): Stage 2 fragments folded in via the `merge-dispositions` command, plus policy/human gate decisions the parent records directly. The merge never overwrites `declared_by: human` or `agent_policy` entries. The on-disk Exclusion Declarations the Page Ledger reads — agent-declared exclusions are proposals until a human re-records them.
9. `ข้อมูลระบบ/_pages/ledger.yaml` — derived snapshot regenerated by the `ledger` command at each Ledger Gate (see below); never hand-edited.
10. `ตรวจทาน/<หมวด>/<ภาษี>/ตรวจทาน.html` — the human deliverable tree, all-Thai names (`ค่าใช้จ่าย`/`รายได้`/`รายการเดินบัญชี` × `มีภาษี`/`ไม่มีภาษี`/`คละภาษี`; `รายการเดินบัญชี` has no VAT level), generated by `bun run --cwd .claude/skills/ksk-keying/scripts review-groups` from the `ข้อมูลระบบ/_doc_groups` machinery. Each is a **single self-contained** file (vendored JS inlined — no `assets/` folder) so the reviewer can open just the one HTML; the browser's XLSX export downloads as `นำเข้า PEAK - <หมวด ภาษี>.xlsx`. The reviewer previews the **real source document** inline — the generator points each page at its `source_src` file, rewritten relative to the page's location in the `ตรวจทาน/` tree (PDF rendered via `<iframe ...#page=N>` opened to `source_page`, images inline, xlsx as an inline sheet table — the generator embeds the `source_sheet` rows at build time since `file://` pages can't fetch the workbook), so every `review-data.json` page must carry a valid `source_src`/`source_page`, and spreadsheet pages a valid `source_sheet`.

AI outputs are proposals, not final bookkeeping truth. Human review remains mandatory.

## Team

| Stage | Agent (`subagent_type`) | Unit of work |
|---|---|---|
| First-contact client profile | `ksk-magnum` | one client folder |
| Folder inspection, segment proposal | `ksk-columbo` | one client folder |
| Visual document interpretation | `ksk-watson` | one approved visual segment |
| Cross-segment transaction linking | `ksk-sherlock` | one client's approved segment interpretations |
| COA categorize | `ksk-poirot` | one doc group |
| Spreadsheet/report interpretation, per-group populate | `ksk-marple` | one segment or one group |
| Doc-group skeleton, review-data build (mechanical copy/transform) | `ksk-lestrade` | whole set (skeleton) or one group (review-data) |

Rules:

- One bounded unit per child — one segment, one group, one bucket. Never the whole client.
- Children have no memory — the prompt must carry client path, exact id, exact files, task tag. Nothing else.
- No child spawns subagents.

Which stages fan out in parallel:

| Stage | Parallel? | Unit |
|---|---|---|
| 0 Client profile | no | whole client |
| 1 Segment | no | whole client |
| 2 Interpret | ⚡ **yes** | one per segment — **or one per sub-document / page range** for a multi-document scan |
| 3 Link | no | all interpretations |
| 4a Group skeleton | no | whole set — tree + manifest only |
| 4b Group populate | ⚡ **yes** | one per group |
| 5a Categorize | ⚡ **yes** | one per group |
| 5b Review-data | ⚡ **yes** | one per group |
| 5c Generate HTML | no — parent runs the shell command **once** | whole client |

The Stage 4 split is deliberate: one `ksk-lestrade` builds only the cheap structural skeleton, then the parent fans out one `ksk-marple` per group to deep-populate its `interpretation.json`. Never let a single child transcribe every line item for the whole client in one call — that overloads the child and drops line-item detail (which then defaults COA mapping to suspense).

## Decision policy — decide by rule, don't ask

Mid-run questions kill unattended runs. When a child raises a question or a `needs_confirmation` item, the parent first answers it from this policy + `CLIENT.md`; it asks the human **only** for hard blockers:

- no `coa.csv` **and** no COA workbook anywhere in the client folder (the run cannot map accounts at all)
- a required source file is unreadable or missing, so a Page can never reach a terminal state
- two policy rules give contradicting answers for the same money

Everything else is decided by rule and **logged, not asked**: append each decision to `CLIENT.md` under `## Decisions (auto)` (one line: decision, rule number, evidence), record any resulting exclusion in `ข้อมูลระบบ/_pages/dispositions.yaml` with `declared_by: agent_policy`, and list every auto-decision in the final report so the human can veto it during review. An auto-decision is a proposal with a paper trail — never silently final.

Default rules:

1. **Client identity** — no identity documents yet → take the company name from the folder name (`_<id> <thai company name>`), mark it provisional. Confirm/correct it later from document evidence (Stage 2.5), not by asking.
2. **VAT registration** — starts `vat_registered: unknown`; settled at Stage 2.5 from the client's own income documents. Never guessed at Stage 0.
3. **Example / import artifacts** — files that are PEAK-import examples or outputs (`ไฟล์นำเข้า*`, or a workbook matching the PEAK import template headers) → excluded, reason `reference_example`. They are never a booking source.
4. **Duplicate / overlapping reports** — when several files cover the same money: the most granular per-transaction report (settlement/transfer report with per-order rows) is authoritative; summary/balance reports covering the same period → excluded, reason `superseded_by <seg-id>`; archives (`.zip`/`.rar`) whose contents already exist extracted → excluded, reason `redundant_archive`.
5. **Marketplace double-counting** — platform fees: when proper VAT tax invoices for the fees exist, book fees from those invoices and treat the settlement's fee lines as reference; the settlement books income (and refunds) only. Marketplace-channel sales invoices that also appear in a settlement → book once from the settlement, mark the PDF duplicates `do_not_book`. Channels **not** covered by any settlement (e.g. Lazada/LINE invoices when only a Shopee settlement exists) book from their invoices.
6. **File names lie** — trust document content over file/folder names (a "Non vat" file may be full of 7% tax invoices). Route every document by its own evidence, and flag the mismatch in the segment summary.
7. **Account specificity** — map to the most specific `coa.csv` account the document evidence supports (freight, entertainment, fuel, travel, taxes, training…); generic resale/raw-material codes only for actual goods purchases; never invent codes. When no account fits conservatively → suspense + `needs_review`, not a guess.
8. **Input VAT** — a valid 7% tax invoice with the client as buyer → claim input VAT, unless `CLIENT.md` says the client is not VAT-registered. Documents without a tax invoice stay non-VAT. Legally doubtful claims (e.g. entertainment) → follow the `CLIENT.md` convention when one exists, else book the expense and flag the VAT line `needs_review`.

Rules 3–5 resolve most of what segmentation (`ksk-columbo`) flags; rules 6–8 resolve most of what interpretation surfaces. A question no rule covers that does **not** materially change the books → pick the conservative option, log it, continue. Only a no-rule question that **does** materially change the books is a blocker.

## Stages

Prompts below are the full text to send — short by design. Fill `${...}`. Do not add prose.

### 0. Client profile (first contact)

```
Agent({ description: "Client profile", subagent_type: "ksk-magnum",
  prompt: `First-contact profile for client "${clientPath}". Write CLIENT.md.` })
```

`ksk-magnum` also **guarantees the context files** exist before anything runs: `CLIENT.md`, the required `coa.csv` (converting it from the `ผังบัญชี` workbook when only the xlsx is present), and it records whether the optional `coa_usage.json` exists. If neither a `coa.csv` nor a COA workbook exists, that's a blocking gate — the client must supply a chart of accounts before Stage 1.

🚦 **Parent-owned policy gate.** `ksk-magnum` cannot talk to the user — it returns a `needs_confirmation` list. The parent resolves that list with the **Decision Policy**: identity from the folder name (rule 1), VAT registration left `unknown` for Stage 2.5 (rule 2), COA conventions kept as provisional assumptions for poirot with `needs_review` on low confidence (rule 7). Patch `CLIENT.md` with each resolution and log it under `## Decisions (auto)`. Ask the human **only** for the hard blockers — in practice at this stage: no `coa.csv` and no COA workbook. Unconfirmed business nature is not a blocker: proceed with magnum's best-evidence draft and revisit it at Stage 2.5 when real documents have been read.

### 0.5 Inventory (deterministic, parent-run)

Right before Stage 1, the parent runs the census once — never a subagent, same rule as `review-groups`:

```bash
bun run --cwd .claude/skills/ksk-keying/scripts inventory -- "${clientPath}"
```

Writes `ข้อมูลระบบ/_pages/inventory.yaml`. This is the fixed denominator every later Ledger Gate checks against.

### 1. Segment

```
Agent({ description: "Segment", subagent_type: "ksk-columbo",
  prompt: `Segment client "${clientPath}". Write ข้อมูลระบบ/_segments/manifest.yaml + SUMMARY.md.` })
```

🚦 **Policy gate.** Resolve columbo's flags with the Decision Policy — overlapping/duplicate sources (rule 4), example import files (rule 3), marketplace overlap (rule 5) — log each resolution in `CLIENT.md` `## Decisions (auto)` and record exclusions in `ข้อมูลระบบ/_pages/dispositions.yaml` with `declared_by: agent_policy`. Stop for the user only on hard blockers (a required file missing/unreadable, or a grouping ambiguity no rule covers that materially changes the books).

🚦 **Ledger Gate — segment.** After the human gate above:

```bash
bun run --cwd .claude/skills/ksk-keying/scripts ledger -- --gate segment "${clientPath}"
```

See "Ledger Gates" below for exit codes and how to clear a block.

### 2. Interpret approved segments — ⚡ fan out, one child per unit, all in one message

`ksk-watson` classifies each document (`doc_kind`) and reads it with the matching document-type playbook in `references/extract-playbooks.md` — PEA/PWA/WHT/handwritten/delivery-note/Global-House/bank-statement rules the generic reader would miss. The parent doesn't pick a doc-type; Watson classifies as it reads. No extra dispatch arg needed.

Every Stage 2 child must write a Page Disposition **fragment** (`ข้อมูลระบบ/_pages/fragments/<segment_id>[-p<start>-<end>].yaml`) covering every page/sheet in its assigned range — used or excluded-with-reason. Silence about a page is not permitted; the digest carries only the fragment path and counts.

**Two hard dispatch rules for this stage:**

1. **Never send more than 15 pages of a PDF to one `ksk-watson` call — the 15-page dispatch cap.** A single agent reading dozens of pages loses line-item detail and burns tokens quadratically. For a multi-document scan, fan out over columbo's `sub_ranges` (one child per sub-range). Even for one long single document, split into ≤15-page chunks and merge the children's results downstream. If columbo left no `sub_ranges` on an over-cap `pdf_range` segment, chunk it yourself mechanically into ≤15-page windows.
2. **Name each child a `resultPath` and take back only its digest.** Every Stage 2 child writes its full interpretation to a file under `ข้อมูลระบบ/_segments/<segment_id>/`; the parent hands it the exact path and stores only the returned digest (paths + counts + flags). Never inline the returned digest into a later prompt as content — pass the `resultPath`.

Visual segment (single document or a small segment, ≤15 pages):

```
Agent({ description: "Read visual", subagent_type: "ksk-watson",
  prompt: `Segment ${segmentId}. Client "${clientPath}". Images: ${imagePaths}. Related: ${relatedFiles}. Write full interpretation to ข้อมูลระบบ/_segments/${segmentId}/interpretation.json + Page Disposition fragment to ข้อมูลระบบ/_pages/fragments/${segmentId}.yaml. Reply digest only.` })
```

Multi-document scan or any `pdf_range` over the 15-page cap — do **not** send the whole scan to one child. Fan out **one `ksk-watson` per sub-range** (columbo's `sub_ranges`, each ≤15 pages), all in one message, so each invoice gets a deep read with real line items:

```
Agent({ description: "Read invoice", subagent_type: "ksk-watson",
  prompt: `Sub-document of ${segmentId}. Client "${clientPath}". Source: ${pdfPath} pages ${pageRange} (≤15). Read only these pages. Write full interpretation to ข้อมูลระบบ/_segments/${segmentId}/interpretation-p${pageRange}.json + Page Disposition fragment to ข้อมูลระบบ/_pages/fragments/${segmentId}-p${pageRange}.yaml. Reply digest only; report source_file + source_page in the result file.` })
```

Spreadsheet/report segment:

```
Agent({ description: "Read sheet", subagent_type: "ksk-marple",
  prompt: `spreadsheet interpretation. Segment ${segmentId}. Client "${clientPath}". Files: ${filePaths}. Write full interpretation to ข้อมูลระบบ/_segments/${segmentId}/interpretation.json + Page Disposition fragment (per sheet) to ข้อมูลระบบ/_pages/fragments/${segmentId}.yaml. Reply digest only.` })
```

🚦 **Ledger Gate — interpret.** First fold the children's fragments into `ข้อมูลระบบ/_pages/dispositions.yaml` (parent-run script — children never write ledger files; the merge preserves the parent's policy/human entries), then gate:

```bash
bun run --cwd .claude/skills/ksk-keying/scripts merge-dispositions -- "${clientPath}"
bun run --cwd .claude/skills/ksk-keying/scripts ledger -- --gate interpret "${clientPath}"
```

See "Ledger Gates" below for exit codes and how to clear a block.

### 2.5 Profile update from evidence (parent, cheap — no subagent)

Stage 0 profiled the client from thin context (often just the folder name); Stage 2 has now read the real documents. Before grouping, the parent patches `CLIENT.md` from the interpretation summaries it already holds — no re-reading of documents:

- **VAT registration** (rule 2): find income documents whose **seller** matches the client (the folder-name company). Seller issues 7% tax invoices → `vat_registered: true`; income documents exist but none carry VAT → `vat_registered: false`; no income docs in the folder → leave `unknown` and fall back to expense-side evidence (the client's own tax id appearing as buyer on claimed input-VAT invoices suggests registered). Update `default_buyer.tax_id`/`tax_id` when a document confirmed the 13-digit id.
- **Business nature**: firm up or correct `business_nature` from what the documents actually show (products sold, channels, recurring vendors), raising `business_nature_confidence`.
- **COA conventions**: revise conventions Stage 2 evidence contradicted (e.g. a "non-VAT resale" convention when the file turned out to be operating expenses — rule 6), so poirot maps from reality, not the Stage 0 guess.

Log every change under `## Decisions (auto)`. This step is what lets Stage 0 start from nothing but a folder name without poisoning downstream COA mapping.

### 3. Link transactions

```
Agent({ description: "Link", subagent_type: "ksk-sherlock",
  prompt: `Link segments for client "${clientPath}". Interpretation files: ${interpretationPaths}. Read them; write ข้อมูลระบบ/_doc_groups/links.yaml.` })
```

🚦 Stop when a link is ambiguous or would merge/split on weak evidence. Skip this stage only when every transaction lives fully inside one segment.

A transaction that lists **more than one `bookable_docs` entry** (two tax invoices settled by one payment) is one payment event but **multiple bookings** — carry every `bookable_docs` entry forward as its own bookable unit; never fold them into a single keyed record.

### 4. Build doc groups — skeleton then ⚡ per-group populate

**4a — Skeleton** (one child, structural only — tree + manifest, no line-item transcription):

```
Agent({ description: "Group skeleton", subagent_type: "ksk-lestrade",
  prompt: `doc-group skeleton. Client "${clientPath}". Links: ข้อมูลระบบ/_doc_groups/links.yaml. Interpretation files: ${interpretationPaths}. Write ข้อมูลระบบ/_doc_groups/manifest.yaml + the category/VAT tree + empty group folders. Create ONE group folder per bookable_docs entry, not per transaction — a cluster with two bookable invoices yields two groups that reference the shared receipt as payment evidence; never merge two tax-invoice numbers into one group name. Do not populate interpretation.json.` })
```

**4b — Populate** ⚡ fan out, one `ksk-marple` per group, one message — copies the full facts + every line item for that group into its `interpretation.json`:

```
Agent({ description: "Group populate", subagent_type: "ksk-marple",
  prompt: `doc-group populate. Group "${groupPath}". Client "${clientPath}". Source interpretation: ${segmentInterpretationPath}. Write ${groupPath}/interpretation.json with full line items + source_ref/source_page.` })
```

### 5. Categorize, review-data, generate

**5a — Categorize** ⚡ fan out, one `ksk-poirot` per group, one message:

```
Agent({ description: "Categorize", subagent_type: "ksk-poirot",
  prompt: `Categorize group "${groupPath}". Client "${clientPath}". Write categorize.json.` })
```

**5b — Review-data** ⚡ fan out, one `ksk-marple` per group, one message, after that group is categorized:

```
Agent({ description: "Review-data", subagent_type: "ksk-lestrade",
  prompt: `review-data. Group "${groupPath}". Client "${clientPath}".` })
```

**5c — Generate HTML** — parent runs the deterministic generator **once** after all `review-data.json` exist (not a subagent):

```bash
bun run --cwd .claude/skills/ksk-keying/scripts review-groups -- --force "${clientPath}"
```

Then confirm each non-empty bucket produced its `ตรวจทาน/<หมวด>/[<ภาษี>/]ตรวจทาน.html`.

## Ledger Gates

Three hard, parent-run checkpoints derive the Page Ledger from on-disk evidence and block the run while any Page lacks a Terminal State:

```bash
bun run --cwd .claude/skills/ksk-keying/scripts ledger -- --gate segment|interpret|final "${clientPath}"
```

Exit 0 = pass, continue. Exit 1 = blocked (a Page is Unaccounted, or at `segment` in zero/more-than-one segment). Exit 2 = usage/env error — fix and rerun, not a Page problem.

1. **`segment`**, after Stage 1's human gate.
2. **`interpret`**, after Stage 2 — only after the parent has recorded every child's Page Disposition into `ข้อมูลระบบ/_pages/dispositions.yaml`.
3. **`final`**, inside the Completion check — must exit 0 before the parent may report success.

A blocked gate is resolved only by **new evidence** (re-dispatch a bounded child to cover the gap) or a **new Exclusion Declaration** (a human decision, recorded with `declared_by: human`) — never by editing ledger output.

Agent-declared exclusions (a child's Page Disposition marking something excluded) are proposals only; the human review gate sees them all before any Exclusion Declaration is treated as final. They never block the `final` gate by themselves (exit stays 0 once every Page is terminal) — but the `final` gate output breaks the excluded count out by `declared_by` (human vs agent) and, whenever any agent-declared exclusions exist, prints them as a prominent "AGENT-PROPOSED EXCLUSIONS" section (unit, reason, `declared_by`) — the same breakdown is written to `ข้อมูลระบบ/_pages/ledger.yaml`. The parent must not drop that section on the floor: see the Completion check below.

## Stop rules

The run stops for the human only on the Decision Policy's hard blockers: no COA source at all, a required source file missing/unreadable (a Page that can never reach a terminal state), or a no-rule ambiguity that materially changes the books. Everything else: apply the policy, or take the conservative option (suspense + `needs_review`, exclusion proposal, flagged row) and keep going — the review pages and the decision log are where the human weighs in. Park unresolved output where a human can review it; never let an open question stall the rest of the pipeline.

## Completion check

Before reporting success, confirm required artifacts exist for the stages actually run, each child stayed in its bounded scope, no child owned workflow state, and human review remains the last control point. Run `ledger --gate final "${clientPath}"` — it must exit 0. Never report success while any Page is Unaccounted.

Report: client path, stages completed, artifact paths created, blockers/open review points, exact next human step — normally: open each `ตรวจทาน/<หมวด>/[<ภาษี>/]ตรวจทาน.html` via `file://` in Chrome/Edge, review, and export the `นำเข้า PEAK - <หมวด ภาษี>.xlsx` from each page into that same `ตรวจทาน` folder.

The parent's final report to the human **must list**:

1. **Every auto-decision** made under the Decision Policy (the `## Decisions (auto)` log in `CLIENT.md`) — the human vetoes by correcting `CLIENT.md`/dispositions and re-running the affected stage.
2. **Every agent-declared Exclusion Declaration** from the `final`-gate output (the "AGENT-PROPOSED EXCLUSIONS" section / `agent_declared_exclusions` in `ข้อมูลระบบ/_pages/ledger.yaml`) — never silently accept an agent's exclusion as final. A human confirms one by re-recording that same entry in `ข้อมูลระบบ/_pages/dispositions.yaml` with `declared_by: human`.
3. **The Stage 2.5 profile outcome** — the settled `vat_registered` value and any business-nature/convention corrections, with the evidence.
