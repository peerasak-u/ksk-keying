---
name: ksk-eval
description: Run the agent eval suite (evals/) — dispatch eval cases to a ksk agent under test via the Agent tool, grade deterministically, report vs baseline. Use when asked to "run the watson eval", "/ksk-eval watson", measure an agent, or check a prompt change for regressions. Dev-repo tooling; needs the gitignored samples/evals/ dataset on this machine.
---

# ksk-eval — run an agent eval

You are the eval runner. The agent under test does the reading; you only
dispatch, then grade with deterministic scripts. Never grade by judgment, never
edit outputs, never peek at a case's `expected.json` while dispatching.

Full background: `evals/README.md`.

## Procedure

1. **Prepare the run.** From `evals/`:

   ```bash
   bun run dispatch.ts -- <agent> [--cases id1,id2] [--replicates N] [--note "<why this run>"]
   ```

   `<agent>` is the short name (`watson`). This creates
   `samples/evals/_runs/<agent>/<run-id>/` and prints one dispatch block per
   case × replicate. Always pass `--note` describing what is being tested
   (e.g. "baseline before playbook change X").

2. **Dispatch.** For each printed block, spawn one subagent of the matching
   type (`ksk-watson`) with the printed prompt **verbatim** — do not rephrase,
   do not add context, do not batch two cases into one agent. Launch them in
   parallel (multiple Agent calls per message); the harness queues past its
   concurrency cap on its own.

3. **Verify completeness.** Every case dir in the run must contain its
   `output-r*.json`. If an agent died or wrote nothing, re-dispatch that one
   block once; if it fails again, note the case as un-run and continue.

4. **Grade + report:**

   ```bash
   bun run grade.ts  -- <agent> --run <run-id>
   bun run report.ts -- <agent> --run <run-id>
   ```

   `report.ts` exits 1 on regression vs baseline — report that loudly.

5. **Record.** Give the user: cases pass (solid), silent-error rate (solid),
   per-field table, regressions if any, and the run-id. If the user confirms
   this run is the new reference: `bun run report.ts -- <agent> --run <run-id>
   --set-baseline` and append an aggregate row to `evals/SCOREBOARD.md`
   (numbers only — never client names/amounts).

## Hard rules

- The dispatch prompt comes from `dispatch.ts` verbatim — it mirrors the
  production SKILL.md template; any wording drift invalidates the measurement.
- Outputs are whatever the agent wrote. A malformed/missing output is a
  finding (report it), never something you fix by hand.
- Do not read `samples/old-result/` — expectations were already verified at
  harvest time.
- Replicates exist for stability measurement; don't cherry-pick the best one.
