---
name: ksk-stage-profile
description: Stage 0 of the ksk-keying workflow — first-contact client profile (CLIENT.md, coa.csv, coa_usage.json record) plus the deterministic inventory census. Invoked by the ksk-keying orchestrator as the first stage of a run; NOT a standalone entry point. Do not trigger from a user request — run ksk-keying instead.
compatibility: Claude Code `Agent` tool with the project custom agent `ksk-magnum` in `.claude/agents/`. Runs the bundled `inventory` Bun script.
---

# ksk-stage-profile — Stage 0 (client profile) + inventory

Establish the client's baseline context before any document work. Ends with the fixed
Page-Ledger denominator on disk. The parent (orchestrator) runs this stage; it dispatches
one agent, resolves the policy gate itself, then runs one script.

Shared rules this stage applies:

- **Decision Policy** → `.claude/skills/ksk-keying/references/decision-policy.md` (rules 1, 2, 7 resolve magnum's `needs_confirmation` list)
- **Orchestration rules** → `.claude/skills/ksk-keying/references/orchestration.md` (delegation, digests-only)

## Input → output

- **in**: raw client folder (one user-pointed folder, treated as source of truth)
- **out**:
  - `CLIENT.md` — client profile (identity, tax id, business nature, buyer identity, COA conventions) + `## Decisions (auto)` log
  - `coa.csv` — **required** (poirot's only source of account codes)
  - a record of whether `coa_usage.json` is present (never fabricated)
  - `ข้อมูลระบบ/_pages/inventory.yaml` (schema `ksk_inventory.v1`)

## 0. Client profile (first contact)

```
Agent({ description: "Client profile", subagent_type: "ksk-magnum",
  prompt: `First-contact profile for client "${clientPath}". Write CLIENT.md.` })
```

`ksk-magnum` also **guarantees the context files** exist before anything runs: `CLIENT.md`,
the required `coa.csv` (converting it from the `ผังบัญชี` workbook when only the xlsx is
present via `bun run --cwd .claude/skills/ksk-keying/scripts coa-to-csv`), and it records
whether the optional `coa_usage.json` exists. If neither a `coa.csv` nor a COA workbook
exists, that's a blocking gate — the client must supply a chart of accounts before Stage 1.

🚦 **Parent-owned policy gate.** `ksk-magnum` cannot talk to the user — it returns a
`needs_confirmation` list. The parent resolves that list with the **Decision Policy**:
identity from the folder name (rule 1), VAT registration left `unknown` for Stage 2.5
(rule 2), COA conventions kept as provisional assumptions for poirot with `needs_review` on
low confidence (rule 7). Patch `CLIENT.md` with each resolution and log it under
`## Decisions (auto)`. Ask the human **only** for the hard blockers — in practice at this
stage: no `coa.csv` and no COA workbook. Unconfirmed business nature is not a blocker:
proceed with magnum's best-evidence draft and revisit it at Stage 2.5 when real documents
have been read.

🚦 **Record magnum's context-file exclusion.** If magnum's digest reports a file-level Page
Disposition (typically the `ผังบัญชี` workbook it converted `coa.csv` from), the parent
records it right away — magnum only reports it in text, it never writes the file itself.
Create `ข้อมูลระบบ/_pages/dispositions.yaml` (schema `ksk_dispositions.v1`, an `entries:`
list) if it doesn't exist yet, and add one file-level entry: `{file, page: null, sheet:
null, disposition: excluded, reason: context_file, declared_by: agent_policy}` — a
file-level entry (no `page`/`sheet`) covers every sheet of the workbook, so one entry is
enough. Skipping this step leaves the workbook's sheets Unaccounted at every later Ledger
Gate (see `references/ledger-gates.md`); `merge-dispositions` at Stage 2 never overwrites an
`agent_policy` entry, so recording it now is safe and permanent.

## 0.5 Inventory (deterministic, parent-run)

Right before Stage 1, the parent runs the census once — never a subagent, same rule as
`review-groups`:

```bash
bun run --cwd .claude/skills/ksk-keying/scripts inventory -- "${clientPath}"
```

Writes `ข้อมูลระบบ/_pages/inventory.yaml` — a deterministic file/page census: every client
file except the closed skip-list (the generated containers `ข้อมูลระบบ/` and `ตรวจทาน/`,
plus `CLIENT.md`, `coa.csv`, `coa_usage.json`, OS junk), with true `pdfinfo` page counts
and xlsx sheet names. This is the fixed denominator every later Ledger Gate checks against —
never agent-reported.

## Hand-off

Stage 1 (`ksk-stage-segment`) consumes `inventory.yaml`, the client folder, and `CLIENT.md`.
