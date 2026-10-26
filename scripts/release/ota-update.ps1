<#
.SYNOPSIS
OTA-1 -- a guarded EAS Update publish to the production channel, one platform at a time.

.PARAMETER Platform
android or ios. Never both: D-WS9-279 sends an update to a platform only after that
platform's binary is released, so each platform is its own publish.

.PARAMETER Runtime
1.1.0 or 1.2.0: which store binary the update is for. Each runtime has its own binary
commit (the native gate diffs against it) and its own branch (1.1.0 ships from release/1.1,
1.2.0 from next). The tree's app.json version must be this runtime.

.PARAMETER ConfirmReleased
I confirm this platform's binary for -Runtime is released in its store (D-WS9-279).

.PARAMETER Message
The update message EAS shows on the dashboard.

.PARAMETER DryRun
Run every check, build and verify the bundle, print the publish command, publish nothing.
#>
# OTA-1. Hans runs it; nothing else in the repo calls it.
#
#   .\scripts\release\ota-update.ps1 -Runtime 1.2.0 -Platform android -ConfirmReleased -Message "..." -DryRun
#   .\scripts\release\ota-update.ps1 -Runtime 1.2.0 -Platform android -ConfirmReleased -Message "..."
#
# Two binaries (1.2-NATIVE G): 1.1.0 (216b2a0) and 1.2.0. A 1.1.0 update is built from the
# release/1.1 branch, run from a worktree of it -- never from next, whose 1.2 JS imports
# native modules the 1.1 binary lacks (expo-store-review throws at import there). Fixes that
# 1.1 phones need are cherry-picked to release/1.1.
#
# Why a script: `eas update` reads NO build profile's env. EXPO_PUBLIC_API_BASE_URL lives in
# eas.json build.production.env, so a plain `eas update` bundles whatever the shell or
# artifacts\kiwi\.env holds, and `eas update --environment production` bundles the EAS
# production environment with EXPO_NO_DOTENV=1 and Metro --clear (eas-cli 24.12.1,
# build/commands/update/index.js). A bundle without the production URL points every
# installed app at the wrong server until the next update.
#
# Steps, each refusing with one line:
#   0. -ConfirmReleased is passed (D-WS9-279); -Runtime's binary commit is recorded.
#   1. git: the runtime's branch, HEAD = origin/<that branch> (only pushed code ships),
#      artifacts\kiwi and scripts\release clean. eas's own clean-tree check is OFF in this
#      project (no cli.requireCommit in eas.json) -- this is the only one.
#   2. native gate: nothing changed since the runtime's binary commit in the files that
#      decide what the installed binary contains, and app.json's version is -Runtime.
#      package.json alone is compared as JSON and may differ in "scripts" (REL-0).
#      pnpm-lock.yaml alone is compared by its artifacts/kiwi importer (+ the workspace
#      importers that one links) and the overrides that can reach them (REL-0b).
#   3. EAS: the production channel serves the production branch; the production
#      environment has every required EXPO_PUBLIC_* name (names only); the code reads no
#      EXPO_PUBLIC_* name this script does not know.
#   4. bundle the way `eas update --environment production` would: `eas env:pull production`
#      into a temp file (deleted in finally), then `expo export` with the shell env + those
#      values + EXPO_NO_DOTENV=1, --clear, --dump-sourcemap --dump-assetmap, one platform,
#      into a fresh folder OUTSIDE the repo. One deliberate difference: every EXPO_PUBLIC_*
#      already in the shell is dropped first (eas would let a shell value through when the
#      EAS environment lacks the name).
#   5. verify the bundle: the eas.json production API URL is in it; dev-host strings are not,
#      apart from the measured library baseline below. Prints size + sha256 of the bundle
#      and one sha256 over the whole folder.
#   6. -DryRun stops here and prints the publish command.
#   7. `eas update --skip-bundler --input-dir <that folder>` -- the verified folder is the
#      published one (its hash is re-checked first). Prints the group id and runtime version.
#
# Values are never printed: names, the eas.json API host, sizes and hashes only.
#
# ASCII ONLY (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('1.1.0', '1.2.0')][string]$Runtime,
  [Parameter(Mandatory = $true)][ValidateSet('android', 'ios')][string]$Platform,
  [Parameter(HelpMessage = "I confirm this platform's binary for -Runtime is released in its store (D-WS9-279)")][switch]$ConfirmReleased,
  [Parameter(Mandatory = $true)][string]$Message,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_release-lib.ps1')

# The store binaries, by runtime version (app.json "version"; runtimeVersion policy appVersion).
#   Commit: what BOTH platforms' binaries of that runtime were built from -- the native gate
#           diffs against it. RECORD IT AT EACH STORE BUILD; $null refuses at step 0.
#   Branch: where that runtime's updates are built from.
# -Runtime's ValidateSet lists the same keys.
$script:Binaries = [ordered]@{
  '1.1.0' = @{ Commit = '216b2a0'; Branch = 'release/1.1'; Builds = 'Android vc5, iOS build 8' }
  '1.2.0' = @{ Commit = $null; Branch = 'next'; Builds = 'not built yet' }
}
$script:BinaryCommit = $script:Binaries[$Runtime].Commit
$script:RuntimeBranch = $script:Binaries[$Runtime].Branch

$script:KiwiDir = Join-Path $script:RepoRoot 'artifacts\kiwi'
$script:NativePaths = @(
  'artifacts/kiwi/package.json',
  'artifacts/kiwi/app.json',
  'artifacts/kiwi/app.config.*',
  'artifacts/kiwi/ios',
  'artifacts/kiwi/android',
  # 1.2-NATIVE: local config plugins and the Firebase file only reach the binary at prebuild.
  'artifacts/kiwi/plugins',
  'artifacts/kiwi/google-services.json',
  'artifacts/kiwi/GoogleService-Info.plist',
  'pnpm-lock.yaml'
)
# The one native path compared as JSON, not as bytes: a change to its top-level "scripts"
# alone is allowed (REL-0). npm scripts reach neither the binary nor the bundle -- expo
# export and `eas update --skip-bundler` run none of them, EAS build hooks run at build only.
$script:PackageJsonPath = 'artifacts/kiwi/package.json'
# The one native path compared by section, not as bytes (REL-0b): the lockfile changes with
# every server dependency, but only the app's importer and the overrides that can reach it
# decide what the app installs.
$script:LockfilePath = 'pnpm-lock.yaml'
$script:KiwiImporter = 'artifacts/kiwi'
# Every EXPO_PUBLIC_* the app code reads (OTA-1 grep, October 13), less the one fallback.
$script:RequiredNames = @(
  'EXPO_PUBLIC_API_BASE_URL',
  'EXPO_PUBLIC_TURNSTILE_SITE_KEY',
  'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID',
  'EXPO_PUBLIC_APPLE_SERVICES_ID',
  'EXPO_PUBLIC_APPLE_WEB_REDIRECT_URI',
  'EXPO_PUBLIC_REVENUECAT_IOS_KEY',
  'EXPO_PUBLIC_REVENUECAT_ANDROID_KEY'
)
# lib/api/base.ts reads it only when EXPO_PUBLIC_API_BASE_URL is empty; never required.
$script:OptionalNames = @('EXPO_PUBLIC_DOMAIN')

