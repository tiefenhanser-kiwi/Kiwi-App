# [grocery] B1 Part D -- THE DELIBERATE BREAKS.
#
# Each one: hash the file, make ONE edit that violates a ruling, run the test
# file, require a FAILURE, restore, and prove the restore by hash.
#
# A break that does NOT turn red is the finding -- it means the rule is asserted
# by nothing.
#
# ASCII ONLY, deliberately: Windows PowerShell 5.1 reads a UTF-8 file with no BOM
# as ANSI, and a single non-ASCII character here is a parser error, not a
# mojibake warning.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/grocery-b1/breaks.ps1

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
$env:TZ = "UTC"

$script:results = @()

function Get-Sha([string]$p) { (certutil -hashfile $p SHA256 | Select-Object -Index 1).Trim() }

function Run-Break {
  param([string]$Name, [string]$File, [string]$From, [string]$To, [string]$Test, [string]$Rule)

  $before = Get-Sha $File
  $text = [IO.File]::ReadAllText($File)
  # These files are LF; the harness accepts either so an anchor written with
  # Windows line endings still matches. (Row 13 B2's note: CRLF is a real hazard
  # in this repo's mixed tree.)
  $f = $From; $t = $To
  if (-not $text.Contains($f)) {
    $f = $From.Replace("`r`n", "`n"); $t = $To.Replace("`r`n", "`n")
  }
  if (-not $text.Contains($f)) { throw "ANCHOR NOT FOUND in $File for break '$Name'" }
  [IO.File]::WriteAllText($File, $text.Replace($f, $t))
  $broken = Get-Sha $File
  if ($before -eq $broken) { throw "break '$Name' changed nothing" }

  $out = & node --import tsx --test $Test 2>&1 | Out-String
  $failCount = -1
  foreach ($line in ($out -split "`n")) {
    if ($line -match 'fail (\d+)\s*$') { $failCount = [int]$Matches[1]; break }
  }
  $red = $failCount -gt 0

  [IO.File]::WriteAllText($File, $text)
  $restored = Get-Sha $File
  $ok = $restored -eq $before

  $script:results += [pscustomobject]@{
    Break = $Name; Red = $red; Failures = $failCount; Restored = $ok; Sha = $before; Rule = $Rule
  }

  Write-Host ""
  Write-Host "=== $Name ==="
  Write-Host "  rule:     $Rule"
  Write-Host "  file:     $File"
  Write-Host "  sha256:   $before"
  Write-Host "  broken:   $broken"
  Write-Host "  RED:      $red  ($failCount failing)"
  Write-Host "  restored: $ok   sha $restored"
  if (-not $red) { Write-Host "  *** THE BREAK DID NOT TURN RED -- the rule is asserted by nothing." }
  if (-not $ok) { throw "RESTORE FAILED for $File" }
}

$CONV = "src/lib/ingredientConversions.ts"
$REL  = "src/lib/ingredientRelations.ts"
$T    = "src/lib/__tests__/packYield.test.ts"
$TREL = "src/lib/__tests__/ingredientRelations.test.ts"

# 1 -- the forgiveness applied to a CAN. A jar of brine does not wilt.
Run-Break -Name "1. forgiveness on a can/jar" -File $CONV -Test $T `
  -Rule "D-WS9-280: the forgiveness is for something that WILTS" `
  -From 'return canonicalUnitToken(purchaseUnit) === PACK_FORGIVENESS_UNIT;' `
  -To   'return ["bunch", "jar", "can"].includes(canonicalUnitToken(purchaseUnit));'

# 2 -- floor instead of ceil. Under-buying is never acceptable.
Run-Break -Name "2. floor instead of ceil" -File $CONV -Test $T `
  -Rule "R2 rule 2: sum in purchase units, ceil to whole packs, NEVER under-buy" `
  -From 'return Math.max(1, whole + 1);' `
  -To   'return Math.max(1, whole);'

# 3 -- a part becomes its own line: stop absorbing the rows it pooled.
Run-Break -Name "3. a part renders its own line" -File $REL -Test $T `
  -Rule "D-WS9-225: tops are part of the bulb and come with it" `
  -From "      for (const r of rows) {`r`n        absorbed.add(r);" `
  -To   "      for (const r of rows) {`r`n        void r;"

# 4a -- the parent is the edge's FROM by definition. Reversing it inverts the
#       arithmetic; the schema says so in as many words.
Run-Break -Name "4a. parent by reversed edge direction" -File $REL -Test $T `
  -Rule "D-WS9-220: pooling keeps the PARENT by definition, not by name length" `
  -From "    const p = groupKey(row.fromCanonicalName);`r`n    const c = groupKey(row.toCanonicalName);" `
  -To   "    const p = groupKey(row.toCanonicalName);`r`n    const c = groupKey(row.fromCanonicalName);"

# 4b -- the buy line renders the CHILD noun instead of the parent:
#       "3 cloves" where D-WS9-220 requires "3 heads".
Run-Break -Name "4b. buy line renders the child, not the parent" -File $CONV -Test $T `
  -Rule "D-WS9-220: render the PARENT on the buy line, never the child" `
  -From 'purchaseDisplay: renderPackDisplay(n, parent, opts?.storedDisplay ?? conv.purchaseDisplay ?? null),' `
  -To   'purchaseDisplay: renderPackDisplay(n, conv.subUnit.childUnit ?? parent, null),'

# 5 -- delete the per-edge never-fold veto.
Run-Break -Name "5. never-fold veto deleted" -File $REL -Test $T `
  -Rule "D-WS9-217, PERMANENT: coarse kosher salt is not kosher salt" `
  -From 'if (NEVER_FOLD_PAIRS.has(k)) return "never-fold-ruling";' `
  -To   '// veto deleted'

# 5b -- and the CLUSTER-level veto, which is the half that catches a third name.
Run-Break -Name "5b. cluster veto deleted" -File $REL -Test $T `
  -Rule "D-WS9-217: a cluster containing a forbidden pair is refused WHOLE" `
  -From 'if (vetoed) {' `
  -To   'if (false as boolean && vetoed) {'

# 6 -- Hans, September 28: a HEAD-SOLD item never gets the forgiveness.
Run-Break -Name "6. forgiveness on a head-sold item" -File $CONV -Test $T `
  -Rule "Hans Sept 28: garlic, onions, cabbage and citrus keep for weeks" `
  -From 'export const PACK_FORGIVENESS_UNIT = "bunch";' `
  -To   'export const PACK_FORGIVENESS_UNIT = "head";'

Write-Host ""
Write-Host "=== SUMMARY ==="
$script:results | Format-Table Break, Red, Failures, Restored -AutoSize | Out-String -Width 200 | Write-Host
$notRed = @($script:results | Where-Object { -not $_.Red })
if ($notRed.Count -gt 0) {
  Write-Host "*** $($notRed.Count) break(s) did not turn red:"
  $notRed | ForEach-Object { Write-Host ("    " + $_.Break) }
  exit 1
}
Write-Host ("all " + $script:results.Count + " breaks turned red and every file restored to its original sha256.")
