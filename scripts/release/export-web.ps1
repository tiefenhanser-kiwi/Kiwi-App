# R3-1 Part C -- the Test Kitchen web export for app.kitchenwizard.ai. Builds
# artifacts\kiwi\dist and kiwi-web-dist.zip; does NOT deploy (drag the zip into Netlify).
#
#   .\scripts\release\export-web.ps1
#
# EXPO_PUBLIC_API_BASE_URL is set to the production API for THIS process only --
# the export bakes the base URL into the bundle (and Metro caches it, hence
# --clear). Shell values beat .env files in Expo's loader, so a dev
# EXPO_PUBLIC_API_BASE_URL in artifacts\kiwi\.env cannot leak in. The other public
# values (Turnstile site key, Google web client, Apple Services ID + redirect URI)
# come from artifacts\kiwi\.env at export time; this prints which of the nine
# names were present -- names only.
#
# After the export: dist\ file count, whether _redirects made it into dist\ (the
# September 27 export had none -- every client route 404'd on a hard refresh),
# and a grep of the JS bundle: the production API host must be there, a LAN
# address and the localhost:3000 dev fallback must not.
#
# R3-2: Netlify drops every path with a dot-prefixed segment from drag-and-drop,
# zip and CLI deploys. Expo puts every node_modules asset (the @expo-google-fonts
# .ttf files, react-navigation's icons) under dist\assets\__node_modules\.pnpm, so
# the live site served index.html for each of them. After the export this renames
# .pnpm -> pnpm, requires the _redirects rule that rewrites the old URLs (the
# bundle still references them) onto the renamed folder, and zips dist\ with
# ZipFile (Compress-Archive skips hidden items) into artifacts\kiwi\kiwi-web-dist.zip.
# Any OTHER dot-segment in dist\ fails the export: a new case needs its own rule.
#
#   .\scripts\release\export-web.ps1 -PostExportOnly   # re-run the post-step on an existing dist\
#
# ASCII ONLY (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).

