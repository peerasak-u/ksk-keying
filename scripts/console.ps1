#Requires -Version 5.1
<#
.SYNOPSIS
  Start the KSK web UI without hand-typing environment variables.

.DESCRIPTION
  Two servers live in console/ and they are NOT the same app:

    * app/server.ts   — the current review app (dashboard, review hub, COA,
                        PEAK export), driven by the deterministic per-stage
                        sequencer. Port 4900. This is the default here.
    * server.ts       — the OLD /ksk-keying interactive console (engine.ts +
                        the 3-lane board), which app/config.ts calls "the OLD
                        console" in as many words. Port 4820. Still works, kept
                        for the single-shot headless run + watchdog path.
                        Reachable with -Legacy.

  Workspaces are named in the EDIT ME block below, so switching between the
  Dropbox install and a local test folder is `-Workspace dropbox` instead of
  pasting a path with Thai characters and a space in it.

.EXAMPLE
  .\scripts\console.ps1 -Workspace dropbox        # review app, port 4900
.EXAMPLE
  .\scripts\console.ps1 -Workspace test           # review app, local test data
.EXAMPLE
  .\scripts\console.ps1 -Legacy -Mock             # old console, free, fake engine
.EXAMPLE
  .\scripts\console.ps1 -Legacy -Workspace dropbox  # old console, real engine
#>
[CmdletBinding()]
param(
	# Preset name from $Workspaces below, or any literal path.
	[string] $Workspace,
	# Run the OLD /ksk-keying console (engine.ts) instead of the review app.
	[switch] $Legacy,
	# -Legacy only: use the token-free fake engine. The review app has no mock
	# mode — it always drives the real sequencer.
	[switch] $Mock,
	# Defaults to 4900 for the review app, 4820 for the legacy console.
	[int]    $Port,
	# Review app only: how many runs may be active at once.
	[int]    $Concurrency = 1,
	# -Legacy only. Passed to `claude -p --model`; omit to inherit your default.
	[string] $Model,
	[string] $PermissionMode = "bypassPermissions",
	# -Legacy only: per-invocation ceiling, re-applied on every auto-continue.
	[double] $MaxBudgetUsd = 10,
	# -Legacy only: cumulative per-run guard checked before each auto-continue.
	[double] $RunBudgetUsd = 15,
	# Start anyway despite failed pre-flight checks.
	[switch] $Force
)

# ==== EDIT ME ============================================================
# Add or repoint workspaces here. A workspace root is the folder whose
# level-1 subfolders are CLIENTS (not the client folder itself).
$Workspaces = @{
	# Blind-runnable copies of the (พร้อมทดสอบ) clients, answer keys stripped
	# out — produced by .\scripts\prepare-client.ps1. This is the one to run.
	prepared = "C:\Users\Peerasak\Workspace\ksk-clients"
	# The live Dropbox tree. Read-only source: it still holds the answer keys,
	# so the pre-flight refuses it unless you -Force.
	dropbox  = "C:\Users\Peerasak\Dropbox\สารบัญงานบัญชี_For Ton"
	test     = "C:\Users\Peerasak\Workspace\ksk-test-workspace"
}
$DefaultWorkspace = "prepared"
# =========================================================================

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Fail($m) { Write-Host "  ERROR $m" -ForegroundColor Red }
function Warn($m) { Write-Host "  warn  $m" -ForegroundColor Yellow }
function Ok  ($m) { Write-Host "  ok    $m" -ForegroundColor Green }

if (-not $Port) { $Port = if ($Legacy) { 4820 } else { 4900 } }
if ($Mock -and -not $Legacy) {
	Write-Host "ERROR -Mock applies only to -Legacy; the review app has no mock engine." -ForegroundColor Red
	exit 1
}

# --- resolve the workspace -------------------------------------------------
if (-not $Workspace) { $Workspace = $DefaultWorkspace }
$resolved = if ($Workspaces.ContainsKey($Workspace)) { $Workspaces[$Workspace] } else { $Workspace }

