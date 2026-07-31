# ksk-keying install — native Windows / PowerShell.
#
# Mirror of scripts/install.sh. Kept as a separate script rather than a shared
# bun one because it also has to run BEFORE we know Bun exists; keep the two
# dumb and near-identical so they cannot drift.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root

Write-Host "==> ksk-keying install"

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
	Write-Host "ERROR: Bun is required. Install it, then re-run this script:"
	Write-Host "  irm bun.sh/install.ps1 | iex"
	Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\install.ps1"
	exit 1
}

if (-not (Test-Path ".claude\skills\ksk-keying\SKILL.md")) {
	Write-Host "ERROR: Missing .claude\skills\ksk-keying\SKILL.md"
	exit 1
}

$AgentCount = (Get-ChildItem ".claude\agents" -Filter "ksk-*.md" -ErrorAction SilentlyContinue | Measure-Object).Count
if ($AgentCount -lt 6) {
	Write-Host "ERROR: Expected 6 ksk-* agents in .claude\agents\ (found $AgentCount)"
	exit 1
}

Write-Host "==> Installing Bun dependencies (.claude\skills\ksk-keying\scripts)"
Push-Location ".claude\skills\ksk-keying\scripts"
bun install
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
Pop-Location

# console/ has its own package.json (xlsx, yaml). Without this the review app
# dies on boot with `Cannot find package "xlsx"`.
Write-Host "==> Installing Bun dependencies (console)"
Push-Location "console"
bun install
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
Pop-Location

# Native tools the pipeline shells out to. Reported, not installed — both need
# an explicit operator decision about where they live on PATH.
Write-Host ""
Write-Host "==> Native dependencies"
foreach ($cmd in @("pdfinfo", "pdftoppm", "pdfimages", "pdftotext")) {
	if (Get-Command $cmd -ErrorAction SilentlyContinue) {
		Write-Host "  ok   $cmd"
	} else {
		Write-Host "  MISS $cmd - install Poppler for Windows and add its Library\bin to PATH:"
		Write-Host "         winget install oschwartz10612.Poppler"
	}
}
if (Get-Command claude -ErrorAction SilentlyContinue) {
	$claudePath = (Get-Command claude).Source
	Write-Host "  ok   claude ($claudePath)"
	if ($claudePath -notmatch '\.exe$') {
		Write-Host "       WARNING: this is a shim, not a real .exe. Bun cannot spawn it directly."
		Write-Host "       Install the native build instead: irm https://claude.ai/install.ps1 | iex"
	}
} else {
	Write-Host "  MISS claude - install with: irm https://claude.ai/install.ps1 | iex"
}

Write-Host ""
Write-Host "Done. Start Claude Code from this folder:"
Write-Host "  cd `"$Root`""
Write-Host "  claude"
Write-Host ""
Write-Host "Then run: /ksk-keying"
Write-Host ""
Write-Host "Or start the review app (see console/README.md):"
Write-Host "  `$env:KSK_WORKSPACE_ROOT = `"C:\path\to\workspace`""
Write-Host "  cd console; bun run app/server.ts"