[CmdletBinding()]
param(
  [string]$ApiBaseUrl = 'https://kiwi-api-166146829159.us-east4.run.app/api',
  [switch]$PostExportOnly,
  [string]$DistPath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_release-lib.ps1')

# --- R3-2 post-export step (dot-sourced by test-export-web.ps1) ----------------------

$script:PnpmRel = 'assets\__node_modules\.pnpm'
$script:RewriteRule = '^/assets/__node_modules/\.pnpm/\*\s+/assets/__node_modules/pnpm/:splat\s+200$'
$script:FallbackRule = '^/\*\s+/index\.html\s+200$'

# Relative paths under $Dist with a segment starting with '.', files and directories.
function Get-DotSegmentPaths {
  param([Parameter(Mandatory = $true)][string]$Dist)
  $root = (Resolve-Path -LiteralPath $Dist).Path.TrimEnd('\') + '\'
  @(Get-ChildItem -LiteralPath $Dist -Recurse -Force |
    ForEach-Object { $_.FullName.Substring($root.Length) } |
    Where-Object { @($_ -split '\\' | Where-Object { $_.StartsWith('.') }).Count -gt 0 })
}

# Steps 1-4: find dot-segments, rename .pnpm -> pnpm, re-check, count the bundle's
# references to the old path, require the rewrite rule. Changes nothing unless the
# only dot-segment is the one .pnpm. Returns Ok + the lines to print.
function Repair-DistDotSegments {
  param([Parameter(Mandatory = $true)][string]$Dist)
  $lines = New-Object System.Collections.Generic.List[string]
  $result = [pscustomobject]@{ Ok = $false; Lines = $lines; Found = 0; Renamed = $false; BundleHits = 0 }

  $found = @(Get-DotSegmentPaths -Dist $Dist)
  $result.Found = $found.Count
  $other = @($found | Where-Object {
    $segs = @($_ -split '\\')
    $dots = @(for ($i = 0; $i -lt $segs.Count; $i++) { if ($segs[$i].StartsWith('.')) { ($segs[0..$i]) -join '\' } })
    -not ($dots.Count -eq 1 -and $dots[0] -eq $script:PnpmRel)
  })
  $lines.Add(("dot-segment paths in dist\: {0}{1}" -f $found.Count, $(if ($found.Count -gt 0 -and $other.Count -eq 0) { " (all under $script:PnpmRel)" } else { '' })))
  if ($other.Count -gt 0) {
    $lines.Add('DOT-SEGMENT FAILED - Netlify would drop these and there is no rule for them:')
    $other | ForEach-Object { $lines.Add("  $_") }
    return $result
  }

  $from = Join-Path $Dist $script:PnpmRel
  if (Test-Path -LiteralPath $from) {
    $to = Join-Path (Split-Path $from) 'pnpm'
    # \\?\: Remove-Item cannot delete the >260-character font paths under it.
    if (Test-Path -LiteralPath $to) { [IO.Directory]::Delete('\\?\' + (Resolve-Path -LiteralPath $to).Path, $true) }
    Rename-Item -LiteralPath $from -NewName 'pnpm'
    $result.Renamed = $true
    $lines.Add("renamed $script:PnpmRel -> assets\__node_modules\pnpm")
  }
  $after = @(Get-DotSegmentPaths -Dist $Dist)
  $lines.Add(("dot-segment paths after rename: {0}" -f $after.Count))
  if ($after.Count -gt 0) { $after | ForEach-Object { $lines.Add("  $_") }; return $result }

  $bundles = @(Get-ChildItem -LiteralPath (Join-Path $Dist '_expo\static\js\web') -Filter *.js -ErrorAction SilentlyContinue)
  $js = ($bundles | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`n"
  $result.BundleHits = [regex]::Matches($js, '__node_modules/\.pnpm/').Count
  $lines.Add(("bundle references to __node_modules/.pnpm/ (served by the rewrite): {0}" -f $result.BundleHits))

  $redirects = Join-Path $Dist '_redirects'
  $rules = @()
  if (Test-Path -LiteralPath $redirects) {
    $rules = @([IO.File]::ReadAllLines($redirects) | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') })
  }
  $rw = -1; $fb = -1
  for ($i = 0; $i -lt $rules.Count; $i++) {
    if ($rw -lt 0 -and $rules[$i] -match $script:RewriteRule) { $rw = $i }
    if ($rules[$i] -match $script:FallbackRule) { $fb = $i }
  }
  if ($rw -lt 0) { $lines.Add('_redirects REWRITE RULE MISSING (/assets/__node_modules/.pnpm/*  ->  pnpm/:splat  200) - the renamed assets would 404'); return $result }
  if ($fb -ne $rules.Count - 1 -or $rw -gt $fb) { $lines.Add('_redirects ORDER WRONG - the .pnpm rewrite must come before the /* fallback, and the fallback must be last'); return $result }
  $lines.Add('_redirects in dist\: .pnpm rewrite (first) + /* fallback (last)')
  $result.Ok = $true
  return $result
}

# Step 5: zip dist\ (its contents at the zip root) next to it. Returns path + counts.
function New-DistZip {
  param([Parameter(Mandatory = $true)][string]$Dist)
  # Not ZipFile.CreateFromDirectory: under Windows PowerShell 5.1 (.NET Framework)
  # it writes entry names with '\', which Netlify's Linux unzip reads as one flat
  # file name ("assets\__node_modules\...") at the root. Entry by entry, with '/'.
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $root = (Resolve-Path -LiteralPath $Dist).Path.TrimEnd('\')
  $zip = Join-Path (Split-Path $root) 'kiwi-web-dist.zip'
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  # The \\?\ prefix: the vector-icons font paths under pnpm\ pass 260 characters.
  $archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($f in @(Get-ChildItem -LiteralPath $root -Recurse -File -Force)) {
      $name = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, ('\\?\' + $f.FullName), $name, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  } catch {
    $archive.Dispose(); $archive = $null
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    throw
  } finally { if ($archive) { $archive.Dispose() } }
  $archive = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    $names = @($archive.Entries | ForEach-Object { $_.FullName })
  } finally { $archive.Dispose() }
  [pscustomobject]@{
    Path       = $zip
    Entries    = $names.Count
    Files      = @(Get-ChildItem -LiteralPath $Dist -Recurse -File -Force).Count
    Backslash  = @($names | Where-Object { $_.Contains('\') }).Count
    DotEntries = @($names | Where-Object { @($_ -split '/' | Where-Object { $_.StartsWith('.') }).Count -gt 0 }).Count
  }
}

if ($MyInvocation.InvocationName -eq '.') { return }

$kiwi = Join-Path $script:RepoRoot 'artifacts\kiwi'
$dist = if ($DistPath) { $DistPath } else { Join-Path $kiwi 'dist' }
$staleZip = Join-Path (Split-Path $dist) 'kiwi-web-dist.zip'
if (Test-Path -LiteralPath $staleZip) { Remove-Item -LiteralPath $staleZip -Force }
$PublicNames = @(
  'EXPO_PUBLIC_API_BASE_URL',
  'EXPO_PUBLIC_DOMAIN',
  'EXPO_PUBLIC_TURNSTILE_SITE_KEY',
  'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID',
  'EXPO_PUBLIC_APPLE_SERVICES_ID',
  'EXPO_PUBLIC_APPLE_WEB_REDIRECT_URI',
  'EXPO_PUBLIC_REVENUECAT_IOS_KEY',
  'EXPO_PUBLIC_REVENUECAT_ANDROID_KEY'
)
$DevHost = 'localhost|127\.0\.0\.1|192\.168\.|//10\.\d'

if ($ApiBaseUrl -notmatch '^https://[^/]+/api$') { throw "ApiBaseUrl must be https://<host>/api (lib/api/base.ts convention): $ApiBaseUrl" }
$apiHost = ([uri]$ApiBaseUrl).Host

if (-not $PostExportOnly) {
# --- which public values the export will see (names only) ----------------------------

# Expo's loader order for `expo export` (production): the first file to define a
# name wins, and the shell beats all of them.
$envFiles = @('.env.production.local', '.env.local', '.env.production', '.env') |
  ForEach-Object { Join-Path $kiwi $_ } | Where-Object { Test-Path -LiteralPath $_ }
$fileValues = @{}
foreach ($f in $envFiles) {
  $parsed = Read-DotEnv -Path $f
  foreach ($k in $parsed.Keys) { if (-not $fileValues.ContainsKey($k)) { $fileValues[$k] = @{ value = $parsed[$k]; file = (Split-Path $f -Leaf) } } }
}

Write-Host "export-web - API base for this export: $ApiBaseUrl"
$problems = New-Object System.Collections.Generic.List[string]
$present = 0
foreach ($n in $PublicNames) {
  if ($n -eq 'EXPO_PUBLIC_API_BASE_URL') { Write-Host "  ${n}: set by this script (process only)"; $present++; continue }
  $val = [Environment]::GetEnvironmentVariable($n, 'Process')
  $where = 'shell'
  if (-not $val -and $fileValues.ContainsKey($n)) { $val = $fileValues[$n].value; $where = $fileValues[$n].file }
  if ($val -and $val.Trim()) {
    Write-Host "  ${n}: present ($where)"
    $present++
    if ($n -eq 'EXPO_PUBLIC_TURNSTILE_SITE_KEY' -and (Test-TurnstileDummyKey $val)) { $problems.Add("${n}: is a Cloudflare dummy test site key - the production secret would reject every token") }
    if ($n -ne 'EXPO_PUBLIC_DOMAIN' -and $val -match $DevHost) { $problems.Add("${n}: points at a dev host") }
  } else {
    Write-Host "  ${n}: absent"
  }
}
Write-Host ("  {0} of {1} present" -f $present, $PublicNames.Count)
if ($problems.Count -gt 0) {
  Write-Host 'REFUSED - nothing exported:'
  $problems | ForEach-Object { Write-Host "  $_" }
  exit 1
}

# --- export ------------------------------------------------------------------------

$prev = [Environment]::GetEnvironmentVariable('EXPO_PUBLIC_API_BASE_URL', 'Process')
$env:EXPO_PUBLIC_API_BASE_URL = $ApiBaseUrl
Push-Location $kiwi
try {
  $ErrorActionPreference = 'Continue'
  & pnpm exec expo export --platform web --clear
  $code = $LASTEXITCODE
} finally {
  $ErrorActionPreference = 'Stop'
  Pop-Location
  if ($null -eq $prev) { Remove-Item Env:EXPO_PUBLIC_API_BASE_URL -ErrorAction SilentlyContinue } else { $env:EXPO_PUBLIC_API_BASE_URL = $prev }
}
if ($code -ne 0) { Write-Host "expo export exited $code"; exit $code }
}

# --- R3-2: no dot-segments left for Netlify to drop -------------------------------------

if (-not (Test-Path -LiteralPath $dist)) { Write-Host "no dist\ at $dist"; exit 1 }
Write-Host ''
$fix = Repair-DistDotSegments -Dist $dist
$fix.Lines | ForEach-Object { Write-Host $_ }
if (-not $fix.Ok) { Write-Host 'EXPORT CHECK FAILED - do not upload this dist\.'; exit 1 }

# --- what came out ---------------------------------------------------------------------

$files = @(Get-ChildItem -LiteralPath $dist -Recurse -File -Force)
Write-Host ("dist\: {0} files" -f $files.Count)
$redirectsOk = $fix.Ok

$bundles = @(Get-ChildItem -LiteralPath (Join-Path $dist '_expo\static\js\web') -Filter *.js -ErrorAction SilentlyContinue)
$js = ($bundles | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`n"
function Get-Hits { param([string]$Pattern) [regex]::Matches($js, $Pattern).Count }
$hostHits = Get-Hits ([regex]::Escape($apiHost))
$lanHits = Get-Hits '192\.168\.'
$devFallbackHits = Get-Hits 'localhost:3000'
$localhostHits = Get-Hits 'localhost'
Write-Host ("bundle: {0} JS file(s)" -f $bundles.Count)
Write-Host ("  {0}: {1} hit(s)" -f $apiHost, $hostHits)
Write-Host ("  192.168.: {0} hit(s)" -f $lanHits)
Write-Host ("  localhost:3000 (the base.ts dev fallback): {0} hit(s)" -f $devFallbackHits)
Write-Host ("  localhost (any): {0} hit(s)" -f $localhostHits)
foreach ($m in @([regex]::Matches($js, '.{0,50}localhost.{0,30}') | Select-Object -First 6)) { Write-Host ("    ...{0}..." -f $m.Value) }

$fail = (-not $redirectsOk) -or ($hostHits -eq 0) -or ($lanHits -gt 0) -or ($devFallbackHits -gt 0)
if ($fail) { Write-Host 'EXPORT CHECK FAILED - do not upload this dist\.'; exit 1 }

# --- the zip Netlify gets ----------------------------------------------------------------

$z = New-DistZip -Dist $dist
Write-Host ''
Write-Host ("zip: {0}" -f $z.Path)
Write-Host ("  {0} entries (dist\ has {1} files); backslash names: {2}; dot-segment entries: {3}" -f $z.Entries, $z.Files, $z.Backslash, $z.DotEntries)
if ($z.Entries -ne $z.Files -or $z.Backslash -gt 0 -or $z.DotEntries -gt 0) {
  Remove-Item -LiteralPath $z.Path -Force
  Write-Host 'ZIP CHECK FAILED - zip removed.'
  exit 1
}
Write-Host 'Export checks pass. Not deployed: drag kiwi-web-dist.zip into Netlify (project unique-semolina-e05761 -> Deploys).'
exit 0
