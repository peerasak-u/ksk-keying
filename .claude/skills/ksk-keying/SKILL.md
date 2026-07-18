---
name: ksk-keying
description: Orchestrate the KSK client document keying workflow (classify, extract, review, export to PEAK account data) with a parent session and bounded Agent-tool subagents. Use when asked to "run ksk-keying", "key this client", "process this client with subagents", "segment and review this client", "run the new KSK workflow", or move a client from folder inspection to ข้อมูลระบบ/_segments, ข้อมูลระบบ/_doc_groups, and review artifacts.
compatibility: Claude Code `Agent` + `Workflow` tools with project custom agents in `.claude/agents/` (`ksk-magnum`, `ksk-columbo`, `ksk-watson`, `ksk-sherlock`, `ksk-poirot`, `ksk-marple`, `ksk-lestrade`) and the per-stage skills `ksk-stage-*`. No external subagent framework, no vision extension — Claude reads images natively via `Read`. On a Claude Code build without the `Workflow` tool, fall back to background `Agent` waves (see `references/orchestration.md`).
---

# ksk-keying — orchestrator

Run the KSK workflow through a parent-orchestrated subagent team. The parent (this session)
is the only workflow owner — it holds state, decides stage transitions, and applies the
Decision Policy so the run goes end-to-end without stopping.

The workflow is built for **long unattended runs**: reliability comes from the deterministic
Ledger Gates (every page must reach a terminal state), not from asking the human mid-run.
Human review happens once, at the end, on the review pages and the decision log.

This skill is the **sequencer**. Each stage's how-to lives in its own `ksk-stage-*` skill;
the parent invokes them **one at a time** via the `Skill` tool (e.g.
`Skill(ksk-stage-profile)`), in order, so only the current stage's instructions occupy
context. Finish a stage and clear its gate before invoking the next. Those stage skills are
driven by this orchestrator only — they are not standalone entry points, and the parent
still owns all workflow state across them (it invokes the skill, then runs that stage's
waves/scripts/gates itself).

> Legacy note: the pre-repo `ksk-xxx` stage-skill series (documented under `docs/ksk-team`)
> is the old, deprecated pipeline and is unrelated to the `ksk-stage-*` skills this
> orchestrator drives. Do not route work through the legacy path.

## How the parent runs the team — read first

The invariants that keep an unattended run reliable and the parent's context lean are shared
across every stage. Read them once at the start of a run:

- **`references/orchestration.md`** — the parent delegates, never does the work; wave dispatch (one `Workflow` per ⚡ stage); context hygiene; children write full to disk and return thin digests; batch ≤20; script-failure delegation; bounded-child rules.
- **`references/decision-policy.md`** — decide by rule, don't ask (11 default rules + stop rules). The parent resolves child questions and `needs_confirmation` items from here; it stops for the human only on hard blockers.
- **`references/ledger-gates.md`** — the three Ledger Gates (`segment`, `interpret`, `final`), how a blocked gate is cleared, and the `dispositions.yaml` writer rules.

## Input contract

One user-pointed folder under `samples/realworld/...`, `samples/ข้อมูลครบ/...`, or the
production Dropbox workspace (same shape). Treat it as the source of truth.

Two folder levels, two scopes:

- **Client root** (`${clientRoot}`) — the client's folder. Holds the month-invariant
  context files shared by every run: `CLIENT.md`, `coa.csv`, `coa_usage.json` (and often
  the `ผังบัญชี` workbook). Stage 0 reads/writes context here.
- **Month folder** (`${monthPath}`) — one accounting month inside the client root (e.g.
  `04-69`, `เดือนพฤษภาคม`). **This is the run root**: every stage ≥ the inventory census
  operates on exactly one month folder, and both generated trees — `ข้อมูลระบบ/` and
  `ตรวจทาน/` — are created inside it, never at the client root. Scripts resolve the three
  context files by looking at the run root first, then its parent, so a legacy
  everything-at-client-root layout still runs.

Resolving what the user pointed at: if it is a month folder (documents directly inside,
context files in the parent), use it as `${monthPath}` and its parent as `${clientRoot}`.
If it is a client root containing month subfolders, enumerate them — one full run per
month folder, sequentially; log the choice in the decision log. Source files sitting at
the client root outside every month folder (loose statements, workbooks) are **not** part
of any month's census — list them in the final report as an open review point for the
human to file into the right month; never silently absorb or skip them.

## Bundled scripts

Deterministic Bun tools live inside this skill at `scripts/` (repo path:
`.claude/skills/ksk-keying/scripts/`). Run from the repo root:

```bash
bun run --cwd .claude/skills/ksk-keying/scripts <command> -- [args]
```

