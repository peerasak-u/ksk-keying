# Running ksk-keying on Windows (PowerShell)

Step by step, from a fresh clone to a finished run. Everything here is native —
**Docker and WSL are not needed and not used**. Bun plus Poppler is the whole
runtime.

Commands assume you are in the repo root:

```powershell
cd C:\Users\Peerasak\Workspace\ksk-keying
```

---

## 1. Install the prerequisites

| Tool | Why | Install |
|---|---|---|
| **Bun** | runs the server and every bundled script | `powershell -c "irm bun.sh/install.ps1 \| iex"` |
| **Claude Code** | does the actual AI work | see [code.claude.com/docs](https://code.claude.com/docs/en/overview) |
| **Poppler** | `pdfinfo` counts pages (Stage 0), `pdftoppm` renders them (Stage 2) | `winget install oschwartz10612.Poppler` |

> **After installing Poppler, open a NEW PowerShell window.** winget updates the
> PATH for *future* processes, not the one you are sitting in. This is the single
> most common cause of a run dying at Stage 2 with `pdfinfo not found` — see
> Troubleshooting.

Check all three:

```powershell
bun --version
claude --version
pdfinfo -v
```

---

## 2. Allow PowerShell to run the scripts

Windows blocks unsigned local scripts by default. Once, per user, no admin
needed:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

`RemoteSigned` permits scripts you created locally while still blocking unsigned
ones downloaded from the internet.

Prefer not to change it? Put `powershell -ExecutionPolicy Bypass -File` in front
of every script below — it applies to that one invocation only:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\doctor.ps1
```

---

## 3. Install dependencies

```powershell
.\scripts\install.ps1
```

Installs Bun packages in **both** roots that need them: the bundled skill
scripts, and `console\` (whose `yaml` and `xlsx` are runtime imports of the
sequencer, not dev extras).

---

## 4. Verify

```powershell
.\scripts\doctor.ps1
```

Checks the tools, all 7 skills, all 7 agents, both dependency roots, and then
**actually runs a bundled script** to prove the toolchain resolves its own paths
on this host. Exits `0` when ready, `1` if anything is missing.

Re-run this any time something behaves oddly — it is not just a post-clone step,
and it answers "is this an environment problem?" in about two seconds.

---

## 5. Prepare a client

Client folders in Dropbox **cannot be run where they sit**. Each
`(พร้อมทดสอบ)_*` month carries a `File PEAK import` folder — the known-correct
PEAK export used for grading — and the pipeline would census it as source data.
Dropbox is also read-only source: pipeline output must never be written back
into it.

So split the client first:

```powershell
.\scripts\prepare-client.ps1 -Client 216
```

`-Client` takes any substring (`216`, `ชามหวาน`, `ฮัก ดีไซน์`) and refuses
ambiguous matches rather than guessing. Add `-Month 69-03` for a single month.

You get two trees:

```
C:\Users\Peerasak\Workspace\ksk-clients\<client>\<month>\        raw source — runs point here
C:\Users\Peerasak\Workspace\ksk-answer-keys\<client>\<month>\    answer key — for grading, AFTER
```

Also excluded from the runnable copy: any generated tree left by an earlier run
(`ข้อมูลระบบ`, `ตรวจทาน`, `_pages`, …). A starting-state client is raw input —
otherwise a "blind" run resumes someone else's work instead of reproducing it.

Kept at the client root: `CLIENT.md`, `coa.csv`, `coa_usage.json` and the
`ผังบัญชี` workbook. Those are month-invariant context, not answers, and a run
with no chart of accounts hits a hard blocker immediately.

The script asserts the split held, and fails if any PEAK material or generated
tree reached the runnable copy.

---

## 6. Run

```powershell
.\scripts\console.ps1
```

Opens on <http://127.0.0.1:4900>. Pick a client, pick a month, press **เริ่มงาน**.
`Ctrl+C` stops the server.

`-Workspace` selects where clients come from. The presets live in an `EDIT ME`
block at the top of `scripts\console.ps1` — edit that to add your own:

| Preset | Path | Notes |
|---|---|---|
| `prepared` | `…\ksk-clients` | **default** — the blind copies from step 5 |
| `dropbox` | `…\Dropbox\สารบัญงานบัญชี_For Ton` | live source; refused unless `-Force`, because the answer keys are still in it |
| `test` | `…\ksk-test-workspace` | small local fixture |

Useful switches: `-Port`, `-Concurrency`, `-Force`, and `-Legacy` (see below).

A run is unattended. It decides by policy and only stops at a hard blocker or a
Ledger Gate.

---

## 7. Review and export

When the run finishes, open the **hub** — not a bucket page:

```
<workspace>\<client>\<month>\ตรวจทาน\index.html
```

It links every category/VAT bucket. In each bucket's `ตรวจทาน.html`, check each
row against its inline source document, then export
`นำเข้า PEAK - <หมวด ภาษี>.xlsx` from the page into that same `ตรวจทาน` folder.

Only after that should you compare against `ksk-answer-keys\` — never before.
Looking at the answer key while producing the answer defeats the point of having
one.

---

## Troubleshooting

Every entry below is an error that actually happened on this machine.

### `... cannot be loaded because running scripts is disabled on this system`
Execution policy — see step 2.

### `pdfinfo not found` mid-run
Your shell's PATH predates the Poppler install. Open a new PowerShell, or refresh
in place:

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
```

`console.ps1` now checks this before starting, so you should see it in the
pre-flight rather than minutes into a run.

### The web UI looks wrong / outdated
There are two servers and they are different applications:

| | Port | What |
|---|---|---|
| `console\app\server.ts` | **4900** | the current review app — **this is the default** |
| `console\server.ts` | 4820 | the old `/ksk-keying` console (3-lane board), reachable with `-Legacy` |

If you see a Trello-style board, you are on 4820.

### `12 client month(s) contain 'File PEAK import'` and it refuses to start
Working as intended — you pointed at the Dropbox workspace. Do step 5 instead.
`-Force` overrides, but then *you* are responsible for only touching a clean
month.

### Status `blocked-for-human`
Retries are exhausted; this status is deliberately terminal, and **retry will not
take it** (`isRetryable` is `blocked || env-error` only). The action is
**repair**, which resets to the segment stage and re-runs from there, keeping
your source files:

```powershell
$p = [uri]::EscapeDataString("<client>/<month>")
Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:4900/api/runs/$p/repair"
```

If the failure was environmental (a missing tool, a bug since fixed), also delete
the month's `_pages\` folder first — `prepare.ts` skips any source that already
has a `manifest.yaml`, so stale artifacts from the failed attempt would be reused
as-is.

### A legacy-console run finishes instantly with a clean `done`
Only affects `-Legacy`. That console spawns `claude` with its working directory
set to the workspace root, so that folder needs its own `.claude\` or
`/ksk-keying` is an unknown command:

```powershell
.\scripts\sync-deploy.ps1 -To "<workspace root>"
```

The review app does **not** need this — it resolves the skills from this
checkout.

### Everything is just slow
Two real causes on this machine, neither a pipeline problem:

- **Process spawn costs ~0.7–5.5s here**, almost certainly Defender scanning
  `bun.exe` on every launch. The pipeline spawns a lot of short-lived scripts.
  A Defender exclusion for `bun.exe` and your workspace would help substantially.
- **Dropbox files are online-only placeholders.** Reading one triggers a
  download. Right-click the client folder → *Make available offline* before a
  large run, or work from a prepared copy (step 5), which is already local.

---

## Script reference

| Script | Does |
|---|---|
| `scripts\install.ps1` | installs Bun deps in both roots |
| `scripts\doctor.ps1` | verifies prerequisites + smoke-tests the toolchain |
| `scripts\prepare-client.ps1` | splits a Dropbox client into a blind copy + answer key |
| `scripts\console.ps1` | starts the web UI |
| `scripts\sync-deploy.ps1` | pushes skills + agents to a deployed install |

`console.ps1`, `prepare-client.ps1` and `sync-deploy.ps1` carry `Get-Help`
comment blocks with examples (`Get-Help .\scripts\console.ps1 -Full`);
`install.ps1` and `doctor.ps1` take no parameters and just explain themselves at
the top of the file.

`sync-deploy.ps1` supports `-WhatIf` (show what would change, write nothing).
`prepare-client.ps1` and `console.ps1` take `-Force`.

`console.ps1`, `prepare-client.ps1` and `sync-deploy.ps1` each have an `EDIT ME`
block near the top holding the paths worth changing — workspace presets, the
Dropbox root, the output folders. You should not need to edit anything below it.
