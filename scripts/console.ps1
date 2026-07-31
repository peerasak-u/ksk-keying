#Requires -Version 5.1
<#
.SYNOPSIS
  Start the KSK console without hand-typing five environment variables.

.DESCRIPTION
  Wraps `bun console/server.ts`. Workspaces are named in the EDIT ME block
  below, so switching between the Dropbox install and a local test folder is
  `-Workspace dropbox` instead of pasting a path with Thai characters and a
  space in it.

  Before starting the real engine it refuses three setups that otherwise fail
  silently or expensively:
    * a workspace root with no .claude/ — `claude` is spawned with its cwd set
      there, so without it /ksk-keying is an unknown command and every run
      no-ops instantly while reporting a clean "done".
    * a deployed .claude/ older than this repo — the copy is a snapshot and
      drifts; a run then executes code you already fixed here.
    * a client month still holding "File PEAK import" — that is the answer key,
      and a run rooted there censuses it as source material.

.EXAMPLE
  .\scripts\console.ps1                      # mock engine, test workspace, free
.EXAMPLE
  .\scripts\console.ps1 -Workspace dropbox -Real
.EXAMPLE
  .\scripts\console.ps1 -Workspace "D:\some\other\root" -Real -Port 4830
#>
[CmdletBinding()]
param(
	# Preset name from $Workspaces below, or any literal path.
	[string] $Workspace,
	# Spawn the real `claude` binary. Costs money. Default is the mock engine.
	[switch] $Real,
	[int]    $Port = 4820,
	# Passed to `claude -p --model`. Omit to inherit your Claude Code default.
	[string] $Model,
	[string] $PermissionMode = "bypassPermissions",
	# Per-invocation ceiling; re-applied on every watchdog auto-continue.
	[double] $MaxBudgetUsd = 10,
	# Cumulative per-run guard the watchdog checks before each auto-continue.
	[double] $RunBudgetUsd = 15,
	# Start anyway despite failed pre-flight checks.
	[switch] $Force
)

# ==== EDIT ME ============================================================
# Add or repoint workspaces here. A workspace root is the folder whose
# level-1 subfolders are CLIENTS (not the client folder itself).
$Workspaces = @{
	dropbox = "C:\Users\Peerasak\Dropbox\สารบัญงานบัญชี_For Ton"
	test    = "C:\Users\Peerasak\Workspace\ksk-test-workspace"
}
$DefaultWorkspace = "test"
# =========================================================================

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Fail($m) { Write-Host "  ERROR $m" -ForegroundColor Red }
function Warn($m) { Write-Host "  warn  $m" -ForegroundColor Yellow }
function Ok  ($m) { Write-Host "  ok    $m" -ForegroundColor Green }

# --- resolve the workspace -------------------------------------------------
if (-not $Workspace) { $Workspace = $DefaultWorkspace }
$resolved = if ($Workspaces.ContainsKey($Workspace)) { $Workspaces[$Workspace] } else { $Workspace }

if ($Workspaces.ContainsKey($Workspace)) {
	Write-Host "workspace : $Workspace -> $resolved"
} else {
	Write-Host "workspace : $resolved"
	Write-Host "            (not a preset; known presets: $($Workspaces.Keys -join ', '))" -ForegroundColor DarkGray
}
$engine = if ($Real) { "claude" } else { "mock" }
Write-Host "engine    : $engine$(if ($Real) { '  *** SPENDS MONEY ***' })"
Write-Host "port      : $Port"
Write-Host ""