Main workflow commands: `coa-to-csv`, `inventory`, `ledger`, `merge-dispositions`,
`prelink`, `group-skeleton`, `group-populate`, `build-review-data`, `review-groups`. Install
deps once: `bash scripts/install.sh` (repo root). The stage skills call these; the parent
never becomes the debugger when one fails (see `references/orchestration.md`).

## Team

| Stage | Agent (`subagent_type`) | Unit of work |
|---|---|---|
| First-contact client profile | `ksk-magnum` | one client root |
| Folder inspection, segment proposal | `ksk-columbo` | one month run root |
| Visual document interpretation | `ksk-watson` | one approved visual segment |
| Exclusion-claim audit (Stage 2 verify) | `ksk-lestrade` | one segment's batch of exclusion claims |
| Cross-segment transaction linking | `ksk-sherlock` | one client's approved segment interpretations |
| COA categorize | `ksk-poirot` | one batch of ≤20 doc groups |
| Spreadsheet/report interpretation, populate for `populate: agent` groups | `ksk-marple` | one segment, or one batch of ≤20 populate groups sharing a source interpretation |

The mechanical copy/transform steps (doc-group skeleton, 1:1 group populate, review-data
build, inventory, merge, prelink, HTML generation) are **deterministic scripts** the parent
runs — agents only where reading or judgment is required.

## Stage sequence

Invoke each stage skill via the `Skill` tool (`Skill(ksk-stage-<name>)`), do the stage,
clear its gate, then move on to the next. Gates between stages are the trust anchor — never
skip one to "save a step".

| # | Stage skill | Ends at |
|---|---|---|
| 0 | `ksk-stage-profile` | CLIENT.md + coa.csv + `inventory.yaml`; policy gate (hard blocker: no COA source) |
| 1 | `ksk-stage-segment` | manifest + SUMMARY; policy gate + 🚦 Ledger Gate `segment` |
| 2 | `ksk-stage-interpret` | interpretations + fragments + claim-audit; shape gate + lestrade verify + 🚦 Ledger Gate `interpret`; then Stage 2.5 CLIENT.md patch |
| 3 | `ksk-stage-link` | `links.yaml` (skip only when every transaction lives in one segment) |
| 4 | `ksk-stage-group` | doc-group tree + per-group `interpretation.json` |
| 5 | `ksk-stage-categorize` | `categorize.json` + `review-data.json` + `ตรวจทาน/**.html` |
| ✓ | Completion check (below) | 🚦 Ledger Gate `final` + final report |

Do not route work through any legacy `ksk-xxx` stage-skill series unless the user explicitly
asks for the old pipeline.

## Artifact contract (master index)

Every stage ends by writing files under this contract; downstream stages read them by path.
Schemas for the machine-read files live in `references/schemas/`. All `ข้อมูลระบบ/…` and
`ตรวจทาน/…` paths below are relative to the **month run root** (`${monthPath}`).

