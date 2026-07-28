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
- **Decision Policy** → `.claude/skills/ksk-keying/references/decision-policy.md` (an unreadable interpretation file surfacing only at grouping time is still a stop-rule condition)
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
bun run --cwd .claude/skills/ksk-keying/scripts group-skeleton -- "${monthPath}"
```

Writes `ข้อมูลระบบ/_doc_groups/manifest.yaml` + the category/VAT tree, and marks each group
`populate: script` (a pure 1:1 copy of one interpretation file — the majority) or
`populate: agent` (needs judgment, e.g. selecting a subset of lines from a large settlement
sheet). The split is listed in the command output. Cap that output into a file and read back
counts only (see `references/orchestration.md` → "Context hygiene").

**Exit codes: 0 clean pass, 1 written but DEGRADED, 2 usage/malformed input.** Exit 1 fires
when `links.yaml` predates unit identity (`source_file`/`source_page` on cluster members) —
a client-month whose linking stage ran before this field existed. `manifest.yaml` is still
written normally; the run just could not fully confirm every unnumbered document is
accounted for, so it degrades to a loud `⚠ DEGRADED` line + a `warning: links.yaml predates
unit identity …` line instead of the hard-fail below. **The fix is mechanical, not a
judgment call**: re-run Stage 3 linking (`ksk-sherlock`/`prelink`) over this client-month to
regenerate `links.yaml` with unit identity, then re-run `group-skeleton`. Never hand-edit
`links.yaml` or `ข้อมูลระบบ/_segments/**` to clear this.

### When `group-skeleton` reports dropped bookables (completeness gate — exit 2)

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

**Never clear this gate by editing Stage 2's output.** A blocked stage reports the block; it
does not rewrite an earlier stage's evidence to make a guard fall silent. Concretely: never
edit a segment's `interpretation.json` (e.g. flipping `usable_for_booking` to `false`) to make
a dropped bookable stop being reported. That interpretation is the evidence a human reviewer
and every later stage rely on being what the document actually shows — editing it to satisfy
this stage doesn't make the document unbookable, it just hides a real document behind a gate
that now lies about why it passed. If the gate is wrong (the document genuinely isn't a
bookable), the fix is a real re-interpretation via `ksk-watson`/`ksk-lestrade`, not a hand edit.
See `decision-policy.md`'s "Evidence immutability" section — this is the incident that rule
documents. **This is no longer just policy: `ข้อมูลระบบ/_segments/**` is content-hash-checked**
(`segments-integrity.ts`, wired into the console sequencer's completion check for every stage
after `interpret`) — an edit like the one above now fails the very next completion check
loudly, naming the changed file, instead of silently letting the guard pass.

## 4b — Populate

First the script copies every `populate: script` group's facts + line items from its
primary interpretation (the 1:1 majority):

```bash
bun run --cwd .claude/skills/ksk-keying/scripts group-populate -- "${monthPath}"
```

Then ⚡ run `ksk-marple` over the remaining `populate: agent` groups (the groups needing line
selection from a shared sheet) as **one wave workflow** — **batched, not one per group**.
Split into two kinds of batch, never mixed in one unit:

**Every group's evidence documents must claim their own pages.** A group's `documents[]` must
include every document it cites as evidence, not only the document its line items came from —
a shared payment slip or WHT certificate marked `lines_owner: false` with its full
`source_pages`. A page that belongs only to evidence and is never claimed by any group never
reaches a terminal state in the final page ledger. When dispatching marple, name each group's
evidence documents (source_file + full page span) from the linked transaction's evidence
alongside its bookable doc — do not leave marple to infer which supporting pages belong to a
group from the source interpretation alone.

- **Resolved groups** (`primary_interpretation` is set): bucket by that single source
  interpretation file, split each bucket into chunks of ≤20 groups, one wave unit per chunk
  (never mix source files in one unit — marple refuses mixed-source batches). **Always name
  each group's expected `bookable_doc`/`document_no` next to its path** — never leave marple
  to infer which document belongs to which group from page or label order alone (a
  page-ordered or label-ordered batch does not always match the physical page order — the
  real regression: a 4-group batch each shifted onto the *previous* group's document, with
  the last document dropped entirely):

```
Agent({ description: "Group populate ×${n}", subagent_type: "ksk-marple",
  prompt: `doc-group populate, batch. Run root "${monthPath}". Source interpretation: ${segmentInterpretationPath}. Groups (${n}), each with its expected document_no and evidence documents — verify what you write against this before finishing: ${groupPathList.map(g => `${g.path} → document_no ${g.bookableDoc}, evidence: ${g.evidenceDocsSummary}`).join("; ")}. For each group write <groupPath>/interpretation.json (schema ksk_group_interpretation.v1) with that group's line items only + a documents[] entry for every document listed, including evidence documents with lines_owner: false and their full source_pages. Re-open each file you write and confirm its document_no matches the expectation above, and every named evidence document's pages are present, before replying; report any mismatch instead of guessing.` })
```

- **Ambiguous groups** (`primary_interpretation: null`, a `document_no matches N
  interpretation files with conflicting facts` warning — see group-skeleton's collision
  handling in `groups-lib.ts`): one wave unit per group (never batched with others, resolved
  or ambiguous), naming **every** candidate file from `evidence_interpretations` plus the
  group's own `bookable_doc`/transaction context (linked counterparty/amount from
  `links.yaml` if available), and requiring marple to open every candidate and pick by
  content — never by file order:

```
Agent({ description: "Group populate (ambiguous)", subagent_type: "ksk-marple",
  prompt: `doc-group populate, ambiguous document_no. Run root "${monthPath}". Group ${groupPath}, expected document_no ${bookableDoc}. Candidate interpretation files (document_no "${bookableDoc}" appears in more than one, with conflicting facts — pick the one that actually matches this group by content, not file order): ${candidatePaths.join(", ")}. Transaction context: ${transactionContextIfAny}. Write <groupPath>/interpretation.json from whichever candidate's content (seller/amount/date/description) matches; if none clearly matches, write needs_review: true and name the ambiguity instead of guessing.` })
```

Never let a single child transcribe every line item for the whole client in one call — that
overloads the child and drops line-item detail (which then defaults COA mapping to
suspense).

## Hand-off

Stage 5 (`ksk-stage-categorize`) consumes each group's `interpretation.json`, `coa.csv`,
`coa_usage.json`, and `CLIENT.md`.