# Dev hosts: never in an EAS value, never in the bundle beyond the baseline.
$script:DevHostPatterns = [ordered]@{
  'localhost'     = 'localhost'
  '127.0.0.1'     = '127\.0\.0\.1'
  '10.0.2.2'      = '10\.0\.2\.2'
  '192.168.'      = '192\.168\.'
  'ep-broad-haze' = 'ep-broad-haze'
  ':3000'         = '(?<=[A-Za-z0-9\]]):3000(?![0-9])'
  ':9000'         = '(?<=[A-Za-z0-9\]]):9000(?![0-9])'
}

# The measured baseline: hits a production-env bundle contains anyway, from libraries.
# pattern -> exact literal around the hit -> how many times. A hit is on the baseline when
# the bundle holds that literal at the hit's position. Exact literals, not the surrounding
# text: Hermes packs its string table with prefix/suffix overlap, so neighbours change.
# Measured OTA-1, October 13 (expo 54.0.37, react-native 0.81.5, both platforms built
# with the EAS production values + the eas.json API URL). The native gate refuses any
# change to the app's lockfile importer, so library strings can drift only through a
# transitive resolution -- and a hit off this baseline is refused at step 5 regardless.
#   http://localhost:8081/ -- react-native Libraries/Core/Devtools/getDevServer.js FALLBACK
#   http://localhost:3000  -- iOS only: expo-router build/head/url.js getOriginFromConstants,
#                             the fallback when app.json has no router origin (it has one);
#                             pulled in by ExpoHead.ios.js. It prefixes base.ts's dev
#                             fallback, so 'localhost:3000/api' is refused outright below.
#
# Per runtime: each runtime's bundles are built from its own lockfile. 1.2.0 starts as a
# copy of 1.1.0 and is re-measured once the 1.2 native modules are in (1.2-NATIVE B).
$script:BundleAllowListByRuntime = @{
  '1.1.0' = @{
    'android' = @{ 'localhost' = @{ 'http://localhost:8081/' = 1 } }
    'ios'     = @{
      'localhost' = @{ 'http://localhost:8081/' = 1; 'http://localhost:3000' = 1 }
      ':3000'     = @{ 'http://localhost:3000' = 1 }
    }
  }
  '1.2.0' = @{
    'android' = @{ 'localhost' = @{ 'http://localhost:8081/' = 1 } }
    'ios'     = @{
      'localhost' = @{ 'http://localhost:8081/' = 1; 'http://localhost:3000' = 1 }
      ':3000'     = @{ 'http://localhost:3000' = 1 }
    }
  }
}
$script:BundleAllowList = $script:BundleAllowListByRuntime[$Runtime]
# lib/api/base.ts's dev fallback: never allowed, whatever the baseline says.
$script:DevFallback = 'localhost:3000/api'

# --- helpers (dot-sourced by test-ota-update.ps1) ---------------------------------------

function Invoke-GitText {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $ErrorActionPreference = 'Continue'
  $out = & git -C $script:RepoRoot @Arguments 2>$null
  return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = @($out | ForEach-Object { "$_" } | Where-Object { $_ -ne '' }) }
}

# Runs eas from artifacts\kiwi (where app.json names the project). -Capture returns stdout
# lines; stderr (the upgrade banner, progress) goes to the console either way.
function Invoke-Eas {
  param([Parameter(Mandatory = $true)][string[]]$Arguments, [switch]$Capture)
  $ErrorActionPreference = 'Continue'
  Push-Location $script:KiwiDir
  try {
    if ($Capture) {
      $out = & eas @Arguments
      return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = @($out | ForEach-Object { "$_" }) }
    }
    & eas @Arguments | Out-Host
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = @() }
  } finally { Pop-Location }
}

# Names from `eas env:list <env> --format short` (NAME=value lines). Values are dropped here.
function Get-EnvListNames {
  param([string[]]$Lines)
  @($Lines | ForEach-Object { if ($_ -match '^([A-Za-z_][A-Za-z0-9_]*)=') { $Matches[1] } })
}

# The file `eas env:pull` writes: '# ...' comments (secret-visibility variables come out as
# '# NAME=***** (secret)'), blank lines, and NAME=value with the value raw to end of line.
# Anything else (a multi-line value) throws without echoing the line.
function Read-EasPulledEnv {
  param([Parameter(Mandatory = $true)][string]$Path)
  $values = [ordered]@{}
  $n = 0
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    $n++
    if ($line.Trim() -eq '' -or $line.TrimStart().StartsWith('#')) { continue }
    if ($line -notmatch '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { throw "eas env:pull line $n is not NAME=value (a multi-line value?) -- not guessing" }
    $values[$Matches[1]] = $Matches[2]
  }
  return $values
}

# EXPO_PUBLIC_* names the app reads: tracked files under artifacts/kiwi, not tests, e2e or
# the Replit build script.
function Get-CodePublicEnvReads {
  $files = Invoke-GitText @('ls-files', '--', 'artifacts/kiwi')
  if ($files.ExitCode -ne 0) { throw 'git ls-files failed' }
  $names = @{}
  foreach ($rel in $files.Lines) {
    if ($rel -notmatch '\.(ts|tsx|js|jsx|mjs|cjs)$') { continue }
    if ($rel -match '(^|/)(__tests__|e2e|node_modules)/|\.test\.|^artifacts/kiwi/scripts/') { continue }
    $text = [IO.File]::ReadAllText((Join-Path $script:RepoRoot $rel))
    foreach ($m in [regex]::Matches($text, 'process\.env(?:\.|\[\s*["''])(EXPO_PUBLIC_[A-Z0-9_]+)')) { $names[$m.Groups[1].Value] = $true }
  }
  return @($names.Keys | Sort-Object)
}

function Get-ProductionApiBaseUrl {
  $eas = [IO.File]::ReadAllText((Join-Path $script:KiwiDir 'eas.json')) | ConvertFrom-Json
  $v = $eas.build.production.env.EXPO_PUBLIC_API_BASE_URL
  if (-not $v -or $v -notmatch '^https://[^/]+/api$') { throw 'eas.json build.production.env.EXPO_PUBLIC_API_BASE_URL is missing or not https://<host>/api' }
  return $v
}

function Get-ExpectedRuntimeVersion {
  $app = ([IO.File]::ReadAllText((Join-Path $script:KiwiDir 'app.json')) | ConvertFrom-Json).expo
  if ($app.runtimeVersion.policy -ne 'appVersion') { throw 'app.json runtimeVersion.policy is not appVersion -- this script assumes it' }
  return [string]$app.version
}

