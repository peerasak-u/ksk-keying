---
name: ksk-stage-group
description: Stage 4 of the ksk-keying workflow — build the doc-group category/VAT tree (deterministic group-skeleton + group-populate scripts) and populate the judgment groups with a ⚡ ksk-marple wave. Invoked by the ksk-keying orchestrator after linking; NOT a standalone entry point. Do not trigger from a user request — run ksk-keying instead.
compatibility: Claude Code `Agent` + `Workflow` tools with the project custom agent `ksk-marple` in `.claude/agents/`. Runs the bundled `group-skeleton` and `group-populate` Bun scripts.
---

# ksk-stage-group — Stage 4 (build doc groups: skeleton then populate)

Turn linked transactions into the human-readable category/VAT group tree, then fill each
group's line items. Scripts do the 1:1 majority; only groups that need line selection cost a
`ksk-marple` call.

Shared rules this stage applies:

- **Orchestration rules** → `.claude/skills/ksk-keying/references/orchestration.md` (batch ≤20, never one agent per group)
- **Schemas** → `.claude/skills/ksk-keying/references/schemas/group-interpretation.md`

## Input → output

- **in**: `ข้อมูลระบบ/_doc_groups/links.yaml`, interpretation files
- **out**:
  - `ข้อมูลระบบ/_doc_groups/manifest.yaml` (`layout: category_vat_tree.v1`) + the category/VAT tree
  - `<group>/interpretation.json` per group (schema `ksk_group_interpretation.v1`)

The tree layout:

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

## 4a — Skeleton (deterministic, parent-run)

One group folder per `bookable_docs` entry, never per transaction; a cluster with two
bookable invoices yields two groups sharing the receipt as evidence:

```bash
bun run --cwd .claude/skills/ksk-keying/scripts group-skeleton -- "${clientPath}"
```

Writes `ข้อมูลระบบ/_doc_groups/manifest.yaml` + the category/VAT tree, and marks each group
`populate: script` (a pure 1:1 copy of one interpretation file — the majority) or
`populate: agent` (needs judgment, e.g. selecting a subset of lines from a large settlement
sheet). The split is listed in the command output. Cap that output into a file and read back
counts only (see `references/orchestration.md` → "Context hygiene").

### When `group-skeleton` reports dropped bookables (completeness gate)

`group-skeleton` **exits non-zero** with `bookable documents dropped between Stage-2 and
grouping (segment_id / document_no): …` when Stage-3 clustering lost an approved bookable
document — the completeness gate refusing to let a booking vanish silently. **This is the
gate working, not a script failure.** Clear it by re-linking; never hand-edit `links.yaml`,
never grep the script's source, never auto-backfill into a guessed category. The recovery is
a normal delegated loop back to Stage 3:

1. For each flagged `(segment_id, document_no)`, confirm it is a genuine bookable — read that
   interpretation, or re-dispatch one bounded `ksk-watson` over just those pages when the drop
   came from a demote decision (a "duplicate payment voucher" that is really a primary
   supplier invoice must be booked).
2. Re-dispatch **one foreground `ksk-sherlock`** (Stage 3), naming the exact dropped docs, to
   carry each into `links.yaml` — **merged** into its true transaction when evidence supports
   it, otherwise as its **own standalone single-member transaction** (a legitimate outcome).
   A genuine ambiguity (a same-amount invoice that might be a duplicate) is **booked and
   flagged `needs_review`**, never dropped.
3. Re-run `group-skeleton`; repeat until it exits 0.
4. **Termination guard:** if the same bookable is still dropped after a second re-link, carry
   it standalone and flag `needs_review` — never loop, never hand-build the tree.

## 4b — Populate

First the script copies every `populate: script` group's facts + line items from its
primary interpretation (the 1:1 majority):

```bash
bun run --cwd .claude/skills/ksk-keying/scripts group-populate -- "${clientPath}"
```

Then ⚡ run `ksk-marple` over the remaining `populate: agent` groups (the groups needing line
selection from a shared sheet) as **one wave workflow** — **batched, not one per group**:
bucket the groups by their source interpretation file, split each bucket into chunks of ≤20
groups, one wave unit per chunk (never mix source files in one unit — marple refuses
mixed-source batches):

```
Agent({ description: "Group populate ×${n}", subagent_type: "ksk-marple",
  prompt: `doc-group populate, batch. Client "${clientPath}". Source interpretation: ${segmentInterpretationPath}. Groups (${n}): ${groupPathList}. For each group write <groupPath>/interpretation.json (schema ksk_group_interpretation.v1) with that group's line items only + source_file/source_pages per document.` })
```

Never let a single child transcribe every line item for the whole client in one call — that
overloads the child and drops line-item detail (which then defaults COA mapping to
suspense).

## Hand-off

Stage 5 (`ksk-stage-categorize`) consumes each group's `interpretation.json`, `coa.csv`,
`coa_usage.json`, and `CLIENT.md`.
