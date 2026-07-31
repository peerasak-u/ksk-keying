# ksk-keying

KSK client-document keying for Claude Code — segment a client folder, interpret Thai
accounting documents, link transactions, map to the chart of accounts, and produce
human-reviewable proposals that export to PEAK.

## Quick start (for humans)

1. Put this folder anywhere on your machine.
2. Open **this folder** in [Claude Code](https://code.claude.com/docs/en/overview).
3. Tell Claude:

```
Read README.md, then install this repo and confirm when /ksk-keying is ready.
```

Claude will run the install steps below and report back. No manual setup needed.

## Install (for Claude Code)

When a user asks you to install this repo, do the following in order:

1. **Read this file** — understand what the repo provides and what "done" looks like.
2. **Check prerequisites**
   - [Claude Code](https://code.claude.com/docs/en/overview) with the `Agent` tool (this session).
   - [Bun](https://bun.sh) on the machine. If missing, tell the user to install Bun and stop.
   - **Poppler** (`pdfinfo`, `pdftoppm`) — Stage 0 counts pages with it and Stage 2 renders with
     it, so a run without Poppler sets up cleanly, spends money, and dies mid-pipeline.
     `brew install poppler` / `sudo apt install poppler-utils` /
     `winget install oschwartz10612.Poppler`. `doctor` checks this for you.
3. **Install dependencies, then verify** — from the repo root:

```bash
bash scripts/install.sh     # dependencies only
bash scripts/doctor.sh      # verify; exits non-zero if anything is missing
```

On Windows, use the PowerShell siblings instead:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
powershell -ExecutionPolicy Bypass -File scripts\doctor.ps1
```

> **Windows users: follow [`docs/windows-setup.md`](docs/windows-setup.md).**
> It is the full step-by-step — prerequisites (including Poppler, which is
> required and easy to miss), execution policy, preparing a client for a blind
> run, starting the web UI, and a troubleshooting section covering every error
> that has actually come up. Docker and WSL are not needed.

4. **Read `doctor`'s output** — it checks the tools, the orchestrator + six `ksk-stage-*` skills,
   all seven `ksk-*` agents, both dependency roots, and finishes by actually running a bundled
   script to prove the toolchain resolves its own paths on this host.
5. **Tell the user** they can run `/ksk-keying` (or "run ksk-keying on `<client folder>`").
   If the skill does not appear in `/` yet, restart Claude Code from this folder.

**Done when:** `scripts/doctor.sh` (or `doctor.ps1`) exits 0 and `/ksk-keying` is available.

Re-run `doctor` any time something starts behaving oddly — it is not just a post-clone step.

No API keys or `.env` file needed — Claude Code subagents do the AI work, and the
bundled Bun tools (`inventory`, `prepare-pages`, `ledger`, `build-review-data`, … )
are deterministic.

## What you get

- **`/ksk-keying`** — parent orchestrator skill (stage sequence, gates, artifact contract) that drives **six per-stage skills** (`ksk-stage-profile/segment/interpret/link/group/categorize`)
- **Seven subagents** in `.claude/agents/` — magnum, columbo, watson, sherlock, marple, poirot, lestrade
- **Review UI** — `ตรวจทาน.html` per bucket with inline source preview + PEAK XLSX export, an
  `index.html` hub linking every bucket, and `ที่ถูกตัดออก.html` listing what was excluded

Client data stays **outside** this repo. Point the workflow at a client folder on disk.

## Run

```
/ksk-keying
```

or:

```
run ksk-keying on /path/to/_362 บจก.ตัวอย่าง
```

The run is unattended: it decides by policy and never stops mid-run except on a hard blocker
(no chart of accounts at all, an unreadable required file). Human review happens once, at the
end, on the review pages.

When finished, open each review page in Chrome or Edge:

```
file:///path/to/client/<เดือน>/ตรวจทาน/ค่าใช้จ่าย/มีภาษี/ตรวจทาน.html
```

Review each row against its inline source document, then export `นำเข้า PEAK - <หมวด ภาษี>.xlsx`
from the page into that same `ตรวจทาน` folder.

### Artifacts created

Each run is scoped to **one month folder** inside the client folder; the generated trees land
in that month folder. Only the month-invariant context files sit at the client root:

| Artifact | Where | Purpose |
|----------|-------|---------|
| `CLIENT.md` | client root | Client profile — business nature, buyer identity, COA conventions |
| `coa.csv` | client root | Chart of accounts (converted from `ผังบัญชี` workbook if needed) |
| `<เดือน>/ข้อมูลระบบ/_segments/` | month folder | Folder segmentation proposal |
| `<เดือน>/ข้อมูลระบบ/_doc_groups/` | month folder | Category/VAT tree, per-group interpretations and mappings |
| `<เดือน>/ข้อมูลระบบ/_pages/` | month folder | Inventory census, page ledger, gate stamps |
| `<เดือน>/ตรวจทาน/index.html` | month folder | Review hub — links every bucket, start here |
| `<เดือน>/ตรวจทาน/<หมวด>/[<ภาษี>/]ตรวจทาน.html` + `นำเข้า PEAK - *.xlsx` | month folder | Human review + PEAK export per bucket |
| `<เดือน>/ตรวจทาน/ที่ถูกตัดออก.html` | month folder | Every page/sheet proposed for exclusion, with previews (only when non-empty) |

Rendered page images land in `<เดือน>/_pages/` (alongside `ข้อมูลระบบ/`, not inside it).

Full contract: `.claude/skills/ksk-keying/SKILL.md`.

## Repo layout

```
.claude/
  skills/
    ksk-keying/           # orchestrator skill + shared references + bundled scripts
      SKILL.md            #   stage sequencer + artifact contract
      references/         #   decision-policy, orchestration, ledger-gates, schemas
      scripts/            #   the deterministic Bun tools every stage shells out to
    ksk-stage-profile/    # Stage 0  (client profile + inventory)
    ksk-stage-segment/    # Stage 1  (segment)
    ksk-stage-interpret/  # Stage 2  (interpret + profile update)
    ksk-stage-link/       # Stage 3  (link transactions)
    ksk-stage-group/      # Stage 4  (doc-group tree + populate)
    ksk-stage-categorize/ # Stage 5  (categorize + review-data + HTML)
  agents/                 # seven leaf subagents (auto-loaded)
scripts/install.sh        # dependencies (install.ps1 = Windows sibling)
scripts/doctor.sh         # verify prerequisites + smoke-test the toolchain (doctor.ps1)
scripts/console.ps1       # Windows: start the web UI (workspace presets in its EDIT ME block)
scripts/prepare-client.ps1 # Windows: split a client into a blind copy + its answer key
scripts/sync-deploy.ps1   # Windows: push skills + agents to a deployed install
console/                  # optional local web UI for running/watching runs — see console/README.md
docs/windows-setup.md     # step-by-step PowerShell manual + troubleshooting
docs/ksk-team/            # visual team overview (optional)
```

`console/` is dev/ops tooling, not part of the shipped skill: the deployable set is
`.claude/skills/` + `.claude/agents/` only. You never need it to run `/ksk-keying`.

## Notes

- **Work from this repo.** Subagents only auto-load when Claude Code's working directory
  is this project.
- **Never commit client data.** `samples/` and `.claude/skills/ksk-keying/scripts/.runs/` are gitignored.
- **Claude Desktop / Claude.ai** cannot run this workflow — it needs Claude Code subagents.
- **Runs natively on Windows, macOS and Linux** — Bun plus Poppler is the whole runtime.
  Docker and WSL are not required on any platform. On Windows, run the `.ps1` installers
  above if you have no bash shell; everything else is identical.