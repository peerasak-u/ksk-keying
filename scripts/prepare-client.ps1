#Requires -Version 5.1
<#
.SYNOPSIS
  Split a Dropbox (พร้อมทดสอบ) client into a blind-runnable copy + its answer key.

.DESCRIPTION
  The (พร้อมทดสอบ)_* clients are the working set, but they cannot be run where
  they sit: each month carries a "File PEAK import" folder — the known-correct
  PEAK export — and CLAUDE.md treats the Dropbox tree as read-only source that
  pipeline output must never be written into. Running one in place both
  censuses the answer key as source data and dirties the source. (Both of those
  have now happened once, which is why this script exists.)

  So this performs the split CLAUDE.md describes:

    <To>\<client>\<month>\      raw source documents only — point runs here
    <KeysTo>\<client>\<month>\  File PEAK import\ — for grading, AFTER a run

  Excluded from the runnable copy: the answer key, and any generated tree left
  by an earlier run (ข้อมูลระบบ, ตรวจทาน, _pages, _segments, _doc_groups) — a
  "starting state" client is raw input, or the run resumes someone else's work
  instead of reproducing it.

  Kept at the client root: CLIENT.md, coa.csv, coa_usage.json and the ผังบัญชี
  workbook. Those are month-invariant client context, not answers — and without
  a chart of accounts a run hits a hard blocker immediately.

  Dropbox stores these files online-only, so the first copy hydrates them and
  can be slow. Nothing is ever written back to the source.

.EXAMPLE
  .\scripts\prepare-client.ps1 -Client 216
.EXAMPLE
  .\scripts\prepare-client.ps1 -Client 216 -Month 69-03
.EXAMPLE
  .\scripts\prepare-client.ps1 -Client "ฮัก ดีไซน์" -Force
#>
[CmdletBinding()]
param(
	# Folder name or any substring of it — "216", "ชามหวาน", "(พร้อมทดสอบ)_216 บจก.ชามหวาน".
	[Parameter(Mandatory = $true)]
	[string] $Client,
	# One month folder (e.g. 69-03). Omit for every month the client has.
	[string] $Month,
	[string] $From,
	[string] $To,
	[string] $KeysTo,
	# Replace an existing prepared copy instead of refusing.
	[switch] $Force
)

# ==== EDIT ME ============================================================
$DefaultFrom   = "C:\Users\Peerasak\Dropbox\สารบัญงานบัญชี_For Ton"
$DefaultTo     = "C:\Users\Peerasak\Workspace\ksk-clients"
$DefaultKeysTo = "C:\Users\Peerasak\Workspace\ksk-answer-keys"
# =========================================================================

$ErrorActionPreference = "Stop"
if (-not $From)   { $From   = $DefaultFrom }
if (-not $To)     { $To     = $DefaultTo }
if (-not $KeysTo) { $KeysTo = $DefaultKeysTo }

$ANSWER_KEY_DIR = "File PEAK import"      # matched case-insensitively; "File Peak Import" exists too
$GENERATED = @("ข้อมูลระบบ", "ตรวจทาน", "_pages", "_segments", "_doc_groups")
$CONTEXT_FILES = @("CLIENT.md", "coa.csv", "coa_usage.json")

function Ok  ($m) { Write-Host "  ok    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  warn  $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  ERROR $m" -ForegroundColor Red }

if (-not (Test-Path -LiteralPath $From -PathType Container)) {
	Fail "source workspace not found: $From"; exit 1
}

# --- resolve the client ----------------------------------------------------
$candidates = @(Get-ChildItem -LiteralPath $From -Directory | Where-Object { $_.Name -like "*$Client*" })
if ($candidates.Count -eq 0) { Fail "no client folder matching '*$Client*' under $From"; exit 1 }
if ($candidates.Count -gt 1) {
	Fail "'$Client' is ambiguous — matches $($candidates.Count) folders:"
	$candidates | ForEach-Object { Fail "    $($_.Name)" }
	exit 1
}
$srcClient  = $candidates[0]
$clientName = $srcClient.Name
Write-Host "client : $clientName"

# --- resolve the months ----------------------------------------------------
$months = @(Get-ChildItem -LiteralPath $srcClient.FullName -Directory |
	Where-Object { $GENERATED -notcontains $_.Name })
if ($Month) {
	$months = @($months | Where-Object { $_.Name -eq $Month })
	if ($months.Count -eq 0) { Fail "month '$Month' not found under $clientName"; exit 1 }
}
Write-Host "months : $(($months | ForEach-Object { $_.Name }) -join ', ')"
Write-Host "to     : $To\$clientName"
Write-Host "keys   : $KeysTo\$clientName"
Write-Host ""

