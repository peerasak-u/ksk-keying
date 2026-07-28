---
name: ksk-stage-interpret
description: Stage 2 of ksk-keying — deterministic plan/prepare/execute/validate/audit/merge of bounded interpretation units. Invoked only by the ksk-keying orchestrator; the Stage 2.5 profile update is explicitly deferred.
compatibility: The console Stage-2 executor invokes direct `ksk-watson`, `ksk-marple`, and `ksk-lestrade` leaf processes. Bundled scripts validate interpretations, merge dispositions, and gate the Page Ledger; agents never orchestrate those steps.
---

# ksk-stage-interpret — Stage 2 (interpret) + Stage 2.5 (profile update)

Stage 2 is a deterministic queue, not a Claude parent that discovers work and
spawns a wave. The executor owns every process, input path, timeout, retry,
validator, and merge. A leaf only reads one prepared packet and writes its
declared artifact(s).

## Input → output

- **in**: approved `ข้อมูลระบบ/_segments/manifest.yaml`, the Page Inventory,
  and optional `CLIENT.md`
- **out**: canonical segment interpretations, Page Disposition fragments,
  claim-audit reports, merged `ข้อมูลระบบ/_pages/dispositions.yaml`, and the
  interpret Ledger Gate result. Stage 2.5 `CLIENT.md` evidence updates remain
  outside this executor.

## Deterministic executor contract

The executor has four phases. No agent substitutes for any of them.

1. **Plan.** Read the segment manifest and Inventory, expand `sub_ranges`, and
   mechanically split any PDF range into windows of at most 15 pages. Assign
   stable unit ids, source-file identifiers, result paths, and fragment paths.
   Reject source or output paths that escape the supplied run root. Resume only
   units whose declared artifact passes the canonical validator.
2. **Prepare.** Materialize the exact evidence paths a unit may read and
   pre-create its output directories. PDFs are rendered deterministically before
   the leaf starts, with a 300-DPI image for every assigned page; spreadsheet
   units receive deterministic prepared sheet data. The executor, not a leaf,
   resolves and reads reference/schema/playbook paths under the supplied repo
   root.
3. **Execute and validate.** Spawn one direct leaf process per bounded unit
   through the process supervisor. Pass a literal packet, enforce the leaf
   Read/Write allowlist, validate its output immediately, and retry only that
   failed unit up to the executor's fixed limit. On cancellation, timeout,
   usage limit, or supervisor failure, stop scheduling units and terminate all
   active process groups. A leaf never invokes a validator or creates children.
4. **Audit, merge, gate.** Parse fragments deterministically to make explicit
   lestrade audit packets for proposed exclusions; validate audit reports;
   re-dispatch a refuted owning unit at most once; then run
   `merge-dispositions` and `ledger --gate interpret`. The executor owns these
   scripts and never asks a leaf to run `grep`, merge, or edit a ledger.

## Direct-leaf packet

Every process receives a complete packet with literal paths. `repoRoot` is the
process startup working directory (`$PWD`) and is supplied directly; it is
never derived from `runRoot`. `source_file` is already the exact
run-root-relative Inventory/manifest identifier and must be copied verbatim.

```text
unitId, agentType, repoRoot, runRoot
source_file, assignedPages|assignedSheets
preparedEvidencePaths[]
schemaPath, playbookPath, clientProfilePath? (when required)
resultPath, fragmentPath? | auditResultPath
```

For group-populate packets, replace `source_file`/fragment fields with literal
manifest-entry, source-interpretation, candidate, and group-output paths.
For claim audits, include only claim metadata and the exact prepared images
needed for each claim. The packet never gives a directory to inspect or a
relative reference path to resolve.

Leaf prompts must say only what a leaf needs to judge the unit: its literal
packet, schema/playbook semantics, artifact contract, and thin digest format.
They must not instruct a leaf to find a repository, validate/retry output,
dispatch agents, merge fragments, alter a ledger, update `CLIENT.md`, or run
commands. A missing packet input is a `blocked: <literal path>` leaf result,
not permission to search.

## Interactive fallback

The normal path is the deterministic executor. If it is unavailable during an
interactive recovery, a parent may submit **one already-prepared complete
packet** to one leaf and then invoke the same deterministic validation/merge
scripts itself. It must retain the 15-page cap, literal path rules, bounded
single retry, and no-agent-orchestration rule. If prepared evidence or a
literal reference path is missing, stop as blocked; do not run filesystem
searches or manufacture a broader prompt.

## Stage 2.5 — profile update (deferred)

This safety-focused executor does **not** patch `CLIENT.md` or claim a settled
VAT/profile result. Existing profile-update behavior remains a separate,
explicit orchestration concern after the interpret Ledger Gate. Any future
implementation must derive updates only from settled interpretations and log
them under `## Decisions (auto)`; it must not reopen arbitrary source files.

## Hand-off

Stage 3 consumes validated interpretations and merged dispositions. Report the
executor's settled unit counts and any audit disagreement that blocked the
stage; do not report a profile/VAT update this executor did not make.

## Evidence immutability

Once `ledger --gate interpret` passes, `ข้อมูลระบบ/_segments/**` is frozen: `ledger.ts`
stamps a content-hash manifest over it at that instant, and every later stage's completion
check (`segments-integrity.ts verify`) fails loudly, naming the exact changed file(s), if
anything under `_segments/` differs from that stamp. No stage downstream of interpret —
link, group, categorize, final — may ever write here; see `decision-policy.md`'s "Evidence
immutability" section for the incident this exists to prevent. The only legitimate way to
change a settled interpretation is a genuine re-dispatch of Stage 2 for the affected unit
through this executor's own Audit/merge/gate phase, which always ends by calling `ledger
--gate interpret` again — passing re-stamps the manifest automatically, so a real
re-dispatch never trips the check.
