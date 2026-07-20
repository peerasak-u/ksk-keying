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
  - `ข้อมูลระบบ/_pages/cross-segment-duplicate-candidates.yaml` (schema
    `ksk_cross_segment_duplicate_candidates.v1`) — parent-run candidate detector output, for
    ksk-lestrade to audit (see 3a)
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
minutes).

### 3a. Cross-segment duplicate candidates — flag for human review before sherlock

Watson/marple only ever see their own ≤15-page dispatch window, so the same physical
document scanned into **two different segments** is invisible to both — neither writes a
`page_disposition: excluded` for it, so it never appears in ที่ถูกตัดออก.html for a human to
check. (This is distinct from `prelink`'s own same-document_no residue detection above,
which exists to resolve a *booking* question — sherlock already puts both segments in one
cluster with a single `bookable_docs` entry when it recognizes the shared number, so no
double-booking results even without this step. What's missing is purely the *audit trail*:
nothing ever records that the non-owning segment's page was a re-scan.)

Run the deterministic candidate detector right after `prelink`:

```bash
bun run --cwd .claude/skills/ksk-keying/scripts cross-segment-duplicates -- "${monthPath}"
```

It writes `ข้อมูลระบบ/_pages/cross-segment-duplicate-candidates.yaml`: same `document_no` in
2+ different segments, corroborated by a second signal (date, amount, or tax id) — a bare
number collision alone is never enough (handwritten receipt books reuse small numbers across
unrelated documents). When it reports candidates, dispatch **ksk-lestrade** over them exactly
like a Stage-2 `duplicate` claim batch: for each candidate, treat the member from the
earliest segment id as the kept original and each other member as the excluded claim (both
`file`/`page` already resolved in the candidate's `members[]` — lestrade doesn't need to
locate anything, just open and compare).

For every **confirmed** verdict, write a disposition fragment the same way Stage 2 does
(`{file, page|sheet, disposition: excluded, reason: duplicate, duplicate_of: "<kept>#p<N>"}`),
then re-run `merge-dispositions` and `ledger -- --gate interpret` (idempotent — this only
refreshes the Ledger's bookkeeping, it does not gate anything Stage 4 reads) and regenerate
ที่ถูกตัดออก.html so the reviewer sees it. Also pass confirmed candidates to sherlock below as
extra context ("segments X and Y are a lestrade-confirmed duplicate of document_no Z — one
bookable document, not two") so it doesn't need to re-derive that from the residue on its
own. Refuted candidates are dropped — log and move on, no disposition change.

### 3b. One foreground sherlock over the residue

Dispatch **one foreground sherlock**, which adopts/overrides the proposals, judges **only
the residue** (reading only the residue entries' interpretation files, plus spot-checks), and
owns the final `links.yaml`:

```
Agent({ description: "Link", subagent_type: "ksk-sherlock",
  prompt: `Link segments for run root "${monthPath}". Draft: ข้อมูลระบบ/_doc_groups/links.draft.yaml. Interpretation files: ${interpretationPaths}. Confirmed cross-segment duplicates (treat as one bookable document): ${confirmedDuplicateSummary}. Write ข้อมูลระบบ/_doc_groups/links.yaml.` })
```

🚦 Stop when a link is ambiguous or would merge/split on weak evidence. Skip this stage only
when every transaction lives fully inside one segment.

A transaction that lists **more than one `bookable_docs` entry** (two tax invoices settled
by one payment) is one payment event but **multiple bookings** — carry every `bookable_docs`
entry forward as its own bookable unit; never fold them into a single keyed record.

## Hand-off

Stage 4 (`ksk-stage-group`) consumes `links.yaml` and the interpretation files.