0. Context files (`ksk-stage-profile`), at the **client root** (`${clientRoot}`), shared across months: `CLIENT.md`, `coa.csv` (**required** — poirot's only source of account codes; converted from the `ผังบัญชี` workbook if absent), `coa_usage.json` (optional historical hints; presence recorded, never fabricated).
1. `ข้อมูลระบบ/_pages/inventory.yaml` (`ksk_inventory.v1`, `ksk-stage-profile`) — the fixed Page-Ledger denominator, never agent-reported.
2. `ข้อมูลระบบ/_segments/manifest.yaml` (`ksk_segments.v1`) + `SUMMARY.md` (`ksk-stage-segment`).
3. `ข้อมูลระบบ/_segments/<segment_id>/interpretation.json` (+ `interpretation-p<start>-<end>.json` per sub-range) — full Stage 2 interpretation (`ksk_segment_interpretation.v1`; `ksk-stage-interpret`).
   - `ข้อมูลระบบ/_pages/fragments/<segment_id>[-p<start>-<end>].yaml` (`ksk_disposition_fragment.v1`) — each Stage 2 child's Page Disposition fragment.
   - `ข้อมูลระบบ/_pages/claim-audit/<segment_id>.yaml` (`ksk_claim_audit.v1`) — lestrade's per-claim verdicts.
4. `ข้อมูลระบบ/_doc_groups/links.draft.yaml` (`ksk_links_draft.v1`) then `links.yaml` (`ksk-stage-link`).
5. `ข้อมูลระบบ/_doc_groups/manifest.yaml` (`layout: category_vat_tree.v1`) + the category/VAT tree (`ksk-stage-group`).
6. `<group>/interpretation.json` (`ksk_group_interpretation.v1`) + `categorize.json` (poirot) + `review-data.json` (`references/review-data-schema.md`) inside each group folder (`ksk-stage-group`, `ksk-stage-categorize`).
7. `ข้อมูลระบบ/_pages/dispositions.yaml` (`ksk_dispositions.v1`) — parent-only writer; see `references/ledger-gates.md`.
8. `ข้อมูลระบบ/_pages/ledger.yaml` — derived snapshot regenerated by the `ledger` command; never hand-edited.
9. `ตรวจทาน/<หมวด>/[<ภาษี>/]ตรวจทาน.html` — the human deliverable tree (`ksk-stage-categorize`).

AI outputs are proposals, not final bookkeeping truth. Human review remains mandatory.

## Stop rules

The run stops for the human only on the Decision Policy's hard blockers: no COA source at
all, a required source file missing/unreadable (a Page that can never reach a terminal
state), or a no-rule ambiguity that materially changes the books. Everything else: apply the
policy, or take the conservative option (suspense + `needs_review`, exclusion proposal,
flagged row) and keep going. Park unresolved output where a human can review it; never let an
open question stall the rest of the pipeline. Full policy: `references/decision-policy.md`.

## Completion check

Before reporting success, confirm required artifacts exist for the stages actually run, each
child stayed in its bounded scope, no child owned workflow state, and human review remains
the last control point. Run `ledger --gate final "${monthPath}"` — it must exit 0. Never
report success while any Page is Unaccounted.

Then, always (not only when you remember to), run
`reference-report-check -- "${monthPath}"`. This is a required, deterministic script — never
substitute an ad hoc read of the report file yourself, and never skip it because no
`reference_report` exclusions come to mind; the script itself detects whether any exist. It
sums each `reference_report`-excluded file's own rows and checks how much of that total is
booked anywhere else in the client's output, because a report excluded as "not a booking
source" can still be the *only* evidence for some of its rows — silently leaving it excluded
would drop those transactions from the books, not just avoid a double-count. Every `⚠` line it
prints is a review point for the human, per item 4 below.

Also always run `category-account-check -- "${monthPath}"`. This is a required, deterministic
script — never substitute an ad hoc read of categorize.json files yourself, and run it
unconditionally, not only when a category looks suspicious. For every `expense/` or `income/`
doc-group with a `categorize.json`, it compares the confirmed account code's leading digit
against the category folder the group is filed under (expense expects 5xxxxx, income expects
4xxxxx), because nothing else in the pipeline reconciles a group-skeleton's provisional
category against the account its own categorize.json later confirms. A `⚠ HIGH` flag (a
4xxxxx revenue account under expense/, or a 5xxxxx expense account under income/) is very
likely a mis-filed group; a `⚠ review` flag (a 1/2/3xxxxx balance-sheet account under either)
may be legitimate — a fixed-asset purchase, a deposit, an employee advance, a related-party
loan — but still needs a human to confirm the group belongs in that category at all. Every
line it prints is a review point for the human, per item 5 below.

Report: client path, stages completed, artifact paths created, blockers/open review points,
exact next human step — normally: open each `ตรวจทาน/<หมวด>/[<ภาษี>/]ตรวจทาน.html` via
`file://` in Chrome/Edge, review, and export the `นำเข้า PEAK - <หมวด ภาษี>.xlsx` from each
page into that same `ตรวจทาน` folder.

The parent's final report to the human **must list**:

1. **Every auto-decision** made under the Decision Policy (the `## Decisions (auto)` log in `CLIENT.md`) — the human vetoes by correcting `CLIENT.md`/dispositions and re-running the affected stage.
2. **Every agent-declared Exclusion Declaration** from the `final`-gate output (the "AGENT-PROPOSED EXCLUSIONS" section / `agent_declared_exclusions` in `ข้อมูลระบบ/_pages/ledger.yaml`) — never silently accept an agent's exclusion as final. A human confirms one by re-recording that same entry in `ข้อมูลระบบ/_pages/dispositions.yaml` with `declared_by: human`.
3. **The Stage 2.5 profile outcome** — the settled `vat_registered` value and any business-nature/convention corrections, with the evidence.
4. **The reference-report cross-check** (rule 9) — the full `reference-report-check` output, every `⚠` line verbatim. A flagged file is evidence for the human, never an automatic change to facts: the human decides whether the report should become a booking source (and re-runs the affected stage) or the gap is explained some other way.
5. **The category/account cross-check** — the full `category-account-check` output, every `⚠` line verbatim (both `HIGH` and `review`). A flagged group is evidence for the human, never an automatic change to facts: the human decides whether the group's category/VAT folder is wrong (and re-files it) or the account code needs correcting instead.
