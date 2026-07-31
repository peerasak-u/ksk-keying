#Requires -Version 5.1
<#
.SYNOPSIS
  Push this repo's skills + agents to a deployed install (e.g. the Dropbox workspace).

.DESCRIPTION
  The Windows equivalent of the rsync pair in CLAUDE.md. Scope is exactly
  .claude/skills/ and .claude/agents/, nothing else:

    * the dev-repo-only skills (ksk-eval, ksk-keying-answer-check) stay out —
      they need the gitignored samples/ tree and are useless in an install;
    * node_modules/ stays out — the install ran `bun install` itself, and
      copying 16MB of it over a synced folder every time is pure churn;
    * nothing outside those two folders is touched, so client folders and the
      install's own .claude/settings.local.json are never at risk.

  The deployed copy is a snapshot and drifts silently — a run there executes
  whatever was last copied, not what is in this repo. Re-run this after any
  skill or script change.

.EXAMPLE
  .\scripts\sync-deploy.ps1                       # to the default target below
.EXAMPLE
  .\scripts\sync-deploy.ps1 -WhatIf               # show what would change
.EXAMPLE
  .\scripts\sync-deploy.ps1 -To "D:\other\install"
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
	[string] $To,
	# Delete files in the destination that no longer exist here (rsync --delete).
	# On by default for skills/ so a removed reference file does not linger.
	[bool]   $Mirror = $true
)

# ==== EDIT ME ============================================================
$DefaultTarget = "C:\Users\Peerasak\Dropbox\สารบัญงานบัญชี_For Ton"
# =========================================================================

# The deployable set. Anything not listed here is dev-repo-only.
$DeployableSkills = @(
	"ksk-keying",
	"ksk-stage-profile",
	"ksk-stage-segment",
	"ksk-stage-interpret",
	"ksk-stage-link",
	"ksk-stage-group",
	"ksk-stage-categorize"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not $To) { $To = $DefaultTarget }

Write-Host "from : $Root"
Write-Host "to   : $To"
Write-Host ""

if (-not (Test-Path -LiteralPath $To -PathType Container)) {
	Write-Host "ERROR target does not exist: $To" -ForegroundColor Red
	exit 1
}

# robocopy exit codes below 8 are success (0 = no change, 1 = files copied,
# 2 = extras removed, 3 = both). 8+ is a real failure.
function Invoke-Robocopy($src, $dst, [string[]]$extra) {
	$args = @($src, $dst, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:2", "/W:2") + $extra
	$out = & robocopy @args 2>&1
	$code = $LASTEXITCODE
	if ($code -ge 8) {
		Write-Host "ERROR robocopy failed ($code) for $src" -ForegroundColor Red
		$out | Select-Object -Last 10 | ForEach-Object { Write-Host "  $_" }
		return $false
	}
	return $true
}

$failed = 0

foreach ($skill in $DeployableSkills) {
	$src = Join-Path $Root ".claude\skills\$skill"
	if (-not (Test-Path -LiteralPath $src)) {
		Write-Host "  skip  $skill (absent here)" -ForegroundColor Yellow
		continue
	}
	$dst = Join-Path $To ".claude\skills\$skill"
	if ($PSCmdlet.ShouldProcess($dst, "sync $skill")) {
		# Bare directory NAMES, never full source paths. Measured, not assumed:
		# `/XD <source>\node_modules` excludes the folder from the COPY but not
		# from `/PURGE`, so robocopy still deleted the destination's
		# node_modules — 16MB and thousands of files, inside a synced Dropbox
		# folder, that the install then has to `bun install` back. A bare name
		# matches on both sides and is genuinely protected.
		$extra = @("/XD", "node_modules", ".runs")
		if ($Mirror) { $extra += "/PURGE" }
		if (Invoke-Robocopy $src $dst $extra) { Write-Host "  ok    $skill" -ForegroundColor Green }
		else { $failed++ }
	}
}

$agentsSrc = Join-Path $Root ".claude\agents"
$agentsDst = Join-Path $To ".claude\agents"
if ($PSCmdlet.ShouldProcess($agentsDst, "sync agents")) {
	# No /PURGE on agents: the install may legitimately carry agents this repo
	# does not ship, and deleting someone else's agent is not this script's call.
	if (Invoke-Robocopy $agentsSrc $agentsDst @()) { Write-Host "  ok    agents" -ForegroundColor Green }
	else { $failed++ }
}

Write-Host ""
if ($failed -gt 0) {
	Write-Host "FAILED: $failed target(s) did not sync." -ForegroundColor Red
	exit 1
}
if ($WhatIfPreference) { Write-Host "(-WhatIf: nothing was written)" -ForegroundColor DarkGray; exit 0 }

# The install ran `bun install` itself and we deliberately did not copy
# node_modules, so a brand-new install still needs its deps.
$deployedScripts = Join-Path $To ".claude\skills\ksk-keying\scripts"
if (-not (Test-Path -LiteralPath (Join-Path $deployedScripts "node_modules"))) {
	Write-Host "NOTE the deployed scripts have no node_modules yet. Run once:" -ForegroundColor Yellow
	Write-Host "  Push-Location '$deployedScripts'; bun install; Pop-Location"
} else {
	Write-Host "Synced. Deployed scripts already have their deps." -ForegroundColor Green
}
