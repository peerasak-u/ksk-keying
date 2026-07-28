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
- `bun run prepare-realworld -- ...` — flatten a ข้อมูลครบ client into a realworld sample with `client.json` (ported from `ksk-prepare-realworld`); skips the client's finished-PEAK-export folders and names them in the summary
- `export-dir.ts` — no CLI; the shared predicate for "is this a finished PEAK export, not source material" (`isExportDir` / `isExportFile` / `isAnswerKeyPath`). Every client spells the export folder differently and some keep loose `PEAK_Import*.xlsx` workbooks beside their source PDFs, so this must never be re-derived as an exact-name match — see the file's own notes
- `bun run inventory -- ...` — deterministic census of every client file and its true Page count (pdfinfo / sheet enumeration), writes `_pages/inventory.yaml`
- `bun run ledger -- --gate segment|interpret|final ...` — derive the Page Ledger from on-disk evidence, write `_pages/ledger.yaml`, exit 1 while any Page unit is Unaccounted (or in zero/multiple Segments at the segment gate); `--gate final` also blocks (exit 1) unconditionally while `_pages/build-review-data-stale.yaml` exists (see `build-review-data`'s exit 3 below) — a categorize build the pipeline itself disowned must never be read as current
- `bun run merge-dispositions -- ...` — fold Stage-2 children's Page Disposition fragments (`_pages/fragments/*.yaml`) into `_pages/dispositions.yaml`; never overwrites `declared_by: human`/`agent_policy` entries; idempotent
- `bun run validate-interpretation -- ...` — enforce the canonical `ksk_segment_interpretation.v1` shape (defined in `.claude/agents/ksk-watson.md`) on Stage-2 interpretation files (a file or a whole client dir); exit 1 lists non-canonical files whose writing child should be re-dispatched
- `bun run prelink -- ...` — propose transaction clusters from exact matches (shared doc number; amount+date+tax-id triple) into `_doc_groups/links.draft.yaml`; ksk-sherlock judges the residue and owns `links.yaml`
- `bun run group-skeleton -- ...` — build `_doc_groups/manifest.yaml` + the category/VAT tree from `links.yaml` + Stage-2 interpretations; marks each group `populate: script|agent`. Exit codes: 0 clean pass, 1 written but DEGRADED (`links.yaml` predates unit identity — `source_file`/`source_page` absent from every cluster member; the manifest is still written, re-run Stage 3 linking then re-run this script), 2 usage/malformed input (includes a genuine completeness-gate drop — `bookable documents dropped between Stage-2 and grouping …` — see `ksk-stage-group/SKILL.md`).
- `bun run group-populate -- ...` — copy facts + line items from each `populate: script` group's primary interpretation into `<group>/interpretation.json` (`ksk_group_interpretation.v1`); `populate: agent` groups stay with ksk-marple
- `bun run build-review-data -- ...` — rebuilds **every** group with both `interpretation.json` + `categorize.json` present (+ CLIENT.md `default_buyer`) on every run, merging any saved reviewer edits forward from the group's `review-data.ai.json` baseline sidecar; can write `review-data.json`, `review-data.ai.json`, `review-data.superseded.json` (degraded/bailed merges only), and `dropped-edits.json` (any rebuild that dropped an edit); exit 1 lists groups with missing inputs. **Exit 2 (usage/malformed input) vs exit 3 (preflight failed) are NOT interchangeable** — 2 means the arguments/files this script was given were bad; 3 means the input was fine but the pipeline's own prior output is internally inconsistent (a page double-claimed by two groups, or a Stage-2 document with no owning group — see `preflightBuiltGroups` in `groups-lib.ts`). On either 2 or 3, **nothing is written this run**, and this script also writes `_pages/build-review-data-stale.yaml` marking any review-data.json already on disk (from a previous successful run) as no longer trustworthy — `ledger --gate final` refuses to pass while that file exists, no matter who invokes it or in what order. **The correct response to exit 3 is always: fix the inconsistency named on stderr, then re-run this exact command — never continue to `review-groups`/`ledger` while the sentinel is present, and never treat 3 as a transient hiccup to retry blindly.** The sentinel is cleared automatically the next time this script completes a full, clean build.
- `bun run reference-report-check -- <client-dir>` — Completion-check step (Decision Policy rule 9): sums every `reference_report`-excluded file's own rows and checks how much is booked anywhere else in the client's segment/doc-group facts (by tax_id or document number); writes `_pages/reference-report-check.yaml`. Never blocks (exit 0 always) and never edits facts — a flagged file is a mandatory human review point, not a gate failure. Low-confidence extractions (no recognizable amount column) say so instead of printing a guessed total.
- `bun run category-account-check -- <client-dir>` — Completion-check step: for every `expense/` or `income/` doc-group with a `categorize.json`, compares the confirmed account code's leading digit against the category folder (expense expects 5xxxxx, income expects 4xxxxx); writes `_pages/category-account-check.yaml`. Never blocks (exit 0 always) and never edits facts — a 4xxxxx-under-expense or 5xxxxx-under-income flag is HIGH (likely mis-filed), a 1/2/3xxxxx-under-either flag is `review` (may be a legitimate deposit/advance/loan booking, needs a human to confirm the group's category). Groups without a `categorize.json` yet are skipped silently.
- `bun run stage-shape-check -- --stage profile|link|group <client-dir>` — completion probe for the three stages with no Ledger Gate of their own (profile, link, group). Checks contract artifacts exist and have the expected shape (not correctness) — used by the console sequencer (`console/_prototype_sequencer/`) to decide pass/retry without trusting agent prose. Writes no snapshot file. Exit codes: 0 shape complete, 1 shape incomplete (stage still in progress), 2 usage/malformed input.
- `bun run segments-integrity -- stamp <client-dir>` / `bun run segments-integrity -- verify <client-dir>` — Stage-2 immutability check for `ข้อมูลระบบ/_segments/**` (real incident, client 345, month 04-69, 2026-07-28: a later stage hand-edited already-approved Stage-2 interpretation files to clear its own completeness guard instead of reporting the block — see the script's top-of-file comment). `stamp` is called by `ledger.ts` itself, only the instant `--gate interpret` passes — never by a stage skill. `verify` recomputes sha256 of every file under `_segments/` and diffs against that manifest, naming exact changed/missing/added files; wired into the console sequencer's completion check (`console/sequencer/completion-check.ts`) for every stage after `interpret` (link, group, categorize, final). A run with no manifest yet (pre-upgrade) degrades to a stderr warning, never a hard fail. Exit codes: `stamp` — 0 success, 2 usage/environment error; `verify` — 0 pass or no-manifest degrade, 1 tampered, 2 usage error.
- `bun run learn -- --propose <client-dir>` / `bun run learn -- --apply <client-dir> < decision.json` — the deterministic half of the learning loop (ticket #43, closed out by #47). `--propose` walks **every month's** `ข้อมูลระบบ/_doc_groups/**/changes.json` for one client, counts only `field: "account_code"` corrections, and prints a `ksk_learn_report.v1` proposal set on stdout — it writes nothing. It also reads (never writes) `<client-dir>/learning-notes.md` and returns every bullet as `learning_notes: StoredNote[]` (`{id, date, title, detail, handled}`). `--apply` takes the decision a human confirmed in the console (`{accept, sources, notes, handled}`) and writes `coa_usage.json` (additive-only upsert; existing hints keep their label/notes) plus `learning-notes.md` whenever there are new `notes` and/or `handled` ids to apply — new notes are appended first (always unhandled), then the checkbox on every bullet in the file is set from the `handled` id set, in that order, as a single write. Idempotent per CORRECTION, not per file: `coa_usage.json`'s `learned_from` maps each changes.json path (client-root-relative) to the fingerprints of the corrections already consumed from it — a file-level watermark would re-count everything on each re-export, since changes.json is a snapshot recomputed at every export. `--apply` records every correction it considered, including ones whose proposal was rejected, so a deliberate rejection does not resurface. **Console-only — no agent ever invokes this**; `coa_usage.json` stays read-only for every agent.

  **`learning-notes.md`'s bullet format**: `- [ ] **title** — detail` (unhandled) or `- [x] **title** — detail` (handled), the dash before "detail" is an EM DASH (U+2014). A bullet with no checkbox at all (every note written before #47) counts as unhandled — the first rewrite of the file normalizes it to `[ ]`. Notes are never moved, archived, or duplicated into a second file; "handled" only ever flips that one line's checkbox in place. A note's id is derived from `(date, title, detail)` where `date` is the `## <date>` heading above it, so **ksk-magnum must filter to unhandled (`- [ ]`) notes only** when it reads this file — a `[x]` note is done, historical record, not live guidance. Exit codes: 0 success (nothing to learn is not an error), 2 usage/environment error.

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
