---
name: ksk-stage-segment
description: Stage 1 of the ksk-keying workflow — segment the month run root into document/transaction units (manifest.yaml + SUMMARY.md), resolve the policy gate, pass the segment Ledger Gate. Invoked by the ksk-keying orchestrator after Stage 0; NOT a standalone entry point. Do not trigger from a user request — run ksk-keying instead.
compatibility: Claude Code `Agent` tool with the project custom agent `ksk-columbo` in `.claude/agents/`. Runs the bundled `ledger` Bun script.
---

# ksk-stage-segment — Stage 1 (segment)

Propose document/transaction segment boundaries over the month run root, resolve columbo's
flags by policy, and prove every page lands in exactly one segment. One foreground agent,
then the policy gate and the segment Ledger Gate.

Shared rules this stage applies:

- **Decision Policy** → `.claude/skills/ksk-keying/references/decision-policy.md` (rules 3, 4, 5, 9 resolve columbo's flags)
- **Ledger Gates** → `.claude/skills/ksk-keying/references/ledger-gates.md`
- **Orchestration rules** → `.claude/skills/ksk-keying/references/orchestration.md`

## Input → output

- **in**: `ข้อมูลระบบ/_pages/inventory.yaml`, the month run root `${monthPath}`, `CLIENT.md` (at the client root)
- **out**:
  - `ข้อมูลระบบ/_segments/manifest.yaml` (schema `ksk_segments.v1`)
  - `ข้อมูลระบบ/_segments/SUMMARY.md`
  - policy exclusions recorded in `ข้อมูลระบบ/_pages/dispositions.yaml` (`declared_by: agent_policy`)

## 1. Segment

```
Agent({ description: "Segment", subagent_type: "ksk-columbo",
  prompt: `Segment month folder "${monthPath}". Write ข้อมูลระบบ/_segments/manifest.yaml + SUMMARY.md.` })
```

🚦 **Policy gate.** Resolve columbo's flags with the Decision Policy — overlapping/duplicate
sources (rule 4), example import files (rule 3), marketplace overlap (rule 5), derived
report listings (rule 9 — exclude every page as `reference_report`; the segment gets no
interpretation unit in Stage 2 and never reaches sherlock) — log each resolution in
`CLIENT.md` `## Decisions (auto)` and record exclusions in
`ข้อมูลระบบ/_pages/dispositions.yaml` with `declared_by: agent_policy`. Stop for the user
only on hard blockers (a required file missing/unreadable, or a grouping ambiguity no rule
covers that materially changes the books).

🚦 **Ledger Gate — segment.** After the human gate above:

```bash
bun run --cwd .claude/skills/ksk-keying/scripts ledger -- --gate segment "${monthPath}"
```

Exit 0 = pass, continue. Exit 1 = blocked (a Page is Unaccounted, or in zero/more-than-one
segment). See `references/ledger-gates.md` for how to clear a block (new evidence or a human
Exclusion Declaration — never by editing ledger output).

## Hand-off

Stage 2 (`ksk-stage-interpret`) consumes the approved `manifest.yaml` (its segments and any
`sub_ranges`) and `CLIENT.md`.
