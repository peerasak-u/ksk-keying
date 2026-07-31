# Verifies that a clone can actually complete a run — the Windows sibling of
# doctor.sh. Deliberately NOT part of install.ps1: the failures this catches are
# the ones that otherwise surface hours into a paid run against a real client
# month.
#
# Two failure shapes it exists to prevent:
#   * A missing Poppler. pdfinfo/pdftoppm are hard requirements (Stage 0's page
#     census, Stage 2's rendering). Without them a run sets up fine, spends
#     money, and dies mid-pipeline.
#   * A toolchain that imports but cannot resolve its own paths. The scripts
#     compute TOOL_DIR at module load; a bad value does not throw there, it
#     throws later when a prompt file is read. So this ends by actually RUNNING
#     one bundled script and checking it produced its artifact.
#
# Exit 0 = ready. Exit 1 = at least one ERROR. Warnings never fail the run.
#
#   powershell -ExecutionPolicy Bypass -File scripts\doctor.ps1

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$script:Errors = 0
$script:Warnings = 0
function Ok   ($m) { Write-Host "  ok    $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  warn  $m" -ForegroundColor Yellow; $script:Warnings++ }
function Err  ($m) { Write-Host "  ERROR $m" -ForegroundColor Red;    $script:Errors++ }

function ToolVersion($name, $arg) {
	try { (& $name $arg 2>&1 | Select-Object -First 1) -replace '^[^0-9]*', '' } catch { "" }
}

Write-Host "==> ksk-keying doctor"

Write-Host "[1/5] tools"
if (Get-Command bun -ErrorAction SilentlyContinue) { Ok "bun $(ToolVersion bun '--version')" }
else { Err "bun not found - https://bun.sh" }

# Needed to RUN, not to install, so a clone being prepped for another machine is
# not broken by its absence.
if (Get-Command claude -ErrorAction SilentlyContinue) { Ok "claude $(ToolVersion claude '--version')" }
else { Warn "claude not found - required to run /ksk-keying (https://code.claude.com)" }

foreach ($tool in @("pdfinfo", "pdftoppm")) {
	if (Get-Command $tool -ErrorAction SilentlyContinue) {
		Ok "$tool $(ToolVersion $tool '-v')"
	} else {
		Err "$tool not found - Poppler is required by Stage 0 (page census) and Stage 2 (rendering). Install: winget install oschwartz10612.Poppler   (then reopen the shell)"
	}
}

Write-Host "[2/5] skills"
if (Test-Path ".claude\skills\ksk-keying\SKILL.md") { Ok "ksk-keying (orchestrator)" }
else { Err "missing .claude\skills\ksk-keying\SKILL.md" }

# Named explicitly rather than counted: a count silently passes a tree that has
# the right NUMBER of the wrong things, which is how the old `-lt 6` check kept
# passing after a seventh agent was added.
foreach ($stage in @("profile", "segment", "interpret", "link", "group", "categorize")) {
	if (Test-Path ".claude\skills\ksk-stage-$stage\SKILL.md") { Ok "ksk-stage-$stage" }
	else { Err "missing .claude\skills\ksk-stage-$stage\SKILL.md" }
}

Write-Host "[3/5] agents"
foreach ($agent in @("magnum", "columbo", "watson", "sherlock", "marple", "poirot", "lestrade")) {
	if (Test-Path ".claude\agents\ksk-$agent.md") { Ok "ksk-$agent" }
	else { Err "missing .claude\agents\ksk-$agent.md" }
}

Write-Host "[4/5] dependencies"
if (Test-Path ".claude\skills\ksk-keying\scripts\node_modules") { Ok "skill scripts deps" }
else { Err "skill scripts deps missing - run: powershell -ExecutionPolicy Bypass -File scripts\install.ps1" }

if (Test-Path "console") {
	if (Test-Path "console\node_modules") { Ok "console deps" }
	else { Err "console deps missing (yaml/xlsx are runtime imports, not just Tailwind) - run: powershell -ExecutionPolicy Bypass -File scripts\install.ps1" }
}

Write-Host "[5/5] smoke test - a bundled script must run and produce its artifact"
if ((Get-Command bun -ErrorAction SilentlyContinue) -and (Test-Path ".claude\skills\ksk-keying\scripts\node_modules")) {
	$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ksk-doctor-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))
	New-Item -ItemType Directory -Force $tmp | Out-Null
	try {
		Set-Content -Path (Join-Path $tmp "sample.txt") -Value "smoke"
		bun run --cwd .claude\skills\ksk-keying\scripts inventory -- --json $tmp *> $null
		# Searched rather than matched against the literal Thai path: this file
		# must stay readable under Windows PowerShell 5.1, which misdecodes
		# non-ASCII source unless the .ps1 carries a BOM.
		$artifact = Get-ChildItem -Path $tmp -Recurse -Filter "inventory.yaml" -ErrorAction SilentlyContinue | Select-Object -First 1
		if ($artifact) { Ok "inventory ran and wrote $($artifact.Name) under the machinery tree" }
		else { Err "inventory failed to produce its artifact - the bundled scripts cannot resolve their own paths on this host" }
	} finally {
		Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
	}
} else {
	Warn "smoke test skipped (needs bun + installed deps)"
}

Write-Host ""
if ($script:Errors -gt 0) {
	Write-Host "FAILED: $($script:Errors) error(s), $($script:Warnings) warning(s). Fix the errors above before running /ksk-keying." -ForegroundColor Red
	exit 1
}
Write-Host "Ready: 0 errors, $($script:Warnings) warning(s)." -ForegroundColor Green
Write-Host "Start Claude Code from this folder and run: /ksk-keying"
exit 0
