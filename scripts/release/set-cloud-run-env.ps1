# R3-1 Part B -- put the round-3 config on the Cloud Run service in ONE update.
#
#   .\scripts\release\set-cloud-run-env.ps1 -DryRun   # reads the service, prints the masked command
#   .\scripts\release\set-cloud-run-env.ps1           # runs it -> one new revision
#
# Plain env vars from -EnvFile: APPLE_OAUTH_AUDIENCES, GOOGLE_OAUTH_CLIENT_IDS,
# APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_SERVICES_ID, APPLE_WEB_REDIRECT_URI, and
# REVENUECAT_ENTITLEMENT_ID if present. Plain env vars set to RULED CONSTANTS:
# AI_DAILY_CEILING_USD=50, AI_GUEST_DAILY_CEILING_USD=25 (D-WS9-261),
# INSTACART_API_BASE_URL=https://connect.instacart.com. Secrets by reference
# (NAME=NAME:latest) for the five push-secrets.ps1 writes plus INSTACART_API_KEY.
#
# Left alone, by construction (--update-env-vars touches only the names it is given):
# AI_USER_DAILY_CALLS, AI_DISABLED, AI_GUEST_DISABLED, TRUST_PROXY_HOPS,
# BILLING_ENFORCED, every STRIPE_*, PUBLIC_APP_URL.
#
# THE DELIMITER IS ^;^, NOT ^:^. gcloud's ArgDict splits the list on every
# occurrence of the custom delimiter, and APPLE_WEB_REDIRECT_URI and
# INSTACART_API_BASE_URL contain "https:" -- with ^:^ gcloud answers
# "Bad syntax for dict arg: [//...]". The whole list is ONE argv element, handed
# by gcloud.ps1 to Python as an array element (no cmd.exe in the path).
#
# Before changing anything: prints the service's current env NAMES, the current
# TRUST_PROXY_HOPS value, the image and its digest. Refuses (exit 1) on a missing
# value, a dev host, a plain/secret type conflict, or a secret not yet in Secret
# Manager. A gcloud failure stops with its exit code; nothing is retried.
#
# ASCII ONLY (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).

