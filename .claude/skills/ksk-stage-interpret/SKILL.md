---
name: ksk-stage-interpret
description: Stage 2 of the ksk-keying workflow — interpret approved segments (⚡ watson/marple wave), validate shape, audit exclusion claims (⚡ lestrade), merge dispositions, pass the interpret Ledger Gate, then patch CLIENT.md from evidence (Stage 2.5). Invoked by the ksk-keying orchestrator after segmentation; NOT a standalone entry point. Do not trigger from a user request — run ksk-keying instead.
compatibility: Claude Code `Agent` + `Workflow` tools with the project custom agents `ksk-watson`, `ksk-marple`, `ksk-lestrade` in `.claude/agents/`. Runs the bundled `validate-interpretation`, `merge-dispositions`, and `ledger` Bun scripts.
---

# ksk-stage-interpret — Stage 2 (interpret) + Stage 2.5 (profile update)

The largest stage: a full interpret wave, a shape gate, an exclusion-claim verify wave, the
disposition merge, the interpret Ledger Gate, and finally a cheap parent-only profile patch
from what the documents just revealed. The parent orchestrates the waves; children write
full results to disk and return thin digests.

Shared rules this stage applies:

- **Orchestration rules** → `.claude/skills/ksk-keying/references/orchestration.md` (wave dispatch, 15-page cap philosophy, write-full-return-thin, batching)
- **Ledger Gates** → `.claude/skills/ksk-keying/references/ledger-gates.md`
- **Decision Policy** → `.claude/skills/ksk-keying/references/decision-policy.md` (rules 2, 6, 8 at Stage 2.5)
- **Schemas** → `.claude/skills/ksk-keying/references/schemas/segment-interpretation.md`, `references/extract-playbooks.md`

## Input → output

- **in**: approved `ข้อมูลระบบ/_segments/manifest.yaml` (segments / `sub_ranges`), `CLIENT.md`
- **out**:
  - `ข้อมูลระบบ/_segments/<segment_id>/interpretation.json` (and `interpretation-p<start>-<end>.json` per sub-range) — schema `ksk_segment_interpretation.v1`
  - `ข้อมูลระบบ/_pages/fragments/<segment_id>[-p<start>-<end>].yaml` — Page Disposition fragment per child (schema `ksk_disposition_fragment.v1`)
  - `ข้อมูลระบบ/_pages/claim-audit/<segment_id>.yaml` — lestrade verdicts (schema `ksk_claim_audit.v1`)
  - `ข้อมูลระบบ/_pages/dispositions.yaml` — merged
  - `CLIENT.md` — frontmatter patched (Stage 2.5)

## 2. Interpret approved segments — ⚡ one wave, one child per unit

Build the full `units` list (every segment / sub-range below) and run it as **one wave
workflow** (see `references/orchestration.md` → "Wave dispatch"). The templates below are
each unit's `prompt`; the parent resumes once, with all digests.

`ksk-watson` classifies each document (`doc_kind`) and reads it with the matching
document-type playbook in `references/extract-playbooks.md` — PEA/PWA/WHT/handwritten/
delivery-note/Global-House/bank-statement rules the generic reader would miss. The parent
doesn't pick a doc-type; Watson classifies as it reads. No extra dispatch arg needed.

Every Stage 2 child must write a Page Disposition **fragment**
(`ข้อมูลระบบ/_pages/fragments/<segment_id>[-p<start>-<end>].yaml`) covering every page/sheet
in its assigned range — used or excluded-with-reason. Silence about a page is not permitted;
the digest carries only the fragment path and counts.

**Two hard dispatch rules for this stage:**

1. **Never send more than 15 pages of a PDF to one `ksk-watson` call — the 15-page dispatch cap.** A single agent reading dozens of pages loses line-item detail and burns tokens quadratically. For a multi-document scan, fan out over columbo's `sub_ranges` (one child per sub-range). Even for one long single document, split into ≤15-page chunks and merge the children's results downstream. If columbo left no `sub_ranges` on an over-cap `pdf_range` segment, chunk it yourself mechanically into ≤15-page windows.
2. **Name each child a `resultPath` and take back only its digest.** Every Stage 2 child writes its full interpretation to a file under `ข้อมูลระบบ/_segments/<segment_id>/`; the parent hands it the exact path and stores only the returned digest (paths + counts + flags). Never inline the returned digest into a later prompt as content — pass the `resultPath`.

Visual segment (single document or a small segment, ≤15 pages):

```
Agent({ description: "Read visual", subagent_type: "ksk-watson",
  prompt: `Segment ${segmentId}. Client "${clientPath}". Images: ${imagePaths}. Related: ${relatedFiles}. Write full interpretation to ข้อมูลระบบ/_segments/${segmentId}/interpretation.json + Page Disposition fragment to ข้อมูลระบบ/_pages/fragments/${segmentId}.yaml. Reply digest only.` })
```

Multi-document scan or any `pdf_range` over the 15-page cap — do **not** send the whole scan
to one child. Add **one `ksk-watson` unit per sub-range** (columbo's `sub_ranges`, each ≤15
pages) to the wave, so each invoice gets a deep read with real line items:

```
Agent({ description: "Read invoice", subagent_type: "ksk-watson",
  prompt: `Sub-document of ${segmentId}. Client "${clientPath}". Source: ${pdfPath} pages ${pageRange} (≤15). Read only these pages. Write full interpretation to ข้อมูลระบบ/_segments/${segmentId}/interpretation-p${pageRange}.json + Page Disposition fragment to ข้อมูลระบบ/_pages/fragments/${segmentId}-p${pageRange}.yaml. Reply digest only; report source_file + source_page in the result file.` })
```

