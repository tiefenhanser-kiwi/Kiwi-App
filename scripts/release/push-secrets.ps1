# R3-1 Part A -- push the round-3 secrets from the api-server .env to Secret Manager.
#
#   .\scripts\release\push-secrets.ps1 -DryRun     # parse + plan, runs no gcloud
#   .\scripts\release\push-secrets.ps1             # create / add versions, grant access
#
# Reads REVENUECAT_WEBHOOK_AUTH, REVENUECAT_SECRET_API_KEY, TURNSTILE_SECRET_KEY and
# APPLE_PRIVATE_KEY from -EnvFile and writes each to Secret Manager over STDIN (exact
# bytes, no trailing newline) -- never on a command line, never printed. Prints the
# name, what happened, and the length.
#
# APPLE_REFRESH_TOKEN_ENC_KEY is NOT read from .env: production gets its own, generated
# here (32 random bytes, base64), and ONLY when the secret does not exist yet.
# Rotating it orphans every stored Apple refresh token (DEPLOY.md), so a second run
# leaves it untouched.
#
# Then grants roles/secretmanager.secretAccessor on all five to the runtime service
# account (idempotent). Exits non-zero if any name was skipped.
#
# -Stripe is a separate run that pushes ONLY STRIPE_SECRET_KEY and
# STRIPE_WEBHOOK_SECRET (same stdin path, same binding) and touches nothing above:
#
#   .\scripts\release\push-secrets.ps1 -Stripe -DryRun
#   .\scripts\release\push-secrets.ps1 -Stripe          # test mode: sk_test_ only
#   .\scripts\release\push-secrets.ps1 -Stripe -Live    # the cutover: sk_live_ only
#
# Key-mode guard: without -Live the secret key must start sk_test_, with -Live it
# must start sk_live_; the webhook secret must start whsec_. Stripe values never
# contain whitespace, so any is refused. A Stripe refusal or a missing name stops
# the run before any gcloud call -- a key and a webhook secret from different
# modes must never land half-pushed.
#
# ASCII ONLY (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).

