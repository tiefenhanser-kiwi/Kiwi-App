# R3-2 -- tests for export-web.ps1's post-export step (rename .pnpm, the _redirects
# rewrite rule, the zip). No Pester on this machine, so a plain script: PASS/FAIL
# per assertion, exit 1 on any FAIL.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release\test-export-web.ps1
#
# Touches nothing outside scripts\_scratch\r3-2 (removed at the end unless -Keep).
# Never runs expo: the exit-code cases call export-web.ps1 -PostExportOnly against
# fixture dist\ folders.
#
# ASCII ONLY.

param([switch]$Keep)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'export-web.ps1')
. (Join-Path $PSScriptRoot '_fake-gcloud.ps1')

$scratch = Join-Path $script:RepoRoot 'scripts\_scratch\r3-2'
$exportWeb = Join-Path $PSScriptRoot 'export-web.ps1'
$apiBase = 'https://kiwi-api-fake.us-east4.run.app/api'
$goodRedirects = @(Get-Content -LiteralPath (Join-Path $script:RepoRoot 'artifacts\kiwi\public\_redirects'))

function Write-Text {
  param([string]$Path, [string]$Text)
  New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
  [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# Remove-Item cannot delete the >260-character fixture paths.
function Remove-LongDir { param([string]$Path) [IO.Directory]::Delete('\\?\' + $Path, $true) }

# A dist\ shaped like the real export: a bundle referencing the .pnpm path (and the
# API host, so the existing bundle checks pass), one font under .pnpm, index.html.
function New-FixtureDist {
  param([string]$Name, [string[]]$Redirects, [switch]$Hidden)
  $d = Join-Path $scratch "$Name\dist"
  if (Test-Path -LiteralPath (Split-Path $d)) { Remove-LongDir (Split-Path $d) }
  Write-Text (Join-Path $d 'index.html') '<!DOCTYPE html><html></html>'
  Write-Text (Join-Path $d 'assets\__node_modules\.pnpm\x\a.ttf') 'fake ttf'
  Write-Text (Join-Path $d '_expo\static\js\web\entry-fake.js') ('m.exports={uri:"/assets/__node_modules/.pnpm/x/a.ttf"};m.exports={uri:"/assets/__node_modules/.pnpm/x/b.png"};var base="' + $apiBase + '";')
  if ($Hidden) { Write-Text (Join-Path $d 'assets\.hidden\b.txt') 'hidden' }
  if ($null -ne $Redirects) { Write-Text (Join-Path $d '_redirects') (($Redirects -join "`n") + "`n") }
  return $d
}

Write-Host '== the committed public\_redirects'
Assert-Equal $goodRedirects.Count 2 'two rules'
Assert-True ($goodRedirects[0].Trim() -match $script:RewriteRule) 'line 1 is the .pnpm rewrite'
Assert-True ($goodRedirects[-1].Trim() -match $script:FallbackRule) 'last line is the /* fallback'

Write-Host '== Repair-DistDotSegments: the .pnpm-only fixture'
$d = New-FixtureDist -Name 'good' -Redirects $goodRedirects
$r = Repair-DistDotSegments -Dist $d
$r.Lines | ForEach-Object { Write-Host "    | $_" }
Assert-True $r.Ok 'Ok'
Assert-Equal $r.Found 3 'found .pnpm, .pnpm\x, .pnpm\x\a.ttf'
Assert-True $r.Renamed 'renamed'
Assert-True (Test-Path -LiteralPath (Join-Path $d 'assets\__node_modules\pnpm\x\a.ttf')) 'font now under pnpm\'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $d 'assets\__node_modules\.pnpm'))) '.pnpm gone'
Assert-True ($r.Lines -contains 'dot-segment paths after rename: 0') 'prints dot-segment paths after rename: 0'
Assert-Equal $r.BundleHits 2 'bundle references to the old path counted'

Write-Host '== re-run without --clear: a stale pnpm\ beside a fresh .pnpm'
Write-Text (Join-Path $d 'assets\__node_modules\.pnpm\y\c.ttf') 'fresh'
$r = Repair-DistDotSegments -Dist $d
Assert-True $r.Ok 'Ok'
Assert-True (Test-Path -LiteralPath (Join-Path $d 'assets\__node_modules\pnpm\y\c.ttf')) 'fresh file present'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $d 'assets\__node_modules\pnpm\x\a.ttf'))) 'stale pnpm\ replaced, not merged'

Write-Host '== New-DistZip'
$z = New-DistZip -Dist $d
Assert-Equal $z.Path (Join-Path $scratch 'good\kiwi-web-dist.zip') 'zip lands beside dist\'
Assert-Equal $z.Entries $z.Files 'entry count equals dist\ file count'
Assert-Equal $z.Files 4 'four fixture files'
Assert-Equal $z.Backslash 0 'entry names use /'
Assert-Equal $z.DotEntries 0 'no dot-segment entries'

Write-Host '== New-DistZip: a source path over 260 characters (the real vector-icons fonts)'
$d = New-FixtureDist -Name 'long' -Redirects $goodRedirects
$longDir = Join-Path $d ('assets\__node_modules\.pnpm\' + ('v' * 100) + '\' + ('w' * 50))
[IO.Directory]::CreateDirectory('\\?\' + $longDir) | Out-Null
$longFile = Join-Path $longDir 'FontAwesome5_Brands.3b89dd103490708d19a95adcae52210e.ttf'
[IO.File]::WriteAllText('\\?\' + $longFile, 'long')
Assert-True ($longFile.Length -gt 260) ("fixture path is {0} characters" -f $longFile.Length)
$r = Repair-DistDotSegments -Dist $d
Assert-True $r.Ok 'Ok'
$z = New-DistZip -Dist $d
Assert-Equal $z.Entries 5 'long-path file zipped (5 entries)'
Assert-Equal $z.Entries $z.Files 'entry count equals dist\ file count'
Write-Text (Join-Path $d 'assets\__node_modules\.pnpm\y\c.ttf') 'fresh'
$r = Repair-DistDotSegments -Dist $d
Assert-True ($r.Ok -and -not (Test-Path -LiteralPath (Join-Path $d ('assets\__node_modules\pnpm\' + ('v' * 100))))) 'stale long-path pnpm\ replaced on re-run'

Write-Host '== a second dot-folder (.hidden): refused, nothing renamed'
$d = New-FixtureDist -Name 'hidden' -Redirects $goodRedirects -Hidden
$r = Repair-DistDotSegments -Dist $d
Assert-True (-not $r.Ok) 'not Ok'
Assert-True (($r.Lines -join "`n") -like '*assets\.hidden*') 'names .hidden'
Assert-True (Test-Path -LiteralPath (Join-Path $d 'assets\__node_modules\.pnpm')) '.pnpm left alone'
$x = Invoke-ReleaseScript -Script $exportWeb -Arguments @('-PostExportOnly', '-DistPath', $d, '-ApiBaseUrl', $apiBase)
$x.Lines | ForEach-Object { Write-Host "    | $_" }
Assert-Equal $x.ExitCode 1 'export-web exits 1'
Assert-True ($x.Text -like '*DOT-SEGMENT FAILED*assets\.hidden*') 'export-web names .hidden'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $scratch 'hidden\kiwi-web-dist.zip'))) 'no zip'

Write-Host '== the rewrite rule absent: refused'
$d = New-FixtureDist -Name 'norule' -Redirects @('/*    /index.html   200')
$x = Invoke-ReleaseScript -Script $exportWeb -Arguments @('-PostExportOnly', '-DistPath', $d, '-ApiBaseUrl', $apiBase)
$x.Lines | ForEach-Object { Write-Host "    | $_" }
Assert-Equal $x.ExitCode 1 'export-web exits 1'
Assert-True ($x.Text -like '*REWRITE RULE MISSING*') 'says the rule is missing'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $scratch 'norule\kiwi-web-dist.zip'))) 'no zip'

Write-Host '== the fallback before the rewrite: refused'
$d = New-FixtureDist -Name 'order' -Redirects @($goodRedirects[-1], $goodRedirects[0])
$r = Repair-DistDotSegments -Dist $d
Assert-True (-not $r.Ok -and ($r.Lines -join "`n") -like '*ORDER WRONG*') 'order checked'

Write-Host '== no _redirects at all: refused'
$d = New-FixtureDist -Name 'none' -Redirects $null
$r = Repair-DistDotSegments -Dist $d
Assert-True (-not $r.Ok -and ($r.Lines -join "`n") -like '*REWRITE RULE MISSING*') 'missing file refused'

Write-Host '== whole post-export run on the good fixture'
$d = New-FixtureDist -Name 'whole' -Redirects $goodRedirects
$x = Invoke-ReleaseScript -Script $exportWeb -Arguments @('-PostExportOnly', '-DistPath', $d, '-ApiBaseUrl', $apiBase)
$x.Lines | ForEach-Object { Write-Host "    | $_" }
Assert-Equal $x.ExitCode 0 'export-web exits 0'
Assert-True ($x.Text -like '*dot-segment paths after rename: 0*') 'prints the 0'
Assert-True ($x.Text -like '*4 entries (dist\ has 4 files); backslash names: 0; dot-segment entries: 0*') 'zip line'
Assert-True ($x.Lines[-1] -like 'Export checks pass. Not deployed: drag kiwi-web-dist.zip into Netlify (project unique-semolina-e05761 -> Deploys).') 'final line'

if (-not $Keep) { Remove-LongDir $scratch }
Write-Host ''
if ($script:Failures -gt 0) { Write-Host "FAILED: $($script:Failures)" -ForegroundColor Red; exit 1 }
Write-Host 'ALL PASS'
exit 0