# Problems with the pulled values; each names the variable, never the value.
function Test-PulledEnv {
  param([Parameter(Mandatory = $true)]$Values, [Parameter(Mandatory = $true)][string]$ApiBaseUrl)
  $problems = New-Object System.Collections.Generic.List[string]
  foreach ($n in $script:RequiredNames) {
    if (-not $Values.Contains($n) -or -not ([string]$Values[$n]).Trim()) { $problems.Add("${n}: not pulled (missing, empty, or secret visibility -- eas update cannot bundle a secret)") }
  }
  if ($Values.Contains('EXPO_PUBLIC_API_BASE_URL') -and [string]$Values['EXPO_PUBLIC_API_BASE_URL'] -cne $ApiBaseUrl) { $problems.Add('EXPO_PUBLIC_API_BASE_URL: differs from eas.json build.production.env') }
  if ($Values.Contains('EXPO_PUBLIC_TURNSTILE_SITE_KEY') -and (Test-TurnstileDummyKey ([string]$Values['EXPO_PUBLIC_TURNSTILE_SITE_KEY']))) { $problems.Add('EXPO_PUBLIC_TURNSTILE_SITE_KEY: is a Cloudflare dummy test key') }
  foreach ($k in $Values.Keys) {
    foreach ($label in $script:DevHostPatterns.Keys) {
      if ([string]$Values[$k] -match $script:DevHostPatterns[$label]) { $problems.Add("${k}: contains a dev host ($label)"); break }
    }
  }
  return , $problems
}

# Every dev-host hit in the bundle: pattern, position, matched text, and the run of URL-ish
# characters around it (up to 60 each side) to print. Bytes are read as Latin-1: Hermes
# keeps ASCII strings as single bytes, so a URL in the string table reads as itself.
function Get-BundleHits {
  param([Parameter(Mandatory = $true)][string]$Text)
  $hits = New-Object System.Collections.Generic.List[object]
  foreach ($label in $script:DevHostPatterns.Keys) {
    foreach ($m in [regex]::Matches($Text, $script:DevHostPatterns[$label])) {
      $s = $m.Index; $e = $m.Index + $m.Length
      while ($s -gt 0 -and ($m.Index - $s) -lt 60 -and $Text[$s - 1] -match '[A-Za-z0-9._:/@%?=&+\-\[\]]') { $s-- }
      while ($e -lt $Text.Length -and ($e - $m.Index - $m.Length) -lt 60 -and $Text[$e] -match '[A-Za-z0-9._:/@%?=&+\-\[\]]') { $e++ }
      $hits.Add([pscustomobject]@{ Pattern = $label; Index = $m.Index; Value = $m.Value; Context = $Text.Substring($s, $e - $s) })
    }
  }
  return , $hits
}

# Hits not covered by the baseline. A hit is covered when an allowed literal for its
# pattern sits in $Text around it; each literal covers as many hits as its count.
function Compare-BundleHits {
  param([Parameter(Mandatory = $true)][string]$Text, [Parameter(Mandatory = $true)]$Hits, [Parameter(Mandatory = $true)][hashtable]$AllowList)
  $left = @{}
  foreach ($p in $AllowList.Keys) { foreach ($l in $AllowList[$p].Keys) { $left["$p`t$l"] = [int]$AllowList[$p][$l] } }
  $extra = New-Object System.Collections.Generic.List[object]
  foreach ($h in $Hits) {
    $covered = $false
    if ($AllowList.ContainsKey($h.Pattern)) {
      foreach ($l in $AllowList[$h.Pattern].Keys) {
        $off = $l.IndexOf($h.Value, [StringComparison]::Ordinal)
        $at = $h.Index - $off
        if ($off -lt 0 -or $at -lt 0 -or $at + $l.Length -gt $Text.Length) { continue }
        if ($Text.Substring($at, $l.Length) -cne $l -or $left["$($h.Pattern)`t$l"] -le 0) { continue }
        $left["$($h.Pattern)`t$l"]--
        $covered = $true
        break
      }
    }
    if (-not $covered) { $extra.Add($h) }
  }
  return , $extra
}

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  $fs = [IO.File]::OpenRead($Path)
  try { return (($sha.ComputeHash($fs) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $fs.Dispose(); $sha.Dispose() }
}

# One sha256 over the folder: sorted "relative/path<TAB>sha256" lines.
function Get-DirHash {
  param([Parameter(Mandatory = $true)][string]$Dir)
  $root = (Resolve-Path -LiteralPath $Dir).Path.TrimEnd('\')
  $lines = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force | ForEach-Object {
      '{0}{1}{2}' -f $_.FullName.Substring($root.Length + 1).Replace('\', '/'), "`t", (Get-FileSha256 $_.FullName)
    } | Sort-Object -CaseSensitive)
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($lines -join "`n"))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $sha.Dispose() }
}

# `expo export` the way eas-cli's buildBundlesAsync runs it for one platform, with the
# environment eas update builds: the shell's, overlaid with $Values and EXPO_NO_DOTENV=1.
# Every EXPO_PUBLIC_* in the shell is removed first. All of it is restored in finally.
function Invoke-OtaExport {
  param([Parameter(Mandatory = $true)]$Values, [Parameter(Mandatory = $true)][string]$OutDir, [Parameter(Mandatory = $true)][string]$Platform)
  $saved = @{}
  foreach ($n in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'EXPO_PUBLIC_*' } | ForEach-Object { $_.Name })) {
    $saved[$n] = [Environment]::GetEnvironmentVariable($n, 'Process')
    [Environment]::SetEnvironmentVariable($n, $null, 'Process')
  }
  foreach ($n in @($Values.Keys) + 'EXPO_NO_DOTENV') {
    if (-not $saved.ContainsKey($n)) { $saved[$n] = [Environment]::GetEnvironmentVariable($n, 'Process') }
  }
  foreach ($n in $Values.Keys) { [Environment]::SetEnvironmentVariable($n, [string]$Values[$n], 'Process') }
  $env:EXPO_NO_DOTENV = '1'
  Push-Location $script:KiwiDir
  try {
    $ErrorActionPreference = 'Continue'
    & pnpm exec expo export --output-dir $OutDir --dump-sourcemap --dump-assetmap --platform $Platform --clear | Out-Host
    return $LASTEXITCODE
  } finally {
    Pop-Location
    foreach ($n in $saved.Keys) { [Environment]::SetEnvironmentVariable($n, $saved[$n], 'Process') }
  }
}

