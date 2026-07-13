# Orchestration rules — how the parent runs the team

Shared reference for the ksk-keying workflow. These are the invariants that keep an
**unattended run** reliable and keep the parent's context from ballooning. The
orchestrator and every fan-out stage skill (`ksk-stage-interpret`, `ksk-stage-group`,
`ksk-stage-categorize`) follow them. They describe *how* the parent dispatches, never
*what* a child is asked (that lives in each stage skill's prompt templates).

## Hard rule — the parent delegates, never does the work

The parent does **zero** document work. Every stage runs inside a subagent — except the
mechanical copy/transform steps, which are **deterministic scripts, not agents** ("agents
judge, scripts copy"). The parent only: dispatches waves and single children, holds state
between stages, runs the deterministic shell commands (`inventory`, `merge-dispositions`,
`prelink`, `group-skeleton`, `group-populate`, `build-review-data`, `ledger`,
`review-groups`), and stops at the human gates and Ledger Gates. Never read/interpret/link/
map/group documents in the parent — doing so blows the context budget the whole design
exists to protect.

**No exceptions for "small" fixes.** The parent never `Read`s, `Edit`s or `Write`s files
inside the client folder, other than its two owned artifacts: the `## Decisions (auto)` log
in `CLIENT.md` and policy entries in `ข้อมูลระบบ/_pages/dispositions.yaml`. A wrong or
missing `interpretation.json` field, a malformed fragment, a group that needs one line
corrected — all of it is a **re-dispatch of the bounded child that owns that file**, never
a parent edit. (Postmortem `_216`: the parent hand-patched six segments' interpretations
and fragments "quickly" — every one of those edits then rode along ~950 subsequent parent
turns as permanent context.)

Two rules that shape every dispatch:

- **Batch small units — never one agent per tiny unit.** Every subagent costs a fixed ~25k-token startup before it does any work. A stage with hundreds of small units (categorize, agent-populate) dispatched one-per-unit burns millions of tokens on pure overhead and has killed runs at the session limit. Group them: one `ksk-poirot` per **≤20 explicitly listed groups**, one `ksk-marple` populate per **≤20 groups sharing the same source interpretation**. Only `ksk-watson` stays one-per-segment/sub-range (vision context doesn't batch).
- **Keep dispatch prompts caveman-short** — each agent's `.md` already holds the full how-to. The prompt carries only the variable data: task tag, client path, exact ids, exact file paths. Do not restate rules the agent already knows.

## Wave dispatch — one `Workflow` per ⚡ stage, the parent wakes once

Fan-out stages (marked ⚡ in the stage skills) do **not** dispatch children one `Agent` call
at a time. Background children each re-invoke the parent on completion; a 23-child wave
means ~23 full-context parent turns spent counting stragglers (postmortem `_216`: 192
wait-loop wakeups re-reading a ~400k-token context — the parent alone cost 2.5× all 51
workers combined). Instead, the parent wraps the whole wave in **one `Workflow` call** and
is woken **once**, with every child's digest in a single result:

```
Workflow({
  args: units,   // [{ agentType: "ksk-watson"|"ksk-marple"|"ksk-poirot", label: "seg-004", prompt: "<the stage's per-unit prompt>" }]
  script: `
export const meta = {
  name: 'ksk-wave',
  description: 'Run one ksk-keying fan-out stage as a single wave',
  phases: [{ title: 'Wave' }],
}
// args can arrive JSON-encoded as a string instead of a parsed array
// (harness serialization quirk) — parse defensively before touching it.
const units = typeof args === 'string' ? JSON.parse(args) : args
const results = await parallel(units.map(u => () =>
  agent(u.prompt, { agentType: u.agentType, label: u.label, phase: 'Wave' })))
const failed = units.filter((u, i) => !results[i]).map(u => u.label)
if (failed.length) log('failed/skipped: ' + failed.join(', '))
return { digests: results.filter(Boolean), failed }
`})
```

Rules for waves:

- The per-unit `prompt` strings are exactly the stage skill's templates — the workflow changes *who waits*, never what a child is asked.
- The parent builds `units` from the manifest, fires the one `Workflow` call, and **does nothing else for that stage until the workflow completes**. No transcript-watching, no per-child progress notes, no `ScheduleWakeup` polling loops.
- On completion, verify **by script, once** (`ledger`, `build-review-data`'s missing-inputs exit, or a one-line file count) — the ledger gates, not child digests, are the trust anchor. Re-dispatch only the `failed` labels (a second, smaller wave).
- Workflows are for **waves**. Single-child stages (magnum, columbo, sherlock) stay plain `Agent` calls — foreground (`run_in_background: false`) so completion, not notification traffic, resumes the parent.

**Fallback (no `Workflow` tool):** dispatch the wave as background `Agent` calls, all in one
message, then hold notification discipline: never spend a turn acknowledging a single child
(no per-child "รับทราบ" — at a large context every turn re-reads the whole conversation);
act only when the **last** child of the wave finishes or a child reports a blocker, and use
one long `ScheduleWakeup` (≥900s) purely as a hang-guard, not as a polling clock.

## Context hygiene — the parent's context is the run's scarcest resource

Every parent turn re-reads everything the parent has ever kept, so:

- **No narration turns.** No run-log `echo` turns, no "current status" recaps between dispatches. If a status note matters, append it to a run-log file as part of a command that does real work.
- **Cap script output into context.** For commands with long output (`group-skeleton`'s per-group listing, test runs), pipe to a file under `ข้อมูลระบบ/_run/` and read back only the count/exit lines (`… > file 2>&1; tail -5 file`). Never paste hundreds of warning lines into the conversation to browse them — grep the file.
- **Digests only, paths not content** (see next section) — and never re-open result files "to double-check"; the gates check.

## Hard rule — children write full to disk, return thin digests

Every subagent's final reply becomes part of the parent's permanent context and rides along
every later parent turn. A child that echoes its full result (all documents, every line
item, full JSON) is what balloons the parent's context across dozens of runs. So the whole
team follows **write full, return thin**:

- Each child **persists its full result to a file** (watson/marple spreadsheet → `ข้อมูลระบบ/_segments/<segment_id>/interpretation.json` at the `resultPath` the parent names; sherlock → `links.yaml`; poirot → `categorize.json`; marple populate → the group's `interpretation.json`; magnum → `CLIENT.md`) and **replies with a compact digest only** — paths written, counts, flags, questions. Stage 2 children also write their **full Page Disposition to a fragment file** (`ข้อมูลระบบ/_pages/fragments/<segment_id>.yaml`, schema `ksk_disposition_fragment.v1`) — never into the digest; the digest carries only the fragment path and `N used / M excluded` counts, and the parent's `merge-dispositions` script folds the fragments into `dispositions.yaml` (Page Ledger accountability depends on every page appearing in a fragment).
- **The parent passes files (paths), not content.** When a later stage needs an earlier stage's result, the dispatch prompt hands the child the **file path** to read — never a summary the parent composed by reading fat replies. The parent must not read/interpret those result files itself either (that reloads the context this design protects); it only forwards paths.

## Script failures mid-run — delegate, don't become the debugger

When a script fails or mis-handles real data mid-run, the parent does not become the
debugger. Diagnose just far enough to name the failing command + one concrete input file,
then hand the fix to **one bounded `general-purpose` subagent** ("fix `<command>` for
`<client input file>`: symptom X; run its tests; don't touch client data") and continue or
wait on its digest. A multi-turn edit-test-rerun arc inside the parent is the same context
leak as document work (postmortem `_216`: a 20-minute inline repair of `groups-lib.ts` —
correct fix, wrong executor — inflated every later turn). Exception: a one-line, one-shot
unblock (a path typo, a missing flag) the parent can make in a single turn is fine; the
moment a second edit round is needed, delegate.

## Bounded-child rules (every stage)

- One bounded unit per child — one segment, one explicitly listed batch of groups, one bucket. Never the whole client, and never "all remaining groups" without listing them.
- Children have no memory — the prompt must carry client path, exact id, exact files, task tag. Nothing else.
- No child spawns subagents.
