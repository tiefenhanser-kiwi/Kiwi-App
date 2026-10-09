# R3-1 Part C -- the Test Kitchen web export for app.kitchenwizard.ai. Builds
# artifacts\kiwi\dist; does NOT deploy (drag dist\ into Netlify).
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
# ASCII ONLY (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).

[CmdletBinding()]
param(
  [string]$ApiBaseUrl = 'https://kiwi-api-166146829159.us-east4.run.app/api'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_release-lib.ps1')

$kiwi = Join-Path $script:RepoRoot 'artifacts\kiwi'
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

# --- what came out ---------------------------------------------------------------------

$dist = Join-Path $kiwi 'dist'
$files = @(Get-ChildItem -LiteralPath $dist -Recurse -File)
Write-Host ''
Write-Host ("dist\: {0} files" -f $files.Count)
$redirects = Join-Path $dist '_redirects'
$redirectsOk = (Test-Path -LiteralPath $redirects) -and (([IO.File]::ReadAllText($redirects).Trim()) -match '^/\*\s+/index\.html\s+200$')
Write-Host ("_redirects in dist\: {0}" -f $(if ($redirectsOk) { 'yes (/*  /index.html  200)' } elseif (Test-Path -LiteralPath $redirects) { 'PRESENT BUT WRONG CONTENT' } else { 'NO' }))

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
Write-Host 'Export checks pass. Not deployed: drag artifacts\kiwi\dist into Netlify.'
exit 0
