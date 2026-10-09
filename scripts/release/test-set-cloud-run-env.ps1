# R3-1 Part B -- tests for set-cloud-run-env.ps1. Plain script (no Pester here).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release\test-set-cloud-run-env.ps1
#
# Every case runs against the FAKE Cloud SDK (_fake-gcloud.ps1): the installed
# gcloud.ps1 / gcloud.cmd copied in front of a recording gcloud.py, which parses
# the two list flags with gcloud's own ArgDict. No request reaches Google.
# The argv the fake RECEIVED is pinned against literal strings below -- the
# deliberate break (drop the ^;^ prefix) has to turn this red.
#
# ASCII ONLY.

param([switch]$Keep)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_release-lib.ps1')
. (Join-Path $PSScriptRoot '_fake-gcloud.ps1')

$scratch = Join-Path $script:RepoRoot 'scripts\_scratch\r3-1b'
$fixture = Join-Path $scratch 'fixture.env'
$setEnv = Join-Path $PSScriptRoot 'set-cloud-run-env.ps1'
Write-Fixture -Path $fixture

$AllSecrets = @('DATABASE_URL', 'JWT_SECRET', 'INSTACART_API_KEY', 'REVENUECAT_WEBHOOK_AUTH', 'REVENUECAT_SECRET_API_KEY', 'TURNSTILE_SECRET_KEY', 'APPLE_PRIVATE_KEY', 'APPLE_REFRESH_TOKEN_ENC_KEY')

# --- the pinned argv (fixture values, all fake) -----------------------------------
$PinnedEnvVars = '^;^APPLE_OAUTH_AUDIENCES=com.kitchenwizard.kiwi,com.kitchenwizard.kiwi.web;GOOGLE_OAUTH_CLIENT_IDS=111-web.apps.googleusercontent.com,111-ios.apps.googleusercontent.com,111-android.apps.googleusercontent.com;APPLE_TEAM_ID=FAKETEAM01;APPLE_KEY_ID=FAKEKEY001;APPLE_SERVICES_ID=com.kitchenwizard.kiwi.web;APPLE_WEB_REDIRECT_URI=https://kiwi-api-fake.us-east4.run.app/api/auth/oauth/apple/callback;REVENUECAT_ENTITLEMENT_ID=premium;AI_DAILY_CEILING_USD=50;AI_GUEST_DAILY_CEILING_USD=25;INSTACART_API_BASE_URL=https://connect.instacart.com'
$PinnedSecrets = 'REVENUECAT_WEBHOOK_AUTH=REVENUECAT_WEBHOOK_AUTH:latest,REVENUECAT_SECRET_API_KEY=REVENUECAT_SECRET_API_KEY:latest,TURNSTILE_SECRET_KEY=TURNSTILE_SECRET_KEY:latest,APPLE_PRIVATE_KEY=APPLE_PRIVATE_KEY:latest,APPLE_REFRESH_TOKEN_ENC_KEY=APPLE_REFRESH_TOKEN_ENC_KEY:latest,INSTACART_API_KEY=INSTACART_API_KEY:latest'
$PinnedArgv = @('run', 'services', 'update', 'kiwi-api', '--region', 'us-east4', '--project', 'kiwi-prod-508416', '--update-env-vars', $PinnedEnvVars, '--update-secrets', $PinnedSecrets)

$ExpectedEnv = [ordered]@{
  APPLE_OAUTH_AUDIENCES      = 'com.kitchenwizard.kiwi,com.kitchenwizard.kiwi.web'
  GOOGLE_OAUTH_CLIENT_IDS    = '111-web.apps.googleusercontent.com,111-ios.apps.googleusercontent.com,111-android.apps.googleusercontent.com'
  APPLE_TEAM_ID              = 'FAKETEAM01'
  APPLE_KEY_ID               = 'FAKEKEY001'
  APPLE_SERVICES_ID          = 'com.kitchenwizard.kiwi.web'
  APPLE_WEB_REDIRECT_URI     = 'https://kiwi-api-fake.us-east4.run.app/api/auth/oauth/apple/callback'
  REVENUECAT_ENTITLEMENT_ID  = 'premium'
  AI_DAILY_CEILING_USD       = '50'
  AI_GUEST_DAILY_CEILING_USD = '25'
  INSTACART_API_BASE_URL     = 'https://connect.instacart.com'
}

