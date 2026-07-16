# AGENTS.md

Scope: everything under `.claude/skills/ksk-keying/scripts/`.

## Purpose

Bun/TypeScript prototype for the KSK document pipeline.

Current commands:

- `bun run prepare-pages -- ...` — PDF to PNG only, writes `_pages/.../page-NNN.png` + `manifest.yaml`
- `bun run gate -- ...` — route one page into a doc kind/group
- `bun run extract -- ...` — extract line items from a gated page
- `bun run categorize -- ...` — map extracted line items to client COA accounts, writes `.categorize.json`
- `bun run group-gates -- ...` — build `_gate_groups/<group>/` symlink views with gate/extract/categorize/image files
- `bun run review -- ...` — generate one static `_gate_groups/<group>/review.html` per group for human review
- `bun run pipe -- ...` — run gate then extract
- `bun run coa-to-csv -- ...` — convert client ผังบัญชี .xls/.xlsx to CSV (ported from `ksk-map-to-csv`)
- `bun run prepare-realworld -- ...` — flatten a ข้อมูลครบ client into a realworld sample with `client.json` (ported from `ksk-prepare-realworld`)
- `bun run inventory -- ...` — deterministic census of every client file and its true Page count (pdfinfo / sheet enumeration), writes `_pages/inventory.yaml`
- `bun run ledger -- --gate segment|interpret|final ...` — derive the Page Ledger from on-disk evidence, write `_pages/ledger.yaml`, exit 1 while any Page unit is Unaccounted (or in zero/multiple Segments at the segment gate)
- `bun run merge-dispositions -- ...` — fold Stage-2 children's Page Disposition fragments (`_pages/fragments/*.yaml`) into `_pages/dispositions.yaml`; never overwrites `declared_by: human`/`agent_policy` entries; idempotent
- `bun run validate-interpretation -- ...` — enforce the canonical `ksk_segment_interpretation.v1` shape (defined in `.claude/agents/ksk-watson.md`) on Stage-2 interpretation files (a file or a whole client dir); exit 1 lists non-canonical files whose writing child should be re-dispatched
- `bun run prelink -- ...` — propose transaction clusters from exact matches (shared doc number; amount+date+tax-id triple) into `_doc_groups/links.draft.yaml`; ksk-sherlock judges the residue and owns `links.yaml`
- `bun run group-skeleton -- ...` — build `_doc_groups/manifest.yaml` + the category/VAT tree from `links.yaml` + Stage-2 interpretations; marks each group `populate: script|agent`
- `bun run group-populate -- ...` — copy facts + line items from each `populate: script` group's primary interpretation into `<group>/interpretation.json` (`ksk_group_interpretation.v1`); `populate: agent` groups stay with ksk-marple
- `bun run build-review-data -- ...` — merge each group's `interpretation.json` + `categorize.json` (+ CLIENT.md `default_buyer`) into `review-data.json`; exit 1 lists groups with missing inputs
- `bun run reference-report-check -- <client-dir>` — Completion-check step (Decision Policy rule 9): sums every `reference_report`-excluded file's own rows and checks how much is booked anywhere else in the client's segment/doc-group facts (by tax_id or document number); writes `_pages/reference-report-check.yaml`. Never blocks (exit 0 always) and never edits facts — a flagged file is a mandatory human review point, not a gate failure. Low-confidence extractions (no recognizable amount column) say so instead of printing a guessed total.
- `bun run category-account-check -- <client-dir>` — Completion-check step: for every `expense/` or `income/` doc-group with a `categorize.json`, compares the confirmed account code's leading digit against the category folder (expense expects 5xxxxx, income expects 4xxxxx); writes `_pages/category-account-check.yaml`. Never blocks (exit 0 always) and never edits facts — a 4xxxxx-under-expense or 5xxxxx-under-income flag is HIGH (likely mis-filed), a 1/2/3xxxxx-under-either flag is `review` (may be a legitimate deposit/advance/loan booking, needs a human to confirm the group's category). Groups without a `categorize.json` yet are skipped silently.