# Step 5 on an exported folder. Returns Ok + the lines to print + the hashes.
function Test-OtaBundle {
  param([Parameter(Mandatory = $true)][string]$Dist, [Parameter(Mandatory = $true)][string]$Platform, [Parameter(Mandatory = $true)][string]$ApiBaseUrl, [Parameter(Mandatory = $true)][hashtable]$AllowList)
  $lines = New-Object System.Collections.Generic.List[string]
  $r = [pscustomobject]@{ Ok = $false; Lines = $lines; Hits = $null; BundleSha = $null; DirSha = $null }
  $metaPath = Join-Path $Dist 'metadata.json'
  if (-not (Test-Path -LiteralPath $metaPath)) { $lines.Add('no metadata.json in the export'); return $r }
  $meta = [IO.File]::ReadAllText($metaPath) | ConvertFrom-Json
  $platforms = @($meta.fileMetadata.PSObject.Properties | ForEach-Object { $_.Name })
  if ($platforms.Count -ne 1 -or $platforms[0] -ne $Platform) { $lines.Add("export holds platform(s) [$($platforms -join ', ')], expected only $Platform"); return $r }
  $bundle = Join-Path $Dist ([string]$meta.fileMetadata.$Platform.bundle)
  if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) { $lines.Add('metadata.json names a bundle that is not there'); return $r }
  $text = [Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes($bundle))
  $r.BundleSha = Get-FileSha256 $bundle
  $lines.Add(("bundle: {0} ({1:N0} bytes) sha256 {2}" -f ([string]$meta.fileMetadata.$Platform.bundle), (Get-Item -LiteralPath $bundle).Length, $r.BundleSha))
  $apiHits = [regex]::Matches($text, [regex]::Escape($ApiBaseUrl)).Count
  $lines.Add(("  production API URL (eas.json, host {0}): {1} hit(s)" -f ([uri]$ApiBaseUrl).Host, $apiHits))
  $fallbackHits = [regex]::Matches($text, [regex]::Escape($script:DevFallback)).Count
  $lines.Add(("  {0} (the base.ts dev fallback, never allowed): {1} hit(s)" -f $script:DevFallback, $fallbackHits))
  $r.Hits = Get-BundleHits -Text $text
  $extra = Compare-BundleHits -Text $text -Hits $r.Hits -AllowList $AllowList
  foreach ($label in $script:DevHostPatterns.Keys) {
    $all = @($r.Hits | Where-Object { $_.Pattern -eq $label }).Count
    $bad = @($extra | Where-Object { $_.Pattern -eq $label }).Count
    $lines.Add(("  {0}: {1} hit(s), {2} on the baseline, {3} not" -f $label, $all, ($all - $bad), $bad))
  }
  foreach ($h in $extra) { $lines.Add(("    NOT ON BASELINE [{0}] ...{1}..." -f $h.Pattern, $h.Context)) }
  $r.DirSha = Get-DirHash $Dist
  $lines.Add(("export folder: {0} files, sha256 {1}" -f @(Get-ChildItem -LiteralPath $Dist -Recurse -File -Force).Count, $r.DirSha))
  if ($apiHits -eq 0) { $lines.Add('the production API URL is not in the bundle'); return $r }
  if ($fallbackHits -gt 0) { $lines.Add("the base.ts dev fallback ($script:DevFallback) is in the bundle"); return $r }
  if ($extra.Count -gt 0) { $lines.Add('dev-host strings outside the baseline'); return $r }
  $r.Ok = $true
  return $r
}

# Step 0's runtime check: the refusal reason, or $null when -Runtime can be updated.
function Test-RuntimeBinary {
  param([Parameter(Mandatory = $true)][string]$Runtime)
  if (-not $script:Binaries.Contains($Runtime)) { return "runtime $Runtime is not one of this script's binaries ($(@($script:Binaries.Keys) -join ', '))" }
  if (-not $script:Binaries[$Runtime].Commit) { return "runtime $Runtime has no binary commit recorded -- set `$script:Binaries['$Runtime'].Commit to the commit its store builds came from" }
  return $null
}

# Step 1's branch check: the refusal reason, or $null when the tree is on -Runtime's branch.
function Test-RuntimeBranch {
  param([Parameter(Mandatory = $true)][string]$Runtime, [AllowEmptyString()][string]$Branch)
  $want = $script:Binaries[$Runtime].Branch
  if ($Branch -ceq $want) { return $null }
  $where = if ($want -ceq 'release/1.1') { ' (run it from your release/1.1 worktree)' } else { '' }
  return "branch is '$Branch'; runtime $Runtime updates ship from $want$where"
}

# Step 2's runtime check: app.json's version (the runtime, policy appVersion) is -Runtime.
function Test-TreeRuntime {
  param([Parameter(Mandatory = $true)][string]$Runtime, [Parameter(Mandatory = $true)][string]$TreeRuntime)
  if ($TreeRuntime -ceq $Runtime) { return $null }
  return "app.json version is $TreeRuntime, not -Runtime $Runtime -- this tree builds runtime $TreeRuntime updates"
}

function Get-PublishArguments {
  param([string]$Platform, [string]$Message, [string]$InputDir)
  @('update', '--branch', 'production', '--platform', $Platform, '--environment', 'production', '--message', $Message, '--skip-bundler', '--input-dir', $InputDir, '--non-interactive', '--json')
}

function Format-Command {
  param([string[]]$Arguments)
  'eas ' + (($Arguments | ForEach-Object { if ($_ -match '[\s"]' -or $_ -eq '') { '"' + $_ + '"' } else { $_ } }) -join ' ')
}

# A file at a revision as exact bytes, decoded as strict UTF-8 ($null when git fails).
# Not through a PowerShell pipe: 5.1 decodes native output with the console code page, and
# two different non-ASCII characters could both come out as '?' and compare equal.
function Get-GitBlobText {
  param([Parameter(Mandatory = $true)][string]$Rev, [Parameter(Mandatory = $true)][string]$Path)
  $psi = New-Object System.Diagnostics.ProcessStartInfo 'git'
  $psi.Arguments = ('-C "{0}" show "{1}:{2}"' -f $script:RepoRoot, $Rev, $Path)
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $errRead = $p.StandardError.ReadToEndAsync()
  $ms = New-Object System.IO.MemoryStream
  try {
    $p.StandardOutput.BaseStream.CopyTo($ms)
    $p.WaitForExit()
    [void]$errRead.Result
    if ($p.ExitCode -ne 0) { return $null }
    return (New-Object System.Text.UTF8Encoding($false, $true)).GetString($ms.ToArray())
  } finally { $ms.Dispose(); $p.Dispose() }
}

# Name -> value of a ConvertFrom-Json object, keys compared ordinally (JSON keys are
# case-sensitive; PowerShell property lookup is not).
function Get-JsonMembers {
  param([Parameter(Mandatory = $true)]$Object)
  $d = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
  foreach ($p in $Object.PSObject.Properties) { $d[$p.Name] = $p.Value }
  return , $d
}

