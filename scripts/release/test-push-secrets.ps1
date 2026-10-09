# R3-1 Part A -- tests for push-secrets.ps1 and the .env parser. No Pester on this
# machine, so a plain script: PASS/FAIL per assertion, exit 1 on any FAIL.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release\test-push-secrets.ps1
#
# Touches nothing outside scripts\_scratch\r3-1 (removed at the end unless -Keep).
# The "live" cases run against a FAKE Cloud SDK (_fake-gcloud.ps1): the real shims,
# a recorder for gcloud.py. No request reaches Google.
#
# ASCII ONLY.

param([switch]$Keep)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_release-lib.ps1')
. (Join-Path $PSScriptRoot '_fake-gcloud.ps1')

$scratch = Join-Path $script:RepoRoot 'scripts\_scratch\r3-1'
$fixture = Join-Path $scratch 'fixture.env'
$fixtureBad = Join-Path $scratch 'fixture-missing.env'
$push = Join-Path $PSScriptRoot 'push-secrets.ps1'
Write-Fixture -Path $fixture
Write-Fixture -Path $fixtureBad -Replace @{ REVENUECAT_SECRET_API_KEY = ''; TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA' }

$expected = [ordered]@{
  REVENUECAT_WEBHOOK_AUTH   = 'Bearer fake-webhook-auth-0001'
  REVENUECAT_SECRET_API_KEY = 'sk_fake_secret_api_key_0002'
  TURNSTILE_SECRET_KEY      = '0x4AAAAAAAfake_turnstile_0003'
  APPLE_PRIVATE_KEY         = '-----BEGIN PRIVATE KEY-----\nMIGTfakeLINEone\nfakeLINEtwo\n-----END PRIVATE KEY-----'
}

Write-Host '== Read-DotEnv'
$v = Read-DotEnv -Path $fixture
foreach ($k in $expected.Keys) { Assert-Equal $v[$k] $expected[$k] "$k parsed exactly" }
Assert-True ($v['APPLE_PRIVATE_KEY'].Contains('\n') -and -not $v['APPLE_PRIVATE_KEY'].Contains("`n")) 'literal \n kept as two characters, no real newline'
Assert-Equal $v['LOG_LEVEL'] 'info' 'export prefix dropped'
Assert-Equal $v['MULTI_LINE'] "first line`nsecond line" 'quoted value spans lines'
Assert-Equal $v['DUP'] 'second' 'last occurrence wins'
Assert-Equal $v['HASH_IN_QUOTES'] 'a#b' "'#' inside quotes is value, not comment"
Assert-True ($null -eq (Get-DotEnvValue -Values $v -Name 'EMPTY_ONE')) 'KEY= with no value counts as missing'
Assert-True ($null -eq (Get-DotEnvValue -Values $v -Name 'EMPTY_QUOTED')) 'KEY="" counts as missing'
Assert-True ($null -eq (Get-DotEnvValue -Values $v -Name 'NOT_THERE')) 'absent key counts as missing'
Assert-True (-not $v.Contains('# R3-1 FIXTURE -- every value in this file is FAKE.')) 'comment line ignored'
$threw = $false
$bad = Join-Path $scratch 'unterminated.env'
[System.IO.File]::WriteAllText($bad, "A=1`r`nAPPLE_PRIVATE_KEY=`"never closed`r`nB=2`r`n")
try { Read-DotEnv -Path $bad | Out-Null } catch { $threw = $_.Exception.Message -like '*unterminated quote for APPLE_PRIVATE_KEY*' }
Assert-True $threw 'unterminated quote throws, naming the key'
Assert-True (Test-TurnstileDummyKey '1x0000000000000000000000000000000AA') 'Cloudflare dummy secret recognised'
Assert-True (-not (Test-TurnstileDummyKey $expected.TURNSTILE_SECRET_KEY)) 'a real-shaped key is not a dummy'

Write-Host '== guards'
$r = Invoke-ReleaseScript -Script $push -Arguments @('-DryRun', '-EnvFile', (Join-Path $script:RepoRoot 'artifacts\api-server\.env.example'))
Assert-True ($r.ExitCode -ne 0 -and $r.Text -like '*REFUSED*tracked by git*') 'a tracked env file is refused'
$r = Invoke-ReleaseScript -Script $push -Arguments @('-DryRun', '-EnvFile', (Join-Path $scratch 'nope.env'))
Assert-True ($r.ExitCode -ne 0 -and $r.Text -like '*Env file not found*') 'a missing env file is refused'

Write-Host '== -DryRun transcript (fixture, fake values)'
Remove-FakeGcloudEnv
$r = Invoke-ReleaseScript -Script $push -Arguments @('-DryRun', '-EnvFile', $fixture)
$r.Lines | ForEach-Object { Write-Host "    | $_" }
Assert-Equal $r.ExitCode 0 'dry run exits 0'
foreach ($k in $expected.Keys) {
  Assert-True ($r.Text -like ("*{0}: would create, or add a version if it exists - {1} chars*" -f $k, $expected[$k].Length)) "$k reported with length $($expected[$k].Length)"
}
Assert-True ($r.Text -like '*APPLE_REFRESH_TOKEN_ENC_KEY: would generate (new secret, 44 chars) if absent*') 'generated-key branch reported'
Assert-True ($r.Text -notlike '*TEST SEAM*') 'dry run resolved no gcloud'
foreach ($val in @($expected.Values) + 'dev-enc-key-must-never-be-pushed') { Assert-True ($r.Text -notlike "*$val*") 'no value echoed' }

$fake = New-FakeGcloud -Root (Join-Path $scratch 'fakesdk')
if (-not $fake) {
  Write-Host '  SKIP  live-path cases: no Cloud SDK installed to copy the shims from'
} else {
  Write-Host '== live path against the fake SDK, first run (no secrets exist)'
  $r = Invoke-ReleaseScript -Script $push -Arguments @('-EnvFile', $fixture)
  $r.Lines | ForEach-Object { Write-Host "    | $_" }
  Assert-Equal $r.ExitCode 0 'first run exits 0'
  $log = Read-FakeGcloudLog $fake
  foreach ($k in $expected.Keys) {
    $call = @($log | Where-Object { $_.argv[0] -eq 'secrets' -and $_.argv[1] -eq 'create' -and $_.argv[2] -eq $k })
    Assert-Equal $call.Count 1 "$k created once"
    if ($call.Count -eq 1) {
      Assert-Equal $call[0].stdin_sha256 (Get-Sha256Hex $expected[$k]) "$k stdin bytes exact (no BOM, no trailing newline)"
      Assert-True (@($call[0].argv) -contains '--replication-policy=automatic') "$k replication automatic"
    }
  }
  $gen = @($log | Where-Object { $_.argv[1] -eq 'create' -and $_.argv[2] -eq 'APPLE_REFRESH_TOKEN_ENC_KEY' })
  Assert-Equal $gen.Count 1 'encryption key created once'
  if ($gen.Count -eq 1) {
    Assert-Equal $gen[0].stdin_len 44 'encryption key is 44 base64 chars on stdin'
    Assert-True ($gen[0].stdin_sha256 -ne (Get-Sha256Hex 'dev-enc-key-must-never-be-pushed')) 'the dev .env encryption key is NOT what was pushed'
  }
  Assert-True ($r.Text -like '*APPLE_REFRESH_TOKEN_ENC_KEY: generated (new secret) - 44 chars*') 'generated line printed'
  $binds = @($log | Where-Object { $_.argv[1] -eq 'add-iam-policy-binding' })
  Assert-Equal $binds.Count 5 'five accessor bindings'
  Assert-True (@($binds | Where-Object { (@($_.argv) -join ' ') -like '*--member serviceAccount:166146829159-compute@developer.gserviceaccount.com --role roles/secretmanager.secretAccessor*' }).Count -eq 5) 'bindings name the runtime SA and accessor role, intact through gcloud.ps1'
  $allArgv = (@($log | ForEach-Object { @($_.argv) -join ' ' }) -join "`n")
  foreach ($val in $expected.Values) { Assert-True ($allArgv -notlike "*$val*") 'no secret value on any command line' }
  foreach ($val in $expected.Values) { Assert-True ($r.Text -notlike "*$val*") 'no secret value printed' }

  Write-Host '== live path, second run (all five exist)'
  Clear-FakeGcloudLog $fake
  $r = Invoke-ReleaseScript -Script $push -Arguments @('-EnvFile', $fixture)
  $r.Lines | ForEach-Object { Write-Host "    | $_" }
  Assert-Equal $r.ExitCode 0 'second run exits 0'
  $log = Read-FakeGcloudLog $fake
  Assert-Equal @($log | Where-Object { $_.argv[1] -eq 'create' }).Count 0 'nothing created on the second run'
  Assert-Equal @($log | Where-Object { $_.argv[1] -eq 'versions' -and $_.argv[2] -eq 'add' }).Count 4 'four versions added'
  Assert-Equal @($log | Where-Object { $_.argv -contains 'APPLE_REFRESH_TOKEN_ENC_KEY' -and $_.argv -contains '--data-file=-' }).Count 0 'encryption key never rewritten'
  Assert-True ($r.Text -like '*APPLE_REFRESH_TOKEN_ENC_KEY: exists - untouched*') 'untouched line printed'

  Write-Host '== live path, missing + dummy values'
  $fake = New-FakeGcloud -Root (Join-Path $scratch 'fakesdk')
  $r = Invoke-ReleaseScript -Script $push -Arguments @('-EnvFile', $fixtureBad)
  $r.Lines | ForEach-Object { Write-Host "    | $_" }
  Assert-True ($r.ExitCode -ne 0) 'exits non-zero when anything was skipped'
  Assert-True ($r.Text -like '*REVENUECAT_SECRET_API_KEY: MISSING in .env - skipped*') 'blank value reported MISSING'
  Assert-True ($r.Text -like '*TURNSTILE_SECRET_KEY: REFUSED - this is a Cloudflare dummy test secret*') 'dummy Turnstile secret refused'
  Assert-True ($r.Text -like '*SKIPPED: REVENUECAT_SECRET_API_KEY, TURNSTILE_SECRET_KEY*') 'final line lists every skipped name'
  $log = Read-FakeGcloudLog $fake
  Assert-Equal @($log | Where-Object { $_.argv[1] -eq 'create' }).Count 3 'the other two + the generated key still pushed'
}

Remove-FakeGcloudEnv
if (-not $Keep) { Remove-Item -LiteralPath $scratch -Recurse -Force }
Write-Host ''
if ($script:Failures -gt 0) { Write-Host "FAILED: $($script:Failures)" -ForegroundColor Red; exit 1 }
Write-Host 'ALL PASS'
exit 0
