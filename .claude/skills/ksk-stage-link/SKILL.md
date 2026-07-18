---
name: ksk-stage-link
description: Stage 3 of the ksk-keying workflow — link approved segment interpretations into same-transaction clusters (deterministic prelink script, then one ksk-sherlock over the residue). Invoked by the ksk-keying orchestrator after interpretation; NOT a standalone entry point. Do not trigger from a user request — run ksk-keying instead.
compatibility: Claude Code `Agent` tool with the project custom agent `ksk-sherlock` in `.claude/agents/`. Runs the bundled `prelink` Bun script.
---

# ksk-stage-link — Stage 3 (link transactions)

Cluster interpretations that belong to the same transaction. A deterministic pre-link pass
resolves the exact matches; one foreground sherlock judges only the residue and owns the
final `links.yaml`.

Shared rules this stage applies:

- **Orchestration rules** → `.claude/skills/ksk-keying/references/orchestration.md`
- **Decision Policy** → `.claude/skills/ksk-keying/references/decision-policy.md`

## Input → output

- **in**: `ข้อมูลระบบ/_segments/<segment_id>/interpretation.json` files, `ข้อมูลระบบ/_pages/dispositions.yaml`
- **out**:
  - `ข้อมูลระบบ/_doc_groups/links.draft.yaml` (schema `ksk_links_draft.v1`) — parent-run prelink proposal
  - `ข้อมูลระบบ/_doc_groups/links.yaml` — final same-transaction clusters, owned by sherlock

## 3. Link transactions — pre-link script, then one sherlock

First the parent runs the deterministic pre-link pass (exact matches only — shared document
numbers, identical amount+date+counterparty tax id):

```bash
bun run --cwd .claude/skills/ksk-keying/scripts prelink -- "${monthPath}"
```

It writes `ข้อมูลระบบ/_doc_groups/links.draft.yaml` (proposed clusters + a residue list) at
**document granularity** — a multi-document interpretation file contributes one fingerprint
per bundled document, so most bundled documents resolve deterministically here (client
`_216`: 97 of 115 documents proposed, 18 residue — the earlier file-level draft left whole
10-invoice files as residue and sherlock re-read all 23 interpretation files for ~20
minutes). Then dispatch **one foreground sherlock**, which adopts/overrides the proposals,
judges **only the residue** (reading only the residue entries' interpretation files, plus
spot-checks), and owns the final `links.yaml`:

```
Agent({ description: "Link", subagent_type: "ksk-sherlock",
  prompt: `Link segments for run root "${monthPath}". Draft: ข้อมูลระบบ/_doc_groups/links.draft.yaml. Interpretation files: ${interpretationPaths}. Write ข้อมูลระบบ/_doc_groups/links.yaml.` })
```

🚦 Stop when a link is ambiguous or would merge/split on weak evidence. Skip this stage only
when every transaction lives fully inside one segment.

A transaction that lists **more than one `bookable_docs` entry** (two tax invoices settled
by one payment) is one payment event but **multiple bookings** — carry every `bookable_docs`
entry forward as its own bookable unit; never fold them into a single keyed record.

## Hand-off

Stage 4 (`ksk-stage-group`) consumes `links.yaml` and the interpretation files.