Tests live in `tests/*.test.ts` (bun built-in runner): `bun test`.

## Ground rules

- Keep this tool in **Bun + TypeScript**.
- Prefer small scripts over framework setup.
- Match existing style: tabs, simple helper functions, minimal abstractions.
- Use prompt changes only when the behavior should generalize across clients.
- Do not hardcode sample-specific answers, vendor names, invoice numbers, or expected outputs.
## Domain constraints

- Extract by visible content, not filename.
- Human review still matters; model output is a proposal, not accounting truth.
- `review.ts` consumes `.extract.json` + `.categorize.json`; `.classify.json` is deprecated for this path.
- Review HTML is scoped by `_gate_groups/<group>/` so reviewers can inspect one accounting bucket at a time.
- Unsupported / low-confidence cases should stay conservative.
- For handwritten bills, avoid guessing unclear item descriptions and ignore free-write notes outside fixed item slots.

## Structured output expectations

- `gate.ts` should stay strict and deterministic.
- `extract.ts` should move toward equally strict structured output.
- Prefer schema enforcement over fragile post-processing.
- Normalize numbers only after preserving visible document facts.
- `review.ts` should block on missing `.categorize.json` and tell the user to run `categorize` then refresh `group-gates`.

## Prepare scope

`prepare.ts` handles:

- **PDF → PNG** pages (all pages rendered as images via `pdftoppm`)
- **Ready file copy** — spreadsheets (.xls, .xlsx, .csv) and images (.jpg, .jpeg, .png, .webp, .gif) are copied into `_pages/` with manifest
- Skips `ผังบัญชี` paths and `_pages/` itself

Not yet supported: PDF text routing (pdftotext → .md), mixed text/image pages, table extraction.

## Known follow-up items

- Fix `--out-dir` / `--gate-dir` path safety for inputs outside the repo root.
- Fix `pipe --dry-run --out-dir` so extract does not try to read gate files that were never written.
- Add strict schema validation for extract output.
- Add deterministic tests for `prepare.ts`.
- Design reviewed output persistence for `review.ts`; current XLSX export button is a placeholder.

## Useful commands

```bash
bunx tsc --noEmit --project .claude/skills/ksk-keying/scripts/tsconfig.json
bun run --cwd .claude/skills/ksk-keying/scripts prepare-pages -- --dry-run --json samples/pilot/_362 บจก.คลินิกคัล เทคโนโลยี
bun run --cwd .claude/skills/ksk-keying/scripts gate -- --dry-run --max-images 1 samples/pilot/_362 บจก.คลินิกคัล เทคโนโลยี/_pages
bun run --cwd .claude/skills/ksk-keying/scripts extract -- --dry-run --max-images 1 samples/pilot/_362 บจก.คลินิกคัล เทคโนโลยี/_pages
bun run --cwd .claude/skills/ksk-keying/scripts categorize -- "samples/realworld/_345 หจก.ประเสริฐเมืองเลย(คุณลัก)/_pages"
bun run --cwd .claude/skills/ksk-keying/scripts group-gates -- --force "samples/realworld/_345 หจก.ประเสริฐเมืองเลย(คุณลัก)/_pages"
bun run --cwd .claude/skills/ksk-keying/scripts review -- --force "samples/realworld/_345 หจก.ประเสริฐเมืองเลย(คุณลัก)"
```

## Reference implementations

- Python prepare reference: `.agents/skills/ksk-prepare-docs/scripts/ksk_prepare_docs.py`
- Python review UI reference: `.agents/skills/ksk-review/scripts/ksk_review.py`
- Prepare tests reference: `tests/test_ksk_prepare_docs.py`

## Editing guidance

- Prefer surgical edits.
- Keep each change batch small.
- Re-run typecheck after touching `.ts` or `types.d.ts`.
- If you change prompts, state the behavioral rule clearly and keep it reusable.