$app = if ($Legacy) { "legacy console (engine.ts)" } else { "review app (app/server.ts)" }
Write-Host "app       : $app"
if ($Workspaces.ContainsKey($Workspace)) { Write-Host "workspace : $Workspace -> $resolved" }
else {
	Write-Host "workspace : $resolved"
	Write-Host "            (not a preset; known presets: $($Workspaces.Keys -join ', '))" -ForegroundColor DarkGray
}
$spends = if ($Legacy -and $Mock) { "" } else { "  *** SPENDS MONEY ***" }
Write-Host "engine    : $(if ($Legacy -and $Mock) { 'mock' } else { 'claude' })$spends"
Write-Host "port      : $Port"
Write-Host ""

# --- pre-flight ------------------------------------------------------------
$problems = 0
Write-Host "pre-flight"

# The legacy console in mock mode invents its own demo workspace and never
# spawns claude, so it is the one configuration that needs none of this.
$needsWorkspace = -not ($Legacy -and $Mock)

if ($needsWorkspace) {
	if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
		Fail "workspace root does not exist: $resolved"
		$problems++
	} else {
		Ok "workspace root exists"

		# Answer-key contamination. CLAUDE.md's hard rule: a raw client must
		# never contain PEAK-export files, or a run rooted there censuses the
		# very files it would later be graded against.
		$keys = Get-ChildItem -LiteralPath $resolved -Directory -Recurse -Depth 2 -Filter "File PEAK import" -ErrorAction SilentlyContinue
		if ($keys) {
			# BLOCKING, not a warning. This was a warning once, and the warning
			# was read and then a listed month was started anyway: the census
			# ingested 4 answer-key .xlsx files as source documents and the
			# pipeline wrote its ข้อมูลระบบ/ tree back into the Dropbox folder
			# that CLAUDE.md designates read-only source material. A caution the
			# UI then invites you to ignore is not a guard. The script cannot
			# police which month you click, so it refuses the workspace.
			Fail "$($keys.Count) client month(s) contain 'File PEAK import' (the answer key):"
			$keys | Select-Object -First 5 | ForEach-Object { Fail "    $($_.FullName.Substring($resolved.Length + 1))" }
			if ($keys.Count -gt 5) { Fail "    ... and $($keys.Count - 5) more" }
			Fail "  Running any of these in place censuses the answer key as source data AND writes pipeline"
			Fail "  output into read-only source. Prepare a stripped copy first, or re-run with -Force if you"
			Fail "  are certain you will only touch a clean month."
			$problems++
		} else {
			Ok "no answer-key folders in the workspace"
		}
	}

	if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { Fail "claude not found on PATH"; $problems++ }
	else { Ok "claude on PATH" }

	# The failure this check exists for: winget's Poppler install prints
	# "restart your shell to use the new value", and a shell older than that
	# install passes its stale PATH straight to bun and every child. The run
	# then dies at Stage 2 with "pdfinfo not found" long after it started.
	foreach ($tool in @("pdfinfo", "pdftoppm")) {
		if (Get-Command $tool -ErrorAction SilentlyContinue) { Ok "$tool on PATH" }
		else {
			Fail "$tool not found on PATH — Stage 0 counts pages and Stage 2 renders with it."
			Fail "  If you installed Poppler in this shell's lifetime, its PATH is stale. Either open a new"
			Fail "  PowerShell, or refresh it here:"
			Fail '    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")'
			$problems++
		}
	}
}