Spreadsheet/report segment:

```
Agent({ description: "Read sheet", subagent_type: "ksk-marple",
  prompt: `spreadsheet interpretation. Segment ${segmentId}. Client "${clientPath}". Files: ${filePaths}. Write full interpretation to ข้อมูลระบบ/_segments/${segmentId}/interpretation.json + Page Disposition fragment (per sheet) to ข้อมูลระบบ/_pages/fragments/${segmentId}.yaml. Reply digest only.` })
```

🚦 **Shape gate — canonical interpretation schema.** Immediately after the wave (before the
Ledger Gate), the parent validates every interpretation file against the canonical
`ksk_segment_interpretation.v1` shape (defined with examples in
`references/schemas/segment-interpretation.md` — the children are told to self-validate, but
the parent verifies):

```bash
bun run --cwd .claude/skills/ksk-keying/scripts validate-interpretation -- "${clientPath}"
```

Exit 1 lists each non-canonical file and its violations. **Re-dispatch the child that owns
each ✗ file** (same unit prompt, plus one line: `Previous attempt failed shape validation:
<violations>. Write the canonical ksk_segment_interpretation.v1 shape.`), then re-run until
exit 0 — never hand-patch the file (parent no-touch rule) and never proceed on a failing
shape gate: the downstream scripts tolerate known variants only as a safety net, and every
tolerated variant prints warnings in prelink/group-skeleton output.

🚦 **Exclusion-claim audit — verify wave (`ksk-lestrade`), before the merge.** Agent-declared
exclusions are claims nobody has re-checked yet; audit them while the fix is still one
re-dispatch away. Collect every `excluded` entry from the wave's fragments
(`grep -l excluded ข้อมูลระบบ/_pages/fragments/*.yaml`) — **no claims → skip this step
entirely.** Otherwise run one wave, one `ksk-lestrade` unit per segment that has claims:

```
Agent({ description: "Audit exclusions", subagent_type: "ksk-lestrade",
  prompt: `Audit exclusion claims. Client "${clientPath}". Segment ${segmentId}. Interpretation: ${interpretationPath}. Claims: ${claimsList (file, page|sheet, reason, and the claimed original page for duplicates)}. Write report to ข้อมูลระบบ/_pages/claim-audit/${segmentId}.yaml. Reply digest only.` })
```

Lestrade verifies claims only (it opens just the referenced pages — never `used` pages) and
never edits anyone's files. For each **refuted** claim: re-dispatch the owning Stage 2 child
**once** (same unit prompt, plus one line naming the refuted claim and lestrade's evidence),
then re-audit only that claim. Still refuted after one round → leave the child's disposition
in place but record the disagreement as a review flag in the run report — a human settles
it; never loop further and never let the parent hand-patch either side.

🚦 **Ledger Gate — interpret.** First fold the children's fragments into
`ข้อมูลระบบ/_pages/dispositions.yaml` (parent-run script — children never write ledger files;
the merge preserves the parent's policy/human entries), then gate:

```bash
bun run --cwd .claude/skills/ksk-keying/scripts merge-dispositions -- "${clientPath}"
bun run --cwd .claude/skills/ksk-keying/scripts ledger -- --gate interpret "${clientPath}"
```

See `references/ledger-gates.md` for exit codes and how to clear a block.

## 2.5 Profile update from evidence (parent, cheap — no subagent)

Stage 0 profiled the client from thin context (often just the folder name); Stage 2 has now
read the real documents. Before grouping, the parent patches `CLIENT.md` from the
interpretation summaries it already holds — no re-reading of documents:

- **VAT registration** (rule 2): find income documents whose **seller** matches the client (the folder-name company). Seller issues 7% tax invoices → `vat_registered: true`; income documents exist but none carry VAT → `vat_registered: false`; no income docs in the folder → leave `unknown` and fall back to expense-side evidence (the client's own tax id appearing as buyer on claimed input-VAT invoices suggests registered). Update `default_buyer.tax_id`/`tax_id` when a document confirmed the 13-digit id.

  **Frontmatter, not prose.** These updates mean editing the fields in `CLIENT.md`'s **YAML frontmatter** — the only part the scripts read (`loadClientProfile` parses the `---` block; `build-review-data` stamps `default_buyer` into every group missing a buyer). Recording a confirmed tax id only in the body text or the Decisions log leaves the machine-read fields `null` and every review page's `buyer_tax_id` empty (postmortem `_356`).
- **Business nature**: firm up or correct `business_nature` from what the documents actually show (products sold, channels, recurring vendors), raising `business_nature_confidence`.
- **COA conventions**: revise conventions Stage 2 evidence contradicted (e.g. a "non-VAT resale" convention when the file turned out to be operating expenses — rule 6), so poirot maps from reality, not the Stage 0 guess.
- **VAT conventions**: when Stage 2 evidence shows a consistent per-source VAT pattern (e.g. every fuel-station slip prints a 7% breakdown with the client as buyer), record it as a `vat_conventions` entry in the frontmatter with its evidence (rule 8) — so re-reads and later runs treat that source class consistently instead of re-judging slip by slip.

Log every change under `## Decisions (auto)`. This step is what lets Stage 0 start from
nothing but a folder name without poisoning downstream COA mapping.

## Hand-off

Stage 3 (`ksk-stage-link`) consumes the interpretation files and merged
`dispositions.yaml`. Report the settled `vat_registered` value and any convention
corrections in the run digest so the orchestrator's final report can surface them.
