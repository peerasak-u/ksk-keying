# Prototype: engine-owned stage sequencer

## Question

From the Phase 1 R&D on adopting `no-mistakes`' pattern into ksk-keying (see
conversation / the "Phase 1 Decision Document" that named this move 2): can a
single sequencer own "spawn one stage → run that stage's REAL deterministic
gate script → branch on the gate's real exit code in code → refuse to start
the next stage under any code path if the gate didn't pass"? And does "one
sequencer function" survive the awkward cases:

- a stage with no gate script at all (link, group, categorize),
- a stage's own agent process failing before it ever reaches its gate,
- retrying a blocked/env-error gate after fixing evidence, without
  re-running any earlier stage,
- a real `exit 2` (usage/env error) vs a real `exit 1` (blocked) — are they
  actually distinguishable in practice, not just in the script's doc comment?

This is pure R&D: not wired into `console/engine.ts`, no commit, no
dependency on the (un-merged) `ksk-keying` branch's newer console.

## Run it

```sh
bun run --cwd console proto:sequencer
```

## Correction this prototype forced during build (before a single key was pressed)

The Phase 1 research doc assumed `group-gates.ts` was Stage 4's pass/fail
gate, the way `ledger.ts --gate segment|interpret|final` is for Stages 1, 2,
and completion. Reading it to wire this prototype up showed that's wrong:
`group-gates.ts` is an image organizer (buckets `*.gate.json`-classified
scans into folders by group) with no "blocked" concept at all — it exits 1
only on an uncaught exception, never as a designed outcome. There is no
deterministic pass/fail gate for Stage 4 (group), same as Stage 3 (link) and
Stage 5 (categorize). `STAGES` in `logic.ts` reflects the corrected, verified
shape: only `segment`, `interpret`, and `final` have `gate !== null`.

## Verdict