[CmdletBinding()]
param(
  [string]$EnvFile = '',
  [string]$Project = 'kiwi-prod-508416',
  [string]$RuntimeServiceAccount = '166146829159-compute@developer.gserviceaccount.com',
  [switch]$Stripe,
  [switch]$Live,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_release-lib.ps1')

if ($Live -and -not $Stripe) { Write-Host 'REFUSED: -Live only means something with -Stripe'; exit 1 }

if (-not $EnvFile) { $EnvFile = Join-Path $script:RepoRoot 'artifacts\api-server\.env' }

if ($Stripe) {
  $FromEnv = @('STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET')
  $Generated = $null
  $StripeKeyPrefix = if ($Live) { 'sk_live_' } else { 'sk_test_' }
} else {
  $FromEnv = @('REVENUECAT_WEBHOOK_AUTH', 'REVENUECAT_SECRET_API_KEY', 'TURNSTILE_SECRET_KEY', 'APPLE_PRIVATE_KEY')
  $Generated = 'APPLE_REFRESH_TOKEN_ENC_KEY'
}
$Bound = @($FromEnv + @($Generated | Where-Object { $_ }))

$envPath = Assert-EnvFileSafe -Path $EnvFile
$values = Read-DotEnv -Path $envPath

$mode = if (-not $Stripe) { '' } elseif ($Live) { ' STRIPE LIVE MODE' } else { ' stripe test mode' }
Write-Host ("push-secrets{0}{1} - project {2} - env file {3}" -f $mode, $(if ($DryRun) { ' (DRY RUN: no gcloud)' } else { '' }), $Project, $envPath)

# $null when the value is acceptable, else why it is not. Never echoes the value.
function Get-StripeRefusal {
  param([string]$Name, [string]$Value)
  if ($Value -match '\s') { return 'contains whitespace' }
  if ($Name -eq 'STRIPE_SECRET_KEY' -and -not $Value.StartsWith($StripeKeyPrefix, [System.StringComparison]::Ordinal)) {
    $shown = if ($Value.StartsWith('sk_live_', [System.StringComparison]::Ordinal)) { 'sk_live_' } elseif ($Value.StartsWith('sk_test_', [System.StringComparison]::Ordinal)) { 'sk_test_' } else { 'neither sk_test_ nor sk_live_' }
    return ("must start {0}{1}; this one is {2}" -f $StripeKeyPrefix, $(if ($Live) { ' (-Live)' } else { ' (no -Live)' }), $shown)
  }
  if ($Name -eq 'STRIPE_WEBHOOK_SECRET' -and -not $Value.StartsWith('whsec_', [System.StringComparison]::Ordinal)) { return 'must start whsec_' }
  return $null
}

$skipped = New-Object System.Collections.Generic.List[string]
$toPush = [ordered]@{}
foreach ($name in $FromEnv) {
  $v = Get-DotEnvValue -Values $values -Name $name
  if ($null -eq $v) {
    Write-Host "${name}: MISSING in .env - skipped"
    $skipped.Add($name)
    continue
  }
  if ($name -eq 'TURNSTILE_SECRET_KEY' -and (Test-TurnstileDummyKey $v)) {
    Write-Host "${name}: REFUSED - this is a Cloudflare dummy test secret, not a production key - skipped"
    $skipped.Add($name)
    continue
  }
  if ($Stripe) {
    $why = Get-StripeRefusal -Name $name -Value $v
    if ($why) {
      Write-Host "${name}: REFUSED - $why"
      $skipped.Add($name)
      continue
    }
  }
  $toPush[$name] = $v
}

if ($Stripe -and $skipped.Count -gt 0) {
  Write-Host ("REFUSED - nothing pushed: {0}" -f ($skipped -join ', '))
  exit 1
}

if ($DryRun) {
  foreach ($name in $toPush.Keys) {
    Write-Host ("{0}: would create, or add a version if it exists - {1} chars" -f $name, $toPush[$name].Length)
  }
  if ($Generated) { Write-Host ("{0}: would generate (new secret, 44 chars) if absent; exists - untouched otherwise" -f $Generated) }
  foreach ($name in $Bound) {
    Write-Host ("{0}: would grant roles/secretmanager.secretAccessor to {1}" -f $name, $RuntimeServiceAccount)
  }
} else {
  $existing = Get-SecretNames -Project $Project

  foreach ($name in $toPush.Keys) {
    if ($existing -contains $name) {
      $verb = 'version added'
      $args2 = @('secrets', 'versions', 'add', $name, '--data-file=-', "--project=$Project")
    } else {
      $verb = 'created'
      $args2 = @('secrets', 'create', $name, '--data-file=-', '--replication-policy=automatic', "--project=$Project")
    }
    $code = Invoke-GcloudWithStdin -Arguments $args2 -Value $toPush[$name]
    if ($code -ne 0) { Write-Host "${name}: gcloud exited $code - stopping"; exit $code }
    Write-Host ("{0}: {1} - {2} chars" -f $name, $verb, $toPush[$name].Length)
  }

  if (-not $Generated) {
    # -Stripe: nothing is generated.
  } elseif ($existing -contains $Generated) {
    Write-Host "${Generated}: exists - untouched"
  } else {
    $key = New-EncryptionKeyValue
    $code = Invoke-GcloudWithStdin -Arguments @('secrets', 'create', $Generated, '--data-file=-', '--replication-policy=automatic', "--project=$Project") -Value $key
    $len = $key.Length
    $key = $null
    if ($code -ne 0) { Write-Host "${Generated}: gcloud exited $code - stopping"; exit $code }
    Write-Host ("{0}: generated (new secret) - {1} chars" -f $Generated, $len)
  }

  # Bind every one of this run's names that now exists (a name skipped above may
  # still exist from an earlier run; one that does not cannot be bound).
  $existing = Get-SecretNames -Project $Project
  foreach ($name in $Bound) {
    if ($existing -notcontains $name) { Write-Host "${name}: not in Secret Manager - no binding"; continue }
    $r = Invoke-Gcloud -Capture -Arguments @(
      'secrets', 'add-iam-policy-binding', $name,
      '--project', $Project,
      '--member', "serviceAccount:$RuntimeServiceAccount",
      '--role', 'roles/secretmanager.secretAccessor',
      '--condition', 'None',
      '--format', 'none'
    )
    if ($r.ExitCode -ne 0) { Write-Host "${name}: add-iam-policy-binding exited $($r.ExitCode) - stopping"; exit $r.ExitCode }
    Write-Host "${name}: secretAccessor granted to the runtime service account"
  }
}

if ($skipped.Count -gt 0) {
  Write-Host ("SKIPPED: {0}" -f ($skipped -join ', '))
  exit 1
}
Write-Host 'SKIPPED: none'
exit 0