function Test-JsonObject {
  param($Value)
  return ($null -ne $Value) -and ($Value -isnot [System.Collections.IList]) -and ($Value.PSObject.BaseObject -is [System.Management.Automation.PSCustomObject])
}

# One string per JSON value with object keys sorted ordinally: equal strings = equal JSON,
# whatever the key order or whitespace. Scalars keep their type ("1" is not 1).
function ConvertTo-CanonicalJson {
  param($Value)
  if ($null -eq $Value) { return 'null' }
  if ($Value -is [string] -or $Value -is [ValueType]) { return (ConvertTo-Json -InputObject $Value -Compress) }
  if ($Value -is [System.Collections.IList]) {
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($e in $Value) { $parts.Add((ConvertTo-CanonicalJson $e)) }
    return '[' + ($parts -join ',') + ']'
  }
  if (Test-JsonObject $Value) {
    $m = Get-JsonMembers $Value
    $keys = [string[]]@($m.Keys)
    [Array]::Sort($keys, [StringComparer]::Ordinal)
    $parts = New-Object System.Collections.Generic.List[string]
    foreach ($k in $keys) { $parts.Add((ConvertTo-Json -InputObject $k -Compress) + ':' + (ConvertTo-CanonicalJson $m[$k])) }
    return '{' + ($parts -join ',') + '}'
  }
  throw "unexpected JSON value of type $($Value.GetType().FullName)"
}

# package.json at the binary commit vs HEAD. Every top-level key but "scripts" must be the
# same JSON. Returns Error (could not compare -- refuse), Changed (the differing top-level
# keys, sorted) and ScriptsChanged.
function Compare-PackageJsonText {
  param([AllowNull()][string]$Old, [AllowNull()][string]$New)
  $r = [pscustomobject]@{ Error = $null; Changed = @(); ScriptsChanged = $false }
  $parsed = @{}
  foreach ($side in @(@('old', $Old, 'at the binary commit'), @('new', $New, 'at HEAD'))) {
    if ($null -eq $side[1] -or -not $side[1].Trim()) { $r.Error = "missing or empty $($side[2])"; return $r }
    try { $o = $side[1] | ConvertFrom-Json } catch { $r.Error = "not valid JSON $($side[2])"; return $r }
    if (-not (Test-JsonObject $o)) { $r.Error = "not a JSON object $($side[2])"; return $r }
    $parsed[$side[0]] = Get-JsonMembers $o
  }
  try {
    $keys = New-Object 'System.Collections.Generic.SortedSet[string]' ([StringComparer]::Ordinal)
    foreach ($k in $parsed['old'].Keys) { [void]$keys.Add($k) }
    foreach ($k in $parsed['new'].Keys) { [void]$keys.Add($k) }
    $changed = New-Object System.Collections.Generic.List[string]
    foreach ($k in $keys) {
      $a = if ($parsed['old'].ContainsKey($k)) { ConvertTo-CanonicalJson $parsed['old'][$k] } else { '<absent>' }
      $b = if ($parsed['new'].ContainsKey($k)) { ConvertTo-CanonicalJson $parsed['new'][$k] } else { '<absent>' }
      if ($a -ceq $b) { continue }
      if ($k -ceq 'scripts') { $r.ScriptsChanged = $true; continue }
      $changed.Add($k)
    }
  } catch { $r.Error = "could not canonicalise: $($_.Exception.Message)"; return $r }
  $r.Changed = @($changed)
  return $r
}

# pnpm-lock.yaml's lines, LF or CRLF.
function Split-LockText {
  param([Parameter(Mandatory = $true)][string]$Text)
  return , ([string[]]($Text -split "`r?`n"))
}

# A mapping key as pnpm writes it: bare, 'single-' or "double-quoted".
function ConvertFrom-LockKey {
  param([string]$Key)
  if ($Key.Length -ge 2 -and (($Key[0] -eq "'" -and $Key[-1] -eq "'") -or ($Key[0] -eq '"' -and $Key[-1] -eq '"'))) { return $Key.Substring(1, $Key.Length - 2) }
  return $Key
}

# One importer's block: its "  <importer>:" line under importers:, up to the next line
# indented by exactly two spaces or the next top-level line (packages:), trailing blank
# lines dropped. $null when the importer is not there.
function Get-LockImporterBlock {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Lines, [Parameter(Mandatory = $true)][string]$Importer)
  $inImporters = $false
  $block = $null
  foreach ($l in $Lines) {
    if ($l -match '^\S') { if ($null -ne $block) { break }; $inImporters = ($l -ceq 'importers:'); continue }
    if (-not $inImporters) { continue }
    if ($l -match '^  \S') {
      if ($null -ne $block) { break }
      if ($l -match '^  (\S.*):\s*$' -and (ConvertFrom-LockKey $Matches[1]) -ceq $Importer) { $block = New-Object System.Collections.Generic.List[string]; $block.Add($l) }
      continue
    }
    if ($null -ne $block) { $block.Add($l) }
  }
  if ($null -eq $block) { return $null }
  while ($block.Count -gt 0 -and -not $block[$block.Count - 1].Trim()) { $block.RemoveAt($block.Count - 1) }
  return , ([string[]]$block)
}

# An importer block's dependencies: "section/name" -> @{ Section; Name; specifier; version }.
function Get-LockImporterDeps {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Block)
  $d = New-Object 'System.Collections.Generic.Dictionary[string,hashtable]' ([StringComparer]::Ordinal)
  $section = $null; $cur = $null
  foreach ($l in $Block) {
    if ($l -match '^    (\S.*):\s*$') { $section = ConvertFrom-LockKey $Matches[1]; $cur = $null; continue }
    if ($l -match '^      (\S.*):\s*$') {
      $cur = @{ Section = $section; Name = (ConvertFrom-LockKey $Matches[1]); specifier = $null; version = $null }
      $d["$section/$($cur.Name)"] = $cur
      continue
    }
    if ($null -ne $cur -and $l -match '^        (specifier|version): (.*)$') { $cur[$Matches[1]] = $Matches[2].Trim() }
  }
  return , $d
}

# The top-level overrides: block as selector -> value (empty when there is no block). A line
# it cannot read throws.
function Get-LockOverrides {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Lines)
  $o = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::Ordinal)
  $in = $false
  foreach ($l in $Lines) {
    if ($l -match '^\S') { if ($in) { break }; $in = ($l -ceq 'overrides:'); continue }
    if (-not $in -or -not $l.Trim()) { continue }
    if ($l -notmatch '^  (''[^'']*''|"[^"]*"|[^\s''"][^:]*): (.*)$') { throw "unreadable overrides line: $l" }
    $o[(ConvertFrom-LockKey $Matches[1])] = $Matches[2].Trim()
  }
  return , $o
}

