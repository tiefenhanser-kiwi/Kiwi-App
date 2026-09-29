# [grocery] B2 Part D -- THE DELIBERATE BREAKS.
#
# Each one: hash the file, make ONE edit that violates a ruling, run the test
# file, require a FAILURE, restore, and prove the restore by hash.
#
# A break that does NOT turn red is the finding -- it means the rule is asserted
# by nothing.
#
# ASCII ONLY, deliberately: Windows PowerShell 5.1 reads a UTF-8 file with no BOM
# as ANSI, and a single non-ASCII character here is a parser error rather than a
# mojibake warning.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/grocery-b2/breaks.ps1

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
$env:TZ = "UTC"

$script:results = @()

function Get-Sha([string]$p) { (certutil -hashfile $p SHA256 | Select-Object -Index 1).Trim() }

function Run-Break {
  param([string]$Name, [string]$File, [string]$From, [string]$To, [string]$Test, [string]$Rule)

  $before = Get-Sha $File
  $text = [IO.File]::ReadAllText($File)
  $f = $From; $t = $To
  if (-not $text.Contains($f)) {
    $f = $From.Replace("`r`n", "`n"); $t = $To.Replace("`r`n", "`n")
  }
  if (-not $text.Contains($f)) { throw "ANCHOR NOT FOUND in $File for break '$Name'" }
  [IO.File]::WriteAllText($File, $text.Replace($f, $t))
  $broken = Get-Sha $File
  if ($before -eq $broken) { throw "break '$Name' changed nothing" }

  $out = & node --env-file=.env --import tsx --test $Test 2>&1 | Out-String
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

$REL   = "src/lib/ingredientRelations.ts"
$CASE  = "src/lib/ingredientNameCase.ts"
$PAY   = "src/lib/retailers/instacartPayload.ts"
$NAME  = "src/lib/retailers/instacartName.ts"
$RIDER = "src/lib/groceryVarietyRider.ts"
$AI    = "src/lib/groceryListAI.ts"
$CLS   = "src/lib/subsumesClasses.ts"

$T     = "src/lib/__tests__/groceryNames.test.ts"
$TAI   = "src/lib/__tests__/groceryListAI.test.ts"
$TREL  = "src/lib/__tests__/ingredientRelations.test.ts"

# 1 -- THE LINE TAKES THE SPECIFIC NAME. R5's one hard rule, and the thing the
#      whole pin exists to prevent: shortest-wins would name a pepper line
#      "green bell pepper".
Run-Break -Name "1. the line takes the specific name" -File $REL -Test $T `
  -Rule "R5 / H3: the line takes the GENERIC and is never renamed to the specific" `
  -From "    const pin = members.map((m) => pinned.get(m)).find((t) => t !== undefined);" `
  -To   "    const pin: string | undefined = undefined;"

# 2 -- THE VETO BYPASSED FOR SUBSUMES. Admit the fold without the cluster check
#      ever seeing it, by skipping the union for the vetoed cluster's members.
Run-Break -Name "2. the veto bypassed for subsumes" -File $REL -Test $T `
  -Rule "D-WS9-217 PERMANENT: coarse kosher salt is not kosher salt, by any route" `
  -From "  for (const f of subsumesFolds) {`r`n    union(f.target, f.member);" `
  -To   "  for (const f of subsumesFolds) {`r`n    parent.set(f.member, f.target);"

# 3 -- CASING APPLIED TO A PROPER NOUN. The exception list stops being consulted.
Run-Break -Name "3. casing applied to a proper noun" -File $CASE -Test $T `
  -Rule "BUG-323: Frank's RedHot, San Marzano and Thai keep their capital" `
  -From "  if (LEADS.has(lead)) return displayName;" `
  -To   "  void lead;"

# 4 -- THE RESIDUE CHECK REMOVED. Always append the name, which is the state the
#      live list shipped: "1 rotisserie chicken rotisserie chicken, meat shredded".
Run-Break -Name "4. the residue check removed" -File $PAY -Test $T `
  -Rule "BUG-160: the pack's own words are not printed twice" `
  -From "  if (containsSeq(r, nm)) return packLine;" `
  -To   "  if (false) return packLine;"

# 4b -- and the OTHER direction, which is the shape the shipped endsWith() missed.
Run-Break -Name "4b. the name-absorbs direction removed" -File $PAY -Test $T `
  -Rule "BUG-160: a name that OPENS with the residue prints once, not twice" `
  -From "  if (nm.length > r.length && containsSeq(nm.slice(0, r.length), r)) {" `
  -To   "  if (false && nm.length > r.length && containsSeq(nm.slice(0, r.length), r)) {"

# 5 -- WALK-ORDER PARENT CHOICE RESTORED. Drop both rule 1 and rule 2 and let the
#      index's alphabetical order decide, which is the pre-BUG-251 behaviour.
Run-Break -Name "5. walk-order parent choice restored" -File $REL -Test $TREL `
  -Rule "BUG-251 + B2 rule 2: a parent already on the list, then the most specific" `
  -From "  const walk = index.componentParents`r`n    .slice()`r`n    .sort(`r`n      (a, b) =>`r`n        Number(onList(b)) - Number(onList(a)) || specificity(b) - specificity(a),`r`n    );" `
  -To   "  const walk = index.componentParents.slice();"

# 5b -- rule 2 ALONE removed, so the regression is not masked by rule 1.
Run-Break -Name "5b. rule 2 (most specific) removed" -File $REL -Test $T `
  -Rule "B2: the most specific parent takes the child when neither is on the list" `
  -From "        Number(onList(b)) - Number(onList(a)) || specificity(b) - specificity(a)," `
  -To   "        Number(onList(b)) - Number(onList(a))," `

# 6 -- THE INSTACART NAME CARRIES THE QUALIFIER. Stop stripping the trailing
#      prep clause, which is what silently keeps the rider out of the search term.
Run-Break -Name "6. the Instacart name carries the qualifier" -File $NAME -Test $T `
  -Rule "H7: a search term is a product, not a constraint" `
  -From "  const cleaned = tidy(stripPrepClauses(stripParentheticals(stripPackPrefix(source))));" `
  -To   "  const cleaned = tidy(stripParentheticals(stripPackPrefix(source)));"

# 7 -- A FOLD WITH NO GENERIC DEMAND AND NO DEFAULT. H3's gate deleted: every
#      specific folds onto its generic whether a recipe asked for it or not,
#      which is the 7-into-1 onion under-order the audit found.
Run-Break -Name "7. a fold with no generic demand and no default" -File $REL -Test $T `
  -Rule "H3: only when a recipe demanded the generic itself; else H1 stands" `
  -From "  if (!overlay.demanded.has(generic)) {`r`n    return {`r`n      kind: `"decline`",`r`n      reason: `"h3-generic-not-demanded`",`r`n      detail: ``no recipe demanded `"`${generic}`", so H1 stands``,`r`n    };`r`n  }" `
  -To   "  // H3's generic gate deleted"

# 8 -- A FOLDED GROUP KEEPS A MEMBER'S PACK COUNT. The f5556c19 onions are the
#      fixture: the pack must come from the SUMMED demand, never from whichever
#      member won the name (BUG-209, and H6's "the arithmetic runs on the group
#      total").
Run-Break -Name "8. a folded group keeps a member's pack count" -File $AI -Test $TAI `
  -Rule "BUG-209 / H6: the pack is derived from the group total, not inherited" `
  -From "  const pack = resolvePurchaseFields(item, groupConv);`r`n  const built: GenerateListOutputItem = {" `
  -To   "  const pack = { purchaseUnit: item.purchaseUnit, purchaseQuantity: item.purchaseQuantity, purchaseDisplay: item.purchaseDisplay };`r`n  const built: GenerateListOutputItem = {"

# 9 -- AN "at least" WITH A MEASURE. Gate 2: state the share in the variety's own
#      unit rather than in whole buy-units, and the line reads
#      "3 lb ground beef, at least 1 lb 80/20".
Run-Break -Name "9. an 'at least' with a measure" -File $AI -Test $TAI `
  -Rule "H3 / H5: shares are whole units of the buy unit, never a measure" `
  -From "    const n = buyUnitsForNeed(sh.need, sh.unit, out.purchaseUnit, out.purchaseQuantity, conv);" `
  -To   "    const n: number | null = sh.need;"

# 10 -- THE H7 SPLIT LOST. One retailer item called "bell peppers" and the
#       picker has no way to know two of them must be red.
Run-Break -Name "10. the H7 split lost" -File $RIDER -Test $T `
  -Rule "H7: an H3 line is sent as SEPARATE items; the display line stays one line" `
  -From "  if (shares.length === 0) return [{ name: displayName, quantity: Math.max(1, Math.round(totalCount)) }];" `
  -To   "  return [{ name: displayName, quantity: Math.max(1, Math.round(totalCount)) }];"

# 11 -- "boneless skinless" STRIPPED FROM A SEARCH TERM. A cut is part of the
#       product; stripping it searches for the wrong meat.
#
# THE FIRST ATTEMPT AT THIS BREAK DID NOT TURN RED, AND THAT IS ABOUT THE BREAK.
# It added "boneless" and "skinless" to PREP_WORDS -- but stripPrepClauses only
# drops a trailing clause AFTER A COMMA, and "boneless skinless chicken thighs"
# has none, so the edit was a no-op on the very input it was meant to damage. A
# break that cannot reach the behaviour proves nothing about the assertion. This
# one strips the words where they actually live.
Run-Break -Name "11. boneless skinless stripped from a search term" -File $NAME -Test $T `
  -Rule "H7: a search term keeps every word that makes a different product" `
  -From "function tidy(s: string): string {`r`n  return s" `
  -To   "function tidy(s: string): string {`r`n  return s.replace(/(boneless|skinless|bone-in|skin-on)/g, \" \")"

Write-Host ""
Write-Host "================ SUMMARY ================"
$script:results | Format-Table -AutoSize Break, Red, Failures, Restored
$notRed = @($script:results | Where-Object { -not $_.Red })
$notRestored = @($script:results | Where-Object { -not $_.Restored })
Write-Host ("breaks: {0}   red: {1}   restored: {2}" -f $script:results.Count, (@($script:results | Where-Object { $_.Red }).Count), (@($script:results | Where-Object { $_.Restored }).Count))
if ($notRed.Count -gt 0) {
  Write-Host ""
  Write-Host "*** THESE BREAKS DID NOT TURN RED:"
  $notRed | ForEach-Object { Write-Host ("    " + $_.Break + "  --  " + $_.Rule) }
}
if ($notRestored.Count -gt 0) { throw "SOME FILES WERE NOT RESTORED" }