$dstClient = Join-Path $To $clientName
if ((Test-Path -LiteralPath $dstClient) -and -not $Force) {
	Fail "prepared copy already exists: $dstClient"
	Fail "  Re-run with -Force to replace it (this deletes the prepared copy, never the Dropbox source)."
	exit 1
}
if ((Test-Path -LiteralPath $dstClient) -and $Force) {
	[System.IO.Directory]::Delete($dstClient, $true)
	Warn "replaced existing prepared copy"
}

New-Item -ItemType Directory -Force $dstClient | Out-Null

# robocopy exit codes under 8 are success (0 none, 1 copied, 2 extras, 3 both).
function Invoke-Rc([string[]]$rcArgs, [string]$what) {
	& robocopy @rcArgs | Out-Null
	if ($LASTEXITCODE -ge 8) { Fail "robocopy failed ($LASTEXITCODE) on $what"; return $false }
	return $true
}

$failed = 0

# --- client-root context ---------------------------------------------------
foreach ($f in $CONTEXT_FILES) {
	$src = Join-Path $srcClient.FullName $f
	if (Test-Path -LiteralPath $src) {
		Copy-Item -LiteralPath $src -Destination (Join-Path $dstClient $f) -Force
		Ok "context: $f"
	} else { Warn "context: $f absent at the client root" }
}
# The ผังบัญชี workbook is what coa-to-csv converts from when coa.csv is missing.
foreach ($wb in Get-ChildItem -LiteralPath $srcClient.FullName -File -Filter "*.xls*" -ErrorAction SilentlyContinue) {
	Copy-Item -LiteralPath $wb.FullName -Destination (Join-Path $dstClient $wb.Name) -Force
	Ok "context: $($wb.Name)"
}

# --- months ----------------------------------------------------------------
foreach ($m in $months) {
	$dstMonth = Join-Path $dstClient $m.Name
	# Bare directory NAMES, never full paths — robocopy matches those on both
	# sides, and a full source path would not exclude what it should.
	$xd = @("/XD", $ANSWER_KEY_DIR) + $GENERATED
	$rc = @($m.FullName, $dstMonth, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:2", "/W:2") + $xd
	if (Invoke-Rc $rc "$($m.Name) (source)") { Ok "month: $($m.Name)" } else { $failed++; continue }

	# The answer key goes to its own tree, never next to the runnable copy.
	$srcKey = Get-ChildItem -LiteralPath $m.FullName -Directory -ErrorAction SilentlyContinue |
		Where-Object { $_.Name -eq $ANSWER_KEY_DIR }
	if ($srcKey) {
		$dstKey = Join-Path (Join-Path $KeysTo $clientName) (Join-Path $m.Name $srcKey.Name)
		$rc2 = @($srcKey.FullName, $dstKey, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:2", "/W:2")
		if (Invoke-Rc $rc2 "$($m.Name) (answer key)") { Ok "  answer key -> $KeysTo" } else { $failed++ }
	} else { Warn "  no answer key in $($m.Name)" }
}

# --- verify the split actually held ---------------------------------------
# The whole point of this script is that the runnable copy is clean, so it is
# asserted rather than assumed.
Write-Host ""
Write-Host "verify"
$leaked = @(Get-ChildItem -LiteralPath $dstClient -Recurse -Force -ErrorAction SilentlyContinue |
	Where-Object { $_.Name -like "*PEAK*" -or $_.Name -like "*Peak*" })
if ($leaked) {
	Fail "answer-key material leaked into the runnable copy ($($leaked.Count) item(s)):"
	$leaked | Select-Object -First 5 | ForEach-Object { Fail "    $($_.FullName.Substring($dstClient.Length + 1))" }
	$failed++
} else { Ok "no PEAK material in the runnable copy" }

$genLeft = @(Get-ChildItem -LiteralPath $dstClient -Recurse -Directory -Force -ErrorAction SilentlyContinue |
	Where-Object { $GENERATED -contains $_.Name })
if ($genLeft) {
	Fail "generated trees leaked in: $(($genLeft | ForEach-Object { $_.Name }) -join ', ')"
	$failed++
} else { Ok "no generated trees — this is a starting-state client" }

$srcDocs = @(Get-ChildItem -LiteralPath $dstClient -Recurse -File -Force -ErrorAction SilentlyContinue)
Ok "$($srcDocs.Count) file(s) in the runnable copy"

Write-Host ""
if ($failed -gt 0) { Write-Host "FAILED: $failed problem(s)." -ForegroundColor Red; exit 1 }
Write-Host "Prepared. Run it with:" -ForegroundColor Green
Write-Host "  .\scripts\console.ps1 -Workspace prepared"
Write-Host ""
Write-Host "Grade it afterwards against $KeysTo\$clientName — never before." -ForegroundColor DarkGray