# --- pre-flight ------------------------------------------------------------
# Mock mode invents its own demo workspace and never spawns `claude`, so none
# of this applies to it.
$problems = 0
if ($Real) {
	Write-Host "pre-flight"

	if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
		Fail "workspace root does not exist: $resolved"
		$problems++
	} else {
		Ok "workspace root exists"

		$skill = Join-Path $resolved ".claude\skills\ksk-keying\SKILL.md"
		if (-not (Test-Path -LiteralPath $skill)) {
			Fail "no .claude/skills/ksk-keying in the workspace root — /ksk-keying would be an unknown command and every run would no-op while reporting a clean 'done'. Copy .claude/skills + .claude/agents there first."
			$problems++
		} else {
			Ok ".claude/skills/ksk-keying present"

			# Drift check. The deployed copy is a snapshot; a stale one silently
			# runs code you already fixed here. Compared by content, not mtime,
			# because a robocopy preserves timestamps.
			$deployedScripts = Join-Path $resolved ".claude\skills\ksk-keying\scripts"
			$repoScripts     = Join-Path $Root     ".claude\skills\ksk-keying\scripts"
			$stale = @()
			foreach ($f in Get-ChildItem $repoScripts -Filter *.ts -File -ErrorAction SilentlyContinue) {
				if ($f.Name -like "*.test.ts") { continue }
				$there = Join-Path $deployedScripts $f.Name
				if (-not (Test-Path -LiteralPath $there)) { $stale += "$($f.Name) (missing)"; continue }
				if ((Get-FileHash -LiteralPath $f.FullName).Hash -ne (Get-FileHash -LiteralPath $there).Hash) {
					$stale += $f.Name
				}
			}
			if ($stale.Count -gt 0) {
				Warn "deployed scripts differ from this repo ($($stale.Count) file(s)): $(($stale | Select-Object -First 5) -join ', ')$(if ($stale.Count -gt 5) { ', ...' })"
				Warn "  re-sync with: .\scripts\sync-deploy.ps1 -To '$resolved'"
			} else {
				Ok "deployed scripts match this repo"
			}

			if (-not (Test-Path -LiteralPath (Join-Path $deployedScripts "node_modules"))) {
				Fail "deployed scripts have no node_modules — run `bun install` in $deployedScripts"
				$problems++
			} else { Ok "deployed script deps installed" }
		}

		# Answer-key contamination. CLAUDE.md's hard rule: a raw client must
		# never contain PEAK-export files, or the run censuses the very thing it
		# would later be graded against.
		$keys = Get-ChildItem -LiteralPath $resolved -Directory -Recurse -Depth 2 -Filter "File PEAK import" -ErrorAction SilentlyContinue
		if ($keys) {
			Warn "$($keys.Count) client month(s) still contain 'File PEAK import' (the answer key):"
			$keys | Select-Object -First 5 | ForEach-Object {
				Warn "  $($_.FullName.Substring($resolved.Length + 1))"
			}
			Warn "  do NOT run those months in place — prepare a stripped copy first."
		} else {
			Ok "no answer-key folders in the workspace"
		}
	}

	if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
		Fail "claude not found on PATH"
		$problems++
	} else { Ok "claude on PATH" }

	Write-Host ""
	if ($problems -gt 0 -and -not $Force) {
		Write-Host "Refusing to start with $problems blocking problem(s). Fix them, or re-run with -Force." -ForegroundColor Red
		exit 1
	}
	if ($problems -gt 0) { Warn "starting anyway (-Force)" }
}

# --- environment -----------------------------------------------------------
$env:KSK_CONSOLE_PORT = "$Port"
if ($Real) {
	$env:KSK_ENGINE          = "claude"
	$env:KSK_WORKSPACE_ROOT  = $resolved
	$env:KSK_PERMISSION_MODE = $PermissionMode
	$env:KSK_MAX_BUDGET_USD  = "$MaxBudgetUsd"
	$env:KSK_RUN_BUDGET_USD  = "$RunBudgetUsd"
	if ($Model) { $env:KSK_ENGINE_MODEL = $Model } else { Remove-Item Env:\KSK_ENGINE_MODEL -ErrorAction SilentlyContinue }
} else {
	# Explicitly cleared, not merely unset: these persist for the shell session,
	# so a previous -Real invocation in the same window would otherwise leak
	# KSK_ENGINE=claude into what you asked to be a mock run.
	foreach ($v in "KSK_ENGINE", "KSK_PERMISSION_MODE", "KSK_MAX_BUDGET_USD", "KSK_RUN_BUDGET_USD", "KSK_ENGINE_MODEL") {
		Remove-Item "Env:\$v" -ErrorAction SilentlyContinue
	}
	# Mock mode auto-creates console/demo-workspace when this is unset; only
	# honour an explicitly requested workspace.
	if ($PSBoundParameters.ContainsKey("Workspace")) { $env:KSK_WORKSPACE_ROOT = $resolved }
	else { Remove-Item Env:\KSK_WORKSPACE_ROOT -ErrorAction SilentlyContinue }
}

Write-Host "-> http://127.0.0.1:$Port    (Ctrl+C to stop)" -ForegroundColor Cyan
Write-Host ""
bun console/server.ts