# The package name in one override selector segment: "foo", "foo@1", "@scope/foo@^2".
function Get-LockSelectorName {
  param([string]$Segment)
  if ($Segment.Length -lt 2) { return $Segment }
  $at = $Segment.IndexOf('@', 1)
  if ($at -gt 0) { return $Segment.Substring(0, $at) }
  return $Segment
}

# An importer's "link:<path>" target as an importer key ("." for the root).
function Resolve-LockLink {
  param([string]$From, [string]$Link)
  $parts = New-Object System.Collections.Generic.List[string]
  foreach ($p in (($From + '/' + $Link) -split '/')) {
    if ($p -eq '' -or $p -eq '.') { continue }
    if ($p -eq '..') { if ($parts.Count -gt 0) { $parts.RemoveAt($parts.Count - 1) }; continue }
    $parts.Add($p)
  }
  if ($parts.Count -eq 0) { return '.' }
  return ($parts -join '/')
}

# A lockfile version without its peer suffix: "0.81.5(react@19.1.0)" -> "0.81.5".
function Get-LockBareVersion {
  param([AllowNull()][string]$Version)
  if ($null -eq $Version) { return '<none>' }
  $i = $Version.IndexOf('(')
  if ($i -gt 0) { return $Version.Substring(0, $i) }
  return $Version
}

# pnpm-lock.yaml at the binary commit vs HEAD (REL-0b). What counts: the $Importer block, the
# blocks of the workspace importers it links to (link:, followed transitively), and every
# override that can reach them -- unscoped, or scoped with a segment naming a package of
# those importers. Other importers, packages:, snapshots: and the scoped overrides of other
# trees do not. Returns Error (could not compare -- refuse), Changed (one entry per change
# that counts), Linked (the linked importers compared) and OtherOverrides (changed selectors
# that do not count).
function Compare-LockfileText {
  param([AllowNull()][string]$Old, [AllowNull()][string]$New, [string]$Importer = $script:KiwiImporter)
  $r = [pscustomobject]@{ Error = $null; Changed = @(); Linked = @(); OtherOverrides = @() }
  $lines = @{}
  foreach ($side in @(@('old', $Old, 'at the binary commit'), @('new', $New, 'at HEAD'))) {
    if ($null -eq $side[1] -or -not $side[1].Trim()) { $r.Error = "missing or empty $($side[2])"; return $r }
    $lines[$side[0]] = Split-LockText $side[1]
    if ($null -eq (Get-LockImporterBlock -Lines $lines[$side[0]] -Importer $Importer)) { $r.Error = "no $Importer importer $($side[2])"; return $r }
  }
  $changed = New-Object System.Collections.Generic.List[string]
  $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  $linked = New-Object System.Collections.Generic.List[string]
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  $queue = New-Object System.Collections.Generic.Queue[string]
  [void]$seen.Add($Importer); $queue.Enqueue($Importer)
  while ($queue.Count -gt 0) {
    $imp = $queue.Dequeue()
    $prefix = if ($imp -ceq $Importer) { '' } else { "${imp}: " }
    $ob = Get-LockImporterBlock -Lines $lines['old'] -Importer $imp
    $nb = Get-LockImporterBlock -Lines $lines['new'] -Importer $imp
    if ($null -eq $ob -or $null -eq $nb) { $changed.Add(("{0}linked importer {1}" -f $prefix, $(if ($null -eq $ob) { 'added' } else { 'removed' }))); continue }
    $od = Get-LockImporterDeps $ob
    $nd = Get-LockImporterDeps $nb
    foreach ($d in @($od.Values) + @($nd.Values)) {
      [void]$names.Add($d.Name)
      if ($d.version -match '^link:(.+)$') {
        $t = Resolve-LockLink -From $imp -Link $Matches[1]
        if ($seen.Add($t)) { $queue.Enqueue($t); $linked.Add($t) }
      }
    }
    if (($ob -join "`n") -ceq ($nb -join "`n")) { continue }
    $before = $changed.Count
    $keys = New-Object 'System.Collections.Generic.SortedSet[string]' ([StringComparer]::Ordinal)
    foreach ($k in $od.Keys) { [void]$keys.Add($k) }
    foreach ($k in $nd.Keys) { [void]$keys.Add($k) }
    foreach ($k in $keys) {
      $a = if ($od.ContainsKey($k)) { $od[$k] } else { $null }
      $b = if ($nd.ContainsKey($k)) { $nd[$k] } else { $null }
      if ($null -eq $a) { $changed.Add(("{0}{1} added to {2} ({3})" -f $prefix, $b.Name, $b.Section, (Get-LockBareVersion $b.version))); continue }
      if ($null -eq $b) { $changed.Add(("{0}{1} removed from {2}" -f $prefix, $a.Name, $a.Section)); continue }
      if ($a.specifier -cne $b.specifier) { $changed.Add(("{0}{1} specifier {2} -> {3}" -f $prefix, $a.Name, $a.specifier, $b.specifier)) }
      if ($a.version -cne $b.version) {
        $va = Get-LockBareVersion $a.version; $vb = Get-LockBareVersion $b.version
        if ($va -cne $vb) { $changed.Add(("{0}{1} version {2} -> {3}" -f $prefix, $a.Name, $va, $vb)) }
        else { $changed.Add(("{0}{1} version {2} (peer resolution changed)" -f $prefix, $a.Name, $va)) }
      }
    }
    if ($changed.Count -eq $before) { $changed.Add(("{0}importer lines other than specifier/version changed" -f $prefix)) }
  }
  try { $oo = Get-LockOverrides $lines['old']; $no = Get-LockOverrides $lines['new'] } catch { $r.Error = $_.Exception.Message; return $r }
  $sels = New-Object 'System.Collections.Generic.SortedSet[string]' ([StringComparer]::Ordinal)
  foreach ($k in $oo.Keys) { [void]$sels.Add($k) }
  foreach ($k in $no.Keys) { [void]$sels.Add($k) }
  $other = New-Object System.Collections.Generic.List[string]
  foreach ($k in $sels) {
    $a = if ($oo.ContainsKey($k)) { $oo[$k] } else { '<absent>' }
    $b = if ($no.ContainsKey($k)) { $no[$k] } else { '<absent>' }
    if ($a -ceq $b) { continue }
    $segs = @($k -split '>')
    $reaches = ($segs.Count -eq 1) -or (@($segs | Where-Object { $names.Contains((Get-LockSelectorName $_)) }).Count -gt 0)
    if ($reaches) { $changed.Add(("override {0}: {1} -> {2}" -f $k, $a, $b)) } else { $other.Add($k) }
  }
  $r.Changed = @($changed)
  $r.Linked = @($linked)
  $r.OtherOverrides = @($other)
  return $r
}