**Yes — extended and proven.** This prototype now answers the original question plus the
follow-on from the Phase 1 decision doc ("actually invoking Claude Code for each stage,
reliably"):

- Every stage now has a real completion check, not just segment/interpret/final.
  `stage-shape-check.ts` (new, `.claude/skills/ksk-keying/scripts/`) covers profile/link/
  group — no stage "advances on trust" anymore. `categorize`'s check is the existing
  `build-review-data.ts` → `review-groups.ts --force` pair, re-run as a real gate rather
  than assumed.
- The completion-detection question from the decision doc's move 2 follow-on is answered:
  process completion (`proc.exited`) was never the unreliable part — `console/engine.ts`'s
  `GATE_RE`/`UNFINISHED_RE` regexing the assistant's own prose was. `spawn-stage.ts` proves
  a real per-stage `claude -p --output-format stream-json` spawn can decide success/fail
  from the protocol's own structured `result` event (`is_error`) plus the exit code —
  zero prose consulted anywhere in the sequencer.
- `human-stop.yaml` (decision-policy.md's three Stop rules, reified) correctly
  short-circuits to `stopped-for-human` even when a stage's own completion check would
  otherwise pass — proven with a real fixture toggle, and confirmed it never
  auto-clears/auto-retries.
- Bounded retries (2 for a blocked check, 1 for an env-error or a process failure that
  never reached a check at all) correctly exhaust into `blocked-for-human`, distinct from
  `stopped-for-human` — the console can show *why* a run stopped, not just that it did.
  `final` (no `ksk-stage-final` skill, `spawnsProcess: false`) is never retried — proven
  it goes straight to `blocked-for-human` on its first failure.
- Full walkthrough proven against the real scripts end-to-end (profile → segment →
  interpret → link → group → categorize → final), including one real snag the synthetic
  fixture surfaced honestly rather than papering over: the first categorize attempt
  correctly failed for a real, on-disk reason (missing `categorize.json`, then a COA CSV
  header mismatch against `categorize.ts`'s actual expected columns) — not a fixture bug
  to hide, exactly the kind of thing a completion check existing to catch.

**What surprised me driving it (beyond the group-gates.ts correction already logged
above):** `ledger.ts`'s and `stage-shape-check.ts`'s "blocked" is never itself a "stop for
a human" signal — every blocked reason this session tested (missing manifest, missing
dispositions, uncovered segment, ungrouped interpretation) is agent-fixable by construction.
The actual "a human must decide" signal is orthogonal and only exists via `human-stop.yaml`
— confirmed by building both into the same state machine and watching them never collide:
a stage can be fully "blocked" (retryable) and "stopped-for-human" (terminal) is a
completely separate axis, not a more-severe version of "blocked."

## Real end-to-end run — samples/clients/216 (บจก.ชามหวาน), เดือนพฤษภาคม

The deferred "does a real client produce the same shape" check above is no longer
deferred — run via the new `run-cli.ts` non-interactive driver (`bun run
console/_prototype_sequencer/run-cli.ts <targetDir>`), which loops `runStage`/`retryStage`
with `spawnStage` (real `claude -p /ksk-stage-<name>`) until a terminal state.

**First two attempts both failed identically** at Stage 0, all 3 tries exhausting retries
into `blocked-for-human` with the exact same offense (`inventory.yaml not found`), even
after adding a headless-completion directive + retry-context feedback to the prompt
(genuinely useful additions, kept, but not the actual fix). A full-transcript diagnostic
run (raw `claude -p`, no discarded output) found the real cause: under
`--permission-mode acceptEdits`, the Bash call running `bun run .../inventory.ts` was
**denied 3 times** — `"This command requires approval"`, `non_execution_kind:
"user-rejected"` — because there is no TTY in headless mode to approve it. The model
handled this *correctly*: it explained it needed approval and stopped, rather than looping
or fabricating success — but the process still exited with `is_error: false`, invisible to
`spawn-stage.ts`'s success/fail signal. This is exactly the "looks fine, actually stuck"
failure mode the whole redesign exists to eliminate, just relocated one layer down (from
the *assistant's prose* to the *permission system*) — a real, non-obvious finding, not a
prototype bug to shrug off. Fix: `spawn-stage.ts` now uses `--permission-mode
bypassPermissions`, matching what `console/.env.example` already documents as the setting
for a real unattended run (`# KSK_PERMISSION_MODE=bypassPermissions`) — there's no human
watching a bounded single-stage spawn to approve anything anyway; the external completion
check afterward is this architecture's actual trust boundary, not the agent's own tool
permissions.

**Third attempt, same target dir, same fix: full PASS, first try, every stage, zero
retries.** profile (44s) → segment (4m) → interpret (13m — watson/marple visual
interpretation, the long pole) → link (1m42s) → group (3m43s) → categorize (5m13s) → final
(instant, no process). ~28.5 minutes wall-clock end to end. Real Ledger Gate final result:
52 units, 50 reviewed, 2 correctly excluded (1 agent-flagged cross-segment duplicate, 1 the
COA workbook context-file exclusion), 0 unaccounted. Real `ตรวจทาน/` deliverable HTML
generated (expense มีภาษี + คละภาษี, income, bank statement, index, excluded-items page).
No `human-stop.yaml` ever fired — a clean run with no Decision Policy hard blockers.

This is the strongest evidence yet for the whole Phase 1 redesign: a completely
standalone, fresh-context `claude -p /ksk-stage-<name> <dir>` invocation per stage — no
orchestrator, no accumulated context across stages — genuinely works end to end against a
real client-month, once the permission mode matches what unattended headless execution
actually needs. The context-bloat fix (one fresh process per stage instead of one session
accumulating all six) is not just theoretically sound, it now has a real passing run behind
it.

**Still deferred:** an "un-stick" TUI action for `stopped-for-human` beyond a full `[R]`
reset (fine for this prototype's scope, needed before this becomes a real console feature);
everything named as out-of-scope in the approved plan (full `decisions.yaml`, crash-resume,
the opus validators, merging `ksk-keying` → `main`, `CLAUDE.md`'s tier section).