function New-ServiceShape {
  param([hashtable[]]$Env)
  return @{
    spec   = @{ template = @{ spec = @{ containers = @(@{ image = 'us-east4-docker.pkg.dev/fake/cloud-run-source-deploy/kiwi-api@sha256:' + ('a' * 64); env = $Env }) } } }
    status = @{ latestReadyRevisionName = 'kiwi-api-00042-abc'; latestCreatedRevisionName = 'kiwi-api-00042-abc' }
  }
}
$baseEnv = @(
  @{ name = 'NODE_ENV'; value = 'production' },
  @{ name = 'AI_DAILY_CEILING_USD'; value = '10' },
  @{ name = 'DATABASE_URL'; valueFrom = @{ secretKeyRef = @{ key = 'latest'; name = 'DATABASE_URL' } } },
  @{ name = 'INSTACART_API_KEY'; valueFrom = @{ secretKeyRef = @{ key = 'latest'; name = 'INSTACART_API_KEY' } } }
)

function Get-Prop2 { param($Object, [string]$Name) $p = $Object.PSObject.Properties[$Name]; if ($p) { $p.Value } else { $null } }
function Get-Updates { param($Fake) @(Read-FakeGcloudLog $Fake | Where-Object { $_.argv[0] -eq 'run' -and $_.argv[2] -eq 'update' }) }

if (-not (Get-RealSdkRoot)) { Write-Host 'SKIP: no Cloud SDK installed to copy the shims from'; exit 0 }

Write-Host '== -DryRun transcript (fixture, fake SDK, fake service)'
$fake = New-FakeGcloud -Root (Join-Path $scratch 'fakesdk') -Secrets $AllSecrets -Service (New-ServiceShape $baseEnv)
$r = Invoke-ReleaseScript -Script $setEnv -Arguments @('-DryRun', '-EnvFile', $fixture)
$r.Lines | Where-Object { $_ -notlike '!! TEST SEAM*' } | ForEach-Object { Write-Host "    | $_" }
Assert-Equal $r.ExitCode 0 'dry run exits 0'
Assert-Equal @(Get-Updates $fake).Count 0 'dry run sends no update'
Assert-True ($r.Text -like '*TRUST_PROXY_HOPS: unset*') 'TRUST_PROXY_HOPS reported unset'
Assert-True ($r.Text -like '*Current secret env (2): DATABASE_URL<-DATABASE_URL:latest, INSTACART_API_KEY<-INSTACART_API_KEY:latest*') 'current secret names listed'
Assert-True ($r.Text.Contains(('[9] ^;^APPLE_OAUTH_AUDIENCES=com.***({0});' -f $ExpectedEnv.APPLE_OAUTH_AUDIENCES.Length))) 'masked argv element 9 starts ^;^ with a masked first value'
Assert-True ($r.Text -like '*AI_DAILY_CEILING_USD=50;AI_GUEST_DAILY_CEILING_USD=25;INSTACART_API_BASE_URL=https://connect.instacart.com*') 'ruled constants shown unmasked'
foreach ($k in 'APPLE_OAUTH_AUDIENCES', 'GOOGLE_OAUTH_CLIENT_IDS', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'APPLE_WEB_REDIRECT_URI') {
  Assert-True ($r.Text -notlike ('*' + $ExpectedEnv[$k] + '*')) "$k never printed whole"
}