# Step 2's file check: every native path must be byte-identical to $BinaryCommit, except
# package.json, which may differ in its top-level "scripts" (and in key order / whitespace),
# and pnpm-lock.yaml, which may differ outside the app's importer (Compare-LockfileText).
# Returns Ok, the lines to print before step 2's summary, and the refusal reason.
function Test-NativeGate {
  $lines = New-Object System.Collections.Generic.List[string]
  $r = [pscustomobject]@{ Ok = $false; Lines = $lines; Reason = $null }
  $diff = Invoke-GitText (@('diff', '--name-only', "$script:BinaryCommit..HEAD", '--') + $script:NativePaths)
  if ($diff.ExitCode -ne 0) { $r.Reason = 'git diff failed'; return $r }
  $refused = New-Object System.Collections.Generic.List[string]
  foreach ($f in $diff.Lines) {
    if ($f -ceq $script:LockfilePath) {
      $lk = Compare-LockfileText -Old (Get-GitBlobText -Rev $script:BinaryCommit -Path $f) -New (Get-GitBlobText -Rev 'HEAD' -Path $f)
      if ($lk.Error) { $r.Reason = "${f}: $($lk.Error) -- cannot tell what changed, refusing"; return $r }
      if ($lk.Changed.Count -gt 0) { $refused.Add(("{0} ({1} changed: {2})" -f $f, $script:KiwiImporter, ($lk.Changed -join '; '))); continue }
      $lines.Add(('[2] pnpm-lock.yaml: {0} importer unchanged since {1} (other importers changed) -- allowed' -f $script:KiwiImporter, $script:BinaryCommit))
      if ($lk.Linked.Count -gt 0) { $lines.Add(('    linked workspace importer(s) unchanged too: {0}' -f ($lk.Linked -join ', '))) }
      if ($lk.OtherOverrides.Count -gt 0) { $lines.Add(('    scoped override(s) changed outside its tree: {0}' -f ($lk.OtherOverrides -join ', '))) }
      continue
    }
    if ($f -cne $script:PackageJsonPath) { $refused.Add($f); continue }
    $cmp = Compare-PackageJsonText -Old (Get-GitBlobText -Rev $script:BinaryCommit -Path $f) -New (Get-GitBlobText -Rev 'HEAD' -Path $f)
    if ($cmp.Error) { $r.Reason = "${f}: $($cmp.Error) -- cannot tell what changed, refusing"; return $r }
    if ($cmp.Changed.Count -gt 0) { $refused.Add(("{0} (top-level key(s) changed: {1})" -f $f, ($cmp.Changed -join ', '))); continue }
    if ($cmp.ScriptsChanged) { $lines.Add(('[2] package.json: only "scripts" changed since {0} -- not native, allowed' -f $script:BinaryCommit)) }
    else { $lines.Add(('[2] package.json: same JSON as {0} (key order / whitespace only) -- allowed' -f $script:BinaryCommit)) }
  }
  if ($refused.Count -gt 0) { $r.Reason = ("{0} native-relevant file(s) changed since the binaries ({1}): {2} -- an OTA could crash the installed app; this needs a store build" -f $refused.Count, $script:BinaryCommit, ($refused -join ', ')); return $r }
  $r.Ok = $true
  return $r
}

if ($MyInvocation.InvocationName -eq '.') { return }

# --- main -----------------------------------------------------------------------------

function Stop-Refused {
  param([string]$Step, [string]$Reason)
  Write-Host "REFUSED at step ${Step}: $Reason" -ForegroundColor Red
  exit 1
}

Write-Host ("ota-update - runtime {0}, platform {1}{2}" -f $Runtime, $Platform, $(if ($DryRun) { ' (DRY RUN)' } else { '' }))

# 0 --------------------------------------------------------------------------------------
if (-not $ConfirmReleased) { Stop-Refused '0' "-ConfirmReleased not passed: confirm the $Platform $Runtime binary is released in its store (D-WS9-279)" }
if (-not $Message.Trim() -or $Message -match '["\r\n]') { Stop-Refused '0' '-Message is empty or holds a double quote / newline' }
$why = Test-RuntimeBinary -Runtime $Runtime
if ($why) { Stop-Refused '0' $why }
Write-Host "[0] -ConfirmReleased: $Platform $Runtime binary released (operator's word); built from $script:BinaryCommit ($($script:Binaries[$Runtime].Builds))"

# 1 --------------------------------------------------------------------------------------
$branch = Invoke-GitText @('rev-parse', '--abbrev-ref', 'HEAD')
if ($branch.ExitCode -ne 0) { Stop-Refused '1' 'git rev-parse failed' }
$why = Test-RuntimeBranch -Runtime $Runtime -Branch ($branch.Lines -join '')
if ($why) { Stop-Refused '1' $why }
$head = (Invoke-GitText @('rev-parse', 'HEAD')).Lines[0]
$remote = Invoke-GitText @('rev-parse', '--verify', '--quiet', "refs/remotes/origin/$script:RuntimeBranch")
if ($remote.ExitCode -ne 0) { Stop-Refused '1' "no origin/$script:RuntimeBranch ref" }
if ($head -ne $remote.Lines[0]) { Stop-Refused '1' ("HEAD {0} is not origin/{1} {2} -- push (or pull) first; only pushed code ships" -f $head.Substring(0, 7), $script:RuntimeBranch, $remote.Lines[0].Substring(0, 7)) }
$dirty = Invoke-GitText @('status', '--porcelain', '--', 'artifacts/kiwi', 'scripts/release')
if ($dirty.ExitCode -ne 0) { Stop-Refused '1' 'git status failed' }
if ($dirty.Lines.Count -gt 0) { Stop-Refused '1' ("{0} uncommitted path(s) under artifacts/kiwi or scripts/release, first: {1}" -f $dirty.Lines.Count, $dirty.Lines[0].Trim()) }
Write-Host ("[1] git: {0} at {1} = origin/{0}; artifacts/kiwi and scripts/release clean" -f $script:RuntimeBranch, $head.Substring(0, 7))

# 2 --------------------------------------------------------------------------------------
$runtime = Get-ExpectedRuntimeVersion
$why = Test-TreeRuntime -Runtime $Runtime -TreeRuntime $runtime
if ($why) { Stop-Refused '2' $why }
$anc = Invoke-GitText @('merge-base', '--is-ancestor', $script:BinaryCommit, 'HEAD')
if ($anc.ExitCode -ne 0) { Stop-Refused '2' "binary commit $script:BinaryCommit is not an ancestor of HEAD" }
$gate = Test-NativeGate
if (-not $gate.Ok) { Stop-Refused '2' $gate.Reason }
$gate.Lines | ForEach-Object { Write-Host $_ }
Write-Host ("[2] native gate: no native change since {0} in {1}; runtime version {2} (appVersion)" -f $script:BinaryCommit, ($script:NativePaths -join ' '), $runtime)

