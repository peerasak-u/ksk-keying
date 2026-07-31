# Dependencies only — the Windows sibling of install.sh. Everything that
# VERIFIES the install lives in doctor.ps1; run that afterwards.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "==> ksk-keying install (dependencies)"

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
	Write-Host "ERROR: Bun is required. Install from https://bun.sh then re-run:" -ForegroundColor Red
	Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\install.ps1"
	exit 1
}

Write-Host "--> .claude/skills/ksk-keying/scripts"
Push-Location ".claude\skills\ksk-keying\scripts"
try { bun install; if ($LASTEXITCODE -ne 0) { throw "bun install failed in skill scripts" } }
finally { Pop-Location }

# The console is dev/ops tooling, not part of the shipped skill (CLAUDE.md's
# deployable set is .claude/skills + .claude/agents only), so a customer install
# legitimately has no console\ at all. When it IS present its deps are not
# optional: yaml and xlsx are runtime imports of sequencer\interpret-executor.ts
# and app\xlsx-preview.ts, not just the Tailwind CLI.
if (Test-Path "console") {
	Write-Host "--> console"
	Push-Location "console"
	try { bun install; if ($LASTEXITCODE -ne 0) { throw "bun install failed in console" } }
	finally { Pop-Location }
} else {
	Write-Host "--> console (absent - skipped)"
}

Write-Host ""
Write-Host "Dependencies installed. Now verify:"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\doctor.ps1"