Write-Host '== live path against the fake: the argv gcloud.py RECEIVED'
$fake = New-FakeGcloud -Root (Join-Path $scratch 'fakesdk') -Secrets $AllSecrets -Service (New-ServiceShape ($baseEnv + @(@{ name = 'TRUST_PROXY_HOPS'; value = '1' })))
$r = Invoke-ReleaseScript -Script $setEnv -Arguments @('-EnvFile', $fixture)
$r.Lines | Where-Object { $_ -notlike '!! TEST SEAM*' } | Select-Object -Last 4 | ForEach-Object { Write-Host "    | $_" }
Assert-Equal $r.ExitCode 0 'live run exits 0'
$u = @(Get-Updates $fake)
Assert-Equal $u.Count 1 'exactly one update call'
if ($u.Count -eq 1) {
  Assert-Equal (@($u[0].argv) -join ' | ') ($PinnedArgv -join ' | ') 'argv pinned: --update-env-vars is ONE element with the ^;^ prefix'
  Assert-True (-not ($u[0].PSObject.Properties['parse_error'])) "gcloud's ArgDict accepted both lists"
  $parsed = $u[0].PSObject.Properties['env_dict']
  if ($parsed) {
    $d = $parsed.Value
    Assert-Equal @($d.PSObject.Properties).Count $ExpectedEnv.Count 'ArgDict produced exactly the ten env vars'
    foreach ($k in $ExpectedEnv.Keys) { Assert-Equal (Get-Prop2 $d $k) $ExpectedEnv[$k] "ArgDict: $k" }
    foreach ($p in $d.PSObject.Properties) {
      Assert-True ($p.Name -notmatch '^(AI_USER_DAILY_CALLS|AI_DISABLED|AI_GUEST_DISABLED|TRUST_PROXY_HOPS|BILLING_ENFORCED|PUBLIC_APP_URL|STRIPE_.*)$') "$($p.Name) is not on the leave-alone list"
    }
  }
  $s = $u[0].PSObject.Properties['secrets_dict']
  if ($s) { Assert-Equal @($s.Value.PSObject.Properties).Count 6 'ArgDict produced six secret refs' }
}
Assert-True ($r.Text -like "*TRUST_PROXY_HOPS: set, value '1'*") 'TRUST_PROXY_HOPS value read back when set'
Assert-True ($r.Text -like '*New revision: kiwi-api-00099-new*') 'new revision name printed'

Write-Host '== refusals (each must change nothing)'
$cases = @(
  @{ label = 'plain TURNSTILE_SECRET_KEY already on the service'; secrets = $AllSecrets; env = ($baseEnv + @(@{ name = 'TURNSTILE_SECRET_KEY'; value = 'x' })); replace = @{}; expect = '*TURNSTILE_SECRET_KEY: is a PLAIN env var on the service now*' },
  @{ label = 'a secret not in Secret Manager yet'; secrets = @($AllSecrets | Where-Object { $_ -ne 'APPLE_REFRESH_TOKEN_ENC_KEY' }); env = $baseEnv; replace = @{}; expect = '*APPLE_REFRESH_TOKEN_ENC_KEY: not in Secret Manager - run push-secrets.ps1 first*' },
  @{ label = 'a required value blank in .env'; secrets = $AllSecrets; env = $baseEnv; replace = @{ APPLE_TEAM_ID = '' }; expect = '*APPLE_TEAM_ID: MISSING in .env*' },
  @{ label = 'a dev host'; secrets = $AllSecrets; env = $baseEnv; replace = @{ APPLE_WEB_REDIRECT_URI = 'http://192.168.1.20:3000/api/auth/oauth/apple/callback' }; expect = '*APPLE_WEB_REDIRECT_URI: points at a dev host*' },
  @{ label = 'Services ID missing from the audiences'; secrets = $AllSecrets; env = $baseEnv; replace = @{ APPLE_OAUTH_AUDIENCES = 'com.kitchenwizard.kiwi' }; expect = '*APPLE_SERVICES_ID: not in APPLE_OAUTH_AUDIENCES*' },
  @{ label = 'a value containing the delimiter'; secrets = $AllSecrets; env = $baseEnv; replace = @{ APPLE_KEY_ID = 'AB;CD' }; expect = "*APPLE_KEY_ID: contains ';'*" }
)
foreach ($c in $cases) {
  $fx = Join-Path $scratch 'case.env'
  Write-Fixture -Path $fx -Replace $c.replace
  $fake = New-FakeGcloud -Root (Join-Path $scratch 'fakesdk') -Secrets $c.secrets -Service (New-ServiceShape $c.env)
  $r = Invoke-ReleaseScript -Script $setEnv -Arguments @('-EnvFile', $fx)
  Assert-True ($r.ExitCode -eq 1 -and $r.Text -like '*REFUSED - nothing changed*' -and $r.Text -like $c.expect) "refused: $($c.label)"
  Assert-Equal @(Get-Updates $fake).Count 0 "  no update sent: $($c.label)"
}

Remove-FakeGcloudEnv
if (-not $Keep) { Remove-Item -LiteralPath $scratch -Recurse -Force }
Write-Host ''
if ($script:Failures -gt 0) { Write-Host "FAILED: $($script:Failures)" -ForegroundColor Red; exit 1 }
Write-Host 'ALL PASS'
exit 0