# 3 --------------------------------------------------------------------------------------
$ver = Invoke-Eas -Capture @('--version')
if ($ver.ExitCode -ne 0) { Stop-Refused '3' 'eas --version failed (is eas-cli installed?)' }
Write-Host ("[3] {0}" -f ($ver.Lines | Where-Object { $_ -match 'eas-cli/' } | Select-Object -First 1))
$ch = Invoke-Eas -Capture @('channel:view', 'production', '--json', '--non-interactive')
if ($ch.ExitCode -ne 0) { Stop-Refused '3' 'eas channel:view production failed' }
$chPage = (($ch.Lines -join "`n") | ConvertFrom-Json).currentPage
$mapping = ([string]$chPage.branchMapping | ConvertFrom-Json).data
$prodBranch = @($chPage.updateBranches | Where-Object { $_.name -eq 'production' })
if ($chPage.isPaused -or @($mapping).Count -ne 1 -or $prodBranch.Count -ne 1 -or $mapping[0].branchId -ne $prodBranch[0].id -or $mapping[0].branchMappingLogic -ne 'true') {
  Stop-Refused '3' 'channel production does not send all traffic to branch production (paused, a rollout, or another branch)'
}
Write-Host '    channel production -> branch production (all traffic, not paused)'
$codeReads = Get-CodePublicEnvReads
$unknown = @($codeReads | Where-Object { $script:RequiredNames -notcontains $_ -and $script:OptionalNames -notcontains $_ })
if ($unknown.Count -gt 0) { Stop-Refused '3' ("the code reads EXPO_PUBLIC_* name(s) this script does not know: {0} -- add them to RequiredNames" -f ($unknown -join ', ')) }
Write-Host ("    the code reads {0} EXPO_PUBLIC_* names; required: {1}; fallback only: {2}" -f $codeReads.Count, $script:RequiredNames.Count, ($script:OptionalNames -join ', '))
$list = Invoke-Eas -Capture @('env:list', 'production', '--format', 'short')
if ($list.ExitCode -ne 0) { Stop-Refused '3' 'eas env:list production failed' }
$names = Get-EnvListNames $list.Lines
$list = $null
foreach ($n in $script:RequiredNames) { Write-Host ("    {0}: {1}" -f $n, $(if ($names -contains $n) { 'present' } else { 'MISSING' })) }
$missing = @($script:RequiredNames | Where-Object { $names -notcontains $_ })
if ($missing.Count -gt 0) { Stop-Refused '3' ("EAS production environment lacks {0} -- the bundle would fall back to a non-production value" -f ($missing -join ', ')) }

# 4 --------------------------------------------------------------------------------------
$apiBaseUrl = Get-ProductionApiBaseUrl
$work = Join-Path ([IO.Path]::GetTempPath()) ('kiwi-ota-{0}-{1}' -f $Platform, (Get-Date -Format 'yyyyMMdd-HHmmss'))
if ($work.StartsWith($script:RepoRoot, [StringComparison]::OrdinalIgnoreCase)) { Stop-Refused '4' 'temp folder resolves inside the repo' }
New-Item -ItemType Directory -Force $work | Out-Null
$dist = Join-Path $work 'dist'
$envFile = Join-Path $work 'eas-production.env'
$values = $null
try {
  $pull = Invoke-Eas -Capture @('env:pull', 'production', '--path', $envFile, '--non-interactive')
  if ($pull.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $envFile)) { Stop-Refused '4' 'eas env:pull production failed' }
  $values = Read-EasPulledEnv -Path $envFile
} finally {
  if (Test-Path -LiteralPath $envFile) { Remove-Item -LiteralPath $envFile -Force }
}
if (Test-Path -LiteralPath $envFile) { Stop-Refused '4' "could not delete $envFile" }
Write-Host ("[4] pulled {0} value(s) from EAS production into memory; temp env file deleted" -f $values.Count)
$problems = Test-PulledEnv -Values $values -ApiBaseUrl $apiBaseUrl
if ($problems.Count -gt 0) { Stop-Refused '4' ($problems -join '; ') }
Write-Host ("    EXPO_PUBLIC_API_BASE_URL equals eas.json build.production.env (host {0})" -f ([uri]$apiBaseUrl).Host)
Write-Host "    expo export -> $dist (EXPO_NO_DOTENV=1, --clear, shell EXPO_PUBLIC_* dropped)"
$code = Invoke-OtaExport -Values $values -OutDir $dist -Platform $Platform
$values = $null
if ($code -ne 0) { Stop-Refused '4' "expo export exited $code" }

# 5 --------------------------------------------------------------------------------------
$check = Test-OtaBundle -Dist $dist -Platform $Platform -ApiBaseUrl $apiBaseUrl -AllowList $script:BundleAllowList[$Platform]
Write-Host '[5] bundle check'
$check.Lines | ForEach-Object { Write-Host "    $_" }
if (-not $check.Ok) { Stop-Refused '5' $check.Lines[-1] }

# 6 --------------------------------------------------------------------------------------
$publish = Get-PublishArguments -Platform $Platform -Message $Message -InputDir $dist
if ($DryRun) {
  Write-Host '[6] DRY RUN - nothing published. A real run rebuilds into a new folder, re-verifies, then runs (from artifacts\kiwi):'
  Write-Host "    $(Format-Command $publish)"
  Write-Host "    (this run's verified folder: $dist)"
  exit 0
}

# 7 --------------------------------------------------------------------------------------
if ((Get-DirHash $dist) -ne $check.DirSha) { Stop-Refused '7' 'the export folder changed after it was verified' }
Write-Host "[7] publishing: $(Format-Command $publish)"
$res = Invoke-Eas -Capture $publish
$json = $res.Lines -join "`n"
if ($res.ExitCode -ne 0) { Write-Host $json; Stop-Refused '7' "eas update exited $($res.ExitCode) -- check update:list before retrying" }
try { $updates = @($json | ConvertFrom-Json) } catch { Write-Host $json; Stop-Refused '7' 'eas update succeeded but its --json output did not parse -- read the group id from the EAS dashboard' }
$groups = @($updates | ForEach-Object { $_.group } | Select-Object -Unique)
foreach ($u in $updates) { Write-Host ("    update {0}: platform {1}, branch {2}, runtime {3}" -f $u.id, $u.platform, $u.branch, $u.runtimeVersion) }
Write-Host ("    update group id: {0}" -f ($groups -join ', '))
$wrong = @($updates | Where-Object { $_.platform -ne $Platform -or $_.branch -ne 'production' -or $_.runtimeVersion -ne $runtime })
if ($groups.Count -ne 1 -or $wrong.Count -gt 0) { Write-Host "!! PUBLISHED, BUT NOT AS EXPECTED (one group, $Platform only, branch production, runtime $runtime) -- check the EAS dashboard now" -ForegroundColor Red; exit 1 }
Write-Host ("Published: {0} only, runtime {1}, group {2}. Phones pick it up on the second cold start." -f $Platform, $runtime, $groups[0])
exit 0