[CmdletBinding()]
param(
  [string]$EnvFile = '',
  [string]$Service = 'kiwi-api',
  [string]$Region = 'us-east4',
  [string]$Project = 'kiwi-prod-508416',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_release-lib.ps1')

if (-not $EnvFile) { $EnvFile = Join-Path $script:RepoRoot 'artifacts\api-server\.env' }

$EnvVarsDelimiter = ';'
$FromEnvRequired = @('APPLE_OAUTH_AUDIENCES', 'GOOGLE_OAUTH_CLIENT_IDS', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_SERVICES_ID', 'APPLE_WEB_REDIRECT_URI')
$FromEnvOptional = @('REVENUECAT_ENTITLEMENT_ID')
$Constants = [ordered]@{
  AI_DAILY_CEILING_USD       = '50'
  AI_GUEST_DAILY_CEILING_USD = '25'
  INSTACART_API_BASE_URL     = 'https://connect.instacart.com'
}
$SecretNames = @('REVENUECAT_WEBHOOK_AUTH', 'REVENUECAT_SECRET_API_KEY', 'TURNSTILE_SECRET_KEY', 'APPLE_PRIVATE_KEY', 'APPLE_REFRESH_TOKEN_ENC_KEY', 'INSTACART_API_KEY')
$NeverTouch = '^(AI_USER_DAILY_CALLS|AI_DISABLED|AI_GUEST_DISABLED|TRUST_PROXY_HOPS|BILLING_ENFORCED|PUBLIC_APP_URL|STRIPE_.*)$'

# '^;^NAME=value;NAME=value' -- ONE argv element.
function Format-EnvVarsArg {
  param([Parameter(Mandatory = $true)]$Pairs, [switch]$Masked)
  $items = foreach ($k in $Pairs.Keys) {
    $v = [string]$Pairs[$k]
    if ($v.Contains($EnvVarsDelimiter)) { throw "REFUSED: $k contains the env-vars delimiter '$EnvVarsDelimiter'" }
    if ($v -match '[\r\n"]') { throw "REFUSED: $k contains a newline or double quote" }
    if ($Masked -and -not $Constants.Contains($k)) { $v = Format-Masked $v }
    '{0}={1}' -f $k, $v
  }
  return ('^{0}^' -f $EnvVarsDelimiter) + [string]::Join($EnvVarsDelimiter, [string[]]$items)
}

function Format-SecretsArg {
  param([Parameter(Mandatory = $true)][string[]]$Names)
  return [string]::Join(',', [string[]]($Names | ForEach-Object { '{0}={0}:latest' -f $_ }))
}

function New-UpdateArgv {
  param($Pairs, [switch]$Masked)
  return @(
    'run', 'services', 'update', $Service,
    '--region', $Region,
    '--project', $Project,
    '--update-env-vars', (Format-EnvVarsArg -Pairs $Pairs -Masked:$Masked),
    '--update-secrets', (Format-SecretsArg -Names $SecretNames)
  )
}

function Get-Prop {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $p = $Object.PSObject.Properties[$Name]
  if ($p) { return $p.Value } else { return $null }
}

# --- 1. values ----------------------------------------------------------------------

$envPath = Assert-EnvFileSafe -Path $EnvFile
$values = Read-DotEnv -Path $envPath
Write-Host ("set-cloud-run-env{0} - {1} / {2} / {3} - env file {4}" -f $(if ($DryRun) { ' (DRY RUN: reads only)' } else { '' }), $Service, $Region, $Project, $envPath)

$problems = New-Object System.Collections.Generic.List[string]
$pairs = [ordered]@{}
foreach ($name in $FromEnvRequired + $FromEnvOptional) {
  $v = Get-DotEnvValue -Values $values -Name $name
  if ($null -eq $v) {
    if ($FromEnvOptional -contains $name) { Write-Host "${name}: absent in .env - not set (server default applies)" }
    else { $problems.Add("${name}: MISSING in .env") }
    continue
  }
  $pairs[$name] = $v.Trim()
}
foreach ($k in $Constants.Keys) { $pairs[$k] = $Constants[$k] }

foreach ($k in @($pairs.Keys)) {
  $v = $pairs[$k]
  if ($k -match $NeverTouch) { $problems.Add("${k}: is on the leave-alone list - script bug") }
  if ($v -match 'localhost|127\.0\.0\.1|192\.168\.|//10\.\d|\.local(/|$)') { $problems.Add("${k}: points at a dev host") }
  if ($v.Contains($EnvVarsDelimiter)) { $problems.Add("${k}: contains '$EnvVarsDelimiter' (the list delimiter)") }
  if ($v -match '[\r\n"]') { $problems.Add("${k}: contains a newline or double quote") }
}
if ($pairs.Contains('APPLE_SERVICES_ID') -and $pairs.Contains('APPLE_OAUTH_AUDIENCES')) {
  $aud = @($pairs['APPLE_OAUTH_AUDIENCES'] -split ',' | ForEach-Object { $_.Trim() })
  if ($aud -cnotcontains $pairs['APPLE_SERVICES_ID']) { $problems.Add('APPLE_SERVICES_ID: not in APPLE_OAUTH_AUDIENCES (boot logs an error and no web token verifies)') }
}

# --- 2. the service as it is (read-only) ---------------------------------------------

$r = Invoke-Gcloud -Capture -Arguments @('run', 'services', 'describe', $Service, '--region', $Region, '--project', $Project, '--format', 'json')
if ($r.ExitCode -ne 0) { Write-Host "gcloud run services describe exited $($r.ExitCode) - stopping"; exit $r.ExitCode }
$svc = $r.Output | ConvertFrom-Json
$container = @((Get-Prop (Get-Prop (Get-Prop $svc 'spec') 'template') 'spec').containers)[0]
$plainNow = New-Object System.Collections.Generic.List[string]
$secretNow = New-Object System.Collections.Generic.List[string]
$trustProxyHops = $null
foreach ($e in @(Get-Prop $container 'env')) {
  if ($null -eq $e) { continue }
  $ref = Get-Prop (Get-Prop $e 'valueFrom') 'secretKeyRef'
  if ($ref) { $secretNow.Add(('{0}<-{1}:{2}' -f $e.name, $ref.name, $ref.key)) }
  else {
    $plainNow.Add($e.name)
    if ($e.name -eq 'TRUST_PROXY_HOPS') { $trustProxyHops = [string](Get-Prop $e 'value') }
  }
}
$secretNowNames = @($secretNow | ForEach-Object { ($_ -split '<-')[0] })
$readyRev = Get-Prop (Get-Prop $svc 'status') 'latestReadyRevisionName'

Write-Host ''
Write-Host ("Current plain env ({0}): {1}" -f $plainNow.Count, ((@($plainNow) | Sort-Object) -join ', '))
Write-Host ("Current secret env ({0}): {1}" -f $secretNow.Count, ((@($secretNow) | Sort-Object) -join ', '))
Write-Host ("TRUST_PROXY_HOPS: {0}" -f $(if ($null -ne $trustProxyHops) { "set, value '$trustProxyHops'" } else { 'unset' }))
Write-Host ("Image: {0}" -f (Get-Prop $container 'image'))
Write-Host ("Serving revision: {0}" -f $readyRev)
if ($readyRev) {
  $d = Invoke-Gcloud -Capture -Arguments @('run', 'revisions', 'describe', $readyRev, '--region', $Region, '--project', $Project, '--format', 'value(status.imageDigest)')
  Write-Host ("Serving image digest: {0}" -f $(if ($d.ExitCode -eq 0) { $d.Output.Trim() } else { "<revisions describe exited $($d.ExitCode)>" }))
}

foreach ($n in $SecretNames) {
  if ($plainNow -contains $n) { $problems.Add("${n}: is a PLAIN env var on the service now; --update-secrets cannot change its type. Remove it first (gcloud run services update $Service --region $Region --remove-env-vars $n) - that is a new revision with the feature off.") }
}
foreach ($n in $pairs.Keys) {
  if ($secretNowNames -contains $n) { $problems.Add("${n}: is a SECRET-backed var on the service now; refusing to turn it into plain env.") }
}

$existingSecrets = Get-SecretNames -Project $Project
foreach ($n in $SecretNames) {
  if ($existingSecrets -notcontains $n) { $problems.Add("${n}: not in Secret Manager - run push-secrets.ps1 first") }
}

# --- 3. the command ------------------------------------------------------------------

Write-Host ''
Write-Host 'Env vars this update sets (values masked to 4 chars + length; ruled constants shown):'
foreach ($k in $pairs.Keys) {
  Write-Host ("  {0} = {1}" -f $k, $(if ($Constants.Contains($k)) { $pairs[$k] } else { Format-Masked $pairs[$k] }))
}
Write-Host ("Secrets this update references: {0}" -f ($SecretNames -join ', '))

Write-Host ''
try {
  $masked = New-UpdateArgv -Pairs $pairs -Masked
  Write-Host 'argv (one element per line, masked):'
  for ($i = 0; $i -lt $masked.Count; $i++) { Write-Host ("  [{0}] {1}" -f $i, $masked[$i]) }
} catch {
  Write-Host "argv not built: $($_.Exception.Message)"
}

if ($problems.Count -gt 0) {
  Write-Host ''
  Write-Host 'REFUSED - nothing changed:'
  $problems | ForEach-Object { Write-Host "  $_" }
  exit 1
}

if ($DryRun) {
  Write-Host ''
  Write-Host 'DRY RUN - not run.'
  exit 0
}

# --- 4. run it --------------------------------------------------------------------

$argv = New-UpdateArgv -Pairs $pairs
$u = Invoke-Gcloud -Arguments $argv
if ($u.ExitCode -ne 0) { Write-Host "gcloud run services update exited $($u.ExitCode) - stopping, nothing retried"; exit $u.ExitCode }

$after = Invoke-Gcloud -Capture -Arguments @('run', 'services', 'describe', $Service, '--region', $Region, '--project', $Project, '--format', 'value(status.latestCreatedRevisionName,status.latestReadyRevisionName)')
if ($after.ExitCode -ne 0) { Write-Host "describe after update exited $($after.ExitCode)"; exit $after.ExitCode }
$revs = @($after.Output.Trim() -split '\s+')
Write-Host ''
Write-Host ("New revision: {0}" -f $revs[0])
if ($revs.Count -gt 1 -and $revs[0] -ne $revs[1]) {
  Write-Host ("WARNING: serving revision is {0}, not the new one - read the new revision's boot log." -f $revs[1])
}
Write-Host 'Next: read the boot lines (Billing / OAuth / AI spend guard / Turnstile) in the new revision log.'
exit 0