if ($Legacy -and $needsWorkspace -and (Test-Path -LiteralPath $resolved -PathType Container)) {
	# Only the legacy console spawns claude with cwd = the workspace root, so
	# only it needs a .claude/ there. The review app's sequencer resolves
	# REPO_ROOT to this checkout instead (spawn-stage.ts), and finds the skills
	# here.
	$skill = Join-Path $resolved ".claude\skills\ksk-keying\SKILL.md"
	if (-not (Test-Path -LiteralPath $skill)) {
		Fail "no .claude/skills/ksk-keying in the workspace root — the legacy console spawns claude with its cwd set there, so /ksk-keying would be unknown and every run would no-op while reporting a clean 'done'. Fix: .\scripts\sync-deploy.ps1 -To '$resolved'"
		$problems++
	} else {
		Ok ".claude/skills/ksk-keying present"

		# Drift check, by content hash rather than mtime since robocopy
		# preserves timestamps. A stale deployed copy silently runs code you
		# already fixed here.
		$deployedScripts = Join-Path $resolved ".claude\skills\ksk-keying\scripts"
		$repoScripts     = Join-Path $Root     ".claude\skills\ksk-keying\scripts"
		$stale = @()
		foreach ($f in Get-ChildItem $repoScripts -Filter *.ts -File -ErrorAction SilentlyContinue) {
			if ($f.Name -like "*.test.ts") { continue }
			$there = Join-Path $deployedScripts $f.Name
			if (-not (Test-Path -LiteralPath $there)) { $stale += "$($f.Name) (missing)"; continue }
			if ((Get-FileHash -LiteralPath $f.FullName).Hash -ne (Get-FileHash -LiteralPath $there).Hash) { $stale += $f.Name }
		}
		if ($stale.Count -gt 0) {
			Warn "deployed scripts differ from this repo ($($stale.Count)): $(($stale | Select-Object -First 5) -join ', ')$(if ($stale.Count -gt 5) { ', ...' })"
			Warn "  re-sync: .\scripts\sync-deploy.ps1 -To '$resolved'"
		} else { Ok "deployed scripts match this repo" }
	}
}

if (-not $Legacy) {
	# The review app shells out to the bundled scripts from THIS checkout, and
	# imports yaml/xlsx itself — both are runtime deps, not dev extras.
	if (-not (Test-Path -LiteralPath (Join-Path $Root ".claude\skills\ksk-keying\scripts\node_modules"))) {
		Fail "skill script deps missing — run: .\scripts\install.ps1"
		$problems++
	} else { Ok "skill script deps installed" }
	if (-not (Test-Path -LiteralPath (Join-Path $Root "console\node_modules"))) {
		Fail "console deps missing (yaml/xlsx are runtime imports) — run: .\scripts\install.ps1"
		$problems++
	} else { Ok "console deps installed" }
}

Write-Host ""
if ($problems -gt 0 -and -not $Force) {
	Write-Host "Refusing to start with $problems blocking problem(s). Fix them, or re-run with -Force." -ForegroundColor Red
	exit 1
}
if ($problems -gt 0) { Warn "starting anyway (-Force)"; Write-Host "" }

# --- environment -----------------------------------------------------------
# Cleared explicitly, not merely left unset: these persist for the shell
# session, so a previous invocation in the same window would otherwise leak
# its settings into this one.
foreach ($v in "KSK_ENGINE", "KSK_PERMISSION_MODE", "KSK_MAX_BUDGET_USD", "KSK_RUN_BUDGET_USD",
                "KSK_ENGINE_MODEL", "KSK_CONSOLE_PORT", "KSK_APP_PORT", "KSK_APP_CONCURRENCY", "KSK_WORKSPACE_ROOT") {
	Remove-Item "Env:\$v" -ErrorAction SilentlyContinue
}

if ($Legacy) {
	$env:KSK_CONSOLE_PORT = "$Port"
	if ($Mock) {
		if ($PSBoundParameters.ContainsKey("Workspace")) { $env:KSK_WORKSPACE_ROOT = $resolved }
	} else {
		$env:KSK_ENGINE          = "claude"
		$env:KSK_WORKSPACE_ROOT  = $resolved
		$env:KSK_PERMISSION_MODE = $PermissionMode
		$env:KSK_MAX_BUDGET_USD  = "$MaxBudgetUsd"
		$env:KSK_RUN_BUDGET_USD  = "$RunBudgetUsd"
		if ($Model) { $env:KSK_ENGINE_MODEL = $Model }
	}
	$entry = "console/server.ts"
} else {
	$env:KSK_APP_PORT        = "$Port"
	$env:KSK_APP_CONCURRENCY = "$Concurrency"
	$env:KSK_WORKSPACE_ROOT  = $resolved
	$entry = "console/app/server.ts"
}

Write-Host "-> http://127.0.0.1:$Port    (Ctrl+C to stop)" -ForegroundColor Cyan
Write-Host ""
bun $entry
