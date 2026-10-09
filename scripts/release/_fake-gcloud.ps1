# R3-1 -- test harness: a fake Cloud SDK for the release scripts. Dot-sourced by
# the test-*.ps1 files, never by a release script.
#
# The fake keeps the parts that matter and replaces only the part that talks to
# Google: bin\gcloud.ps1 and bin\gcloud.cmd are byte-for-byte COPIES of the
# installed shims (so PowerShell's argument passing and cmd.exe's are the real
# ones), lib\gcloud.py is a recorder. The recorder runs on the SDK's own bundled
# Python, logs argv + a sha256 of stdin (never the bytes) to a JSONL file, and
# parses --update-env-vars / --update-secrets with gcloud's REAL ArgDict
# (googlecloudsdk.calliope.arg_parsers) -- so a delimiter mistake fails here the
# way it would fail against Cloud Run.
#
# ASCII ONLY.

function Get-RealSdkRoot {
  $cmdInfo = Get-Command gcloud.ps1 -CommandType ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cmdInfo) { return $null }
  return (Resolve-Path (Join-Path (Split-Path $cmdInfo.Source) '..')).Path
}

$script:FakeGcloudPy = @'
import sys, os, json, hashlib

argv = sys.argv[1:]
state_path = os.environ['FAKE_GCLOUD_STATE']
with open(state_path) as f:
    state = json.load(f)
entry = {'argv': argv}
code = 0
out = ''

if '--data-file=-' in argv:
    data = sys.stdin.buffer.read()
    entry['stdin_len'] = len(data)
    entry['stdin_sha256'] = hashlib.sha256(data).hexdigest()

def parse_dict(v):
    lib = os.environ['FAKE_GCLOUD_SDK_LIB']
    sys.path[0:0] = [lib, os.path.join(lib, 'third_party')]
    from googlecloudsdk.calliope import arg_parsers
    return dict(arg_parsers.ArgDict()(v))

def flag(name):
    return argv[argv.index(name) + 1]

if argv[:2] == ['secrets', 'list']:
    out = '\n'.join(state['secrets'])
elif argv[:2] == ['secrets', 'create']:
    state['secrets'].append(argv[2])
elif argv[:3] == ['secrets', 'versions', 'add'] or argv[:2] == ['secrets', 'add-iam-policy-binding']:
    pass
elif argv[:3] == ['run', 'services', 'describe']:
    if flag('--format') == 'json':
        out = json.dumps(state['service'])
    else:
        st = state['service']['status']
        out = st['latestCreatedRevisionName'] + '\t' + st['latestReadyRevisionName']
elif argv[:3] == ['run', 'revisions', 'describe']:
    out = 'sha256:' + '0' * 64
elif argv[:3] == ['run', 'services', 'update']:
    try:
        entry['env_dict'] = parse_dict(flag('--update-env-vars'))
        entry['secrets_dict'] = parse_dict(flag('--update-secrets'))
    except Exception as e:
        entry['parse_error'] = str(e)
        code = 2
    if code == 0:
        state['service']['status']['latestCreatedRevisionName'] = 'kiwi-api-00099-new'
        state['service']['status']['latestReadyRevisionName'] = 'kiwi-api-00099-new'
else:
    entry['unknown'] = True
    code = 3

entry['exit'] = code
with open(os.environ['FAKE_GCLOUD_LOG'], 'a') as f:
    f.write(json.dumps(entry) + '\n')
with open(state_path, 'w') as f:
    json.dump(state, f)
if out:
    print(out)
sys.exit(code)
'@

# Builds the fake under $Root and points the release scripts at it through the
# environment of THIS process (children inherit it). Returns $null when no Cloud
# SDK is installed -- the caller skips the end-to-end tests and says so.
function New-FakeGcloud {
  param([Parameter(Mandatory = $true)][string]$Root, [string[]]$Secrets = @(), $Service = $null)
  $sdk = Get-RealSdkRoot
  if (-not $sdk) { return $null }
  $py = Join-Path $sdk 'platform\bundledpython\python.exe'
  if (-not (Test-Path -LiteralPath $py)) { return $null }
  if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
  $bin = Join-Path $Root 'bin'
  $lib = Join-Path $Root 'lib'
  New-Item -ItemType Directory -Force $bin, $lib | Out-Null
  Copy-Item -LiteralPath (Join-Path $sdk 'bin\gcloud.ps1') -Destination $bin
  Copy-Item -LiteralPath (Join-Path $sdk 'bin\gcloud.cmd') -Destination $bin
  [System.IO.File]::WriteAllText((Join-Path $lib 'gcloud.py'), $script:FakeGcloudPy, (New-Object System.Text.UTF8Encoding($false)))
  if ($null -eq $Service) {
    $Service = @{
      spec   = @{ template = @{ spec = @{ containers = @(@{
                image = 'us-east4-docker.pkg.dev/fake/cloud-run-source-deploy/kiwi-api@sha256:' + ('a' * 64)
                env   = @(
                  @{ name = 'NODE_ENV'; value = 'production' },
                  @{ name = 'AI_DAILY_CEILING_USD'; value = '10' },
                  @{ name = 'DATABASE_URL'; valueFrom = @{ secretKeyRef = @{ key = 'latest'; name = 'DATABASE_URL' } } }
                )
              }) } } }
      status = @{ latestReadyRevisionName = 'kiwi-api-00042-abc'; latestCreatedRevisionName = 'kiwi-api-00042-abc' }
    }
  }
  $state = @{ secrets = @($Secrets); service = $Service }
  $statePath = Join-Path $Root 'state.json'
  $logPath = Join-Path $Root 'calls.jsonl'
  [System.IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
  $env:KIWI_RELEASE_GCLOUD_BIN = $bin
  $env:CLOUDSDK_PYTHON = $py
  $env:FAKE_GCLOUD_STATE = $statePath
  $env:FAKE_GCLOUD_LOG = $logPath
  $env:FAKE_GCLOUD_SDK_LIB = Join-Path $sdk 'lib'
  return [pscustomobject]@{ Root = $Root; Log = $logPath; State = $statePath }
}

function Clear-FakeGcloudLog {
  param($Fake)
  if (Test-Path -LiteralPath $Fake.Log) { Remove-Item -LiteralPath $Fake.Log -Force }
}

function Read-FakeGcloudLog {
  param($Fake)
  if (-not (Test-Path -LiteralPath $Fake.Log)) { return @() }
  return @(Get-Content -LiteralPath $Fake.Log | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
}

function Remove-FakeGcloudEnv {
  foreach ($n in 'KIWI_RELEASE_GCLOUD_BIN', 'CLOUDSDK_PYTHON', 'FAKE_GCLOUD_STATE', 'FAKE_GCLOUD_LOG', 'FAKE_GCLOUD_SDK_LIB') {
    Remove-Item -Path "Env:$n" -ErrorAction SilentlyContinue
  }
}

# --- the fixture .env (EVERY VALUE FAKE) ----------------------------------------

# One line per parser case. Written with CRLF, the way a Windows editor saves it.
$script:FixtureLines = @(
  '# R3-1 FIXTURE -- every value in this file is FAKE.',
  'NODE_ENV="development"',
  '',
  'export LOG_LEVEL=info',
  'REVENUECAT_WEBHOOK_AUTH="Bearer fake-webhook-auth-0001"',
  "REVENUECAT_SECRET_API_KEY='sk_fake_secret_api_key_0002'",
  'TURNSTILE_SECRET_KEY=0x4AAAAAAAfake_turnstile_0003   # inline comment, not part of the value',
  'APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIGTfakeLINEone\nfakeLINEtwo\n-----END PRIVATE KEY-----"',
  'APPLE_REFRESH_TOKEN_ENC_KEY="dev-enc-key-must-never-be-pushed"',
  'MULTI_LINE="first line',
  'second line"',
  'EMPTY_ONE=',
  'EMPTY_QUOTED=""',
  'DUP=first',
  'DUP=second',
  'HASH_IN_QUOTES="a#b"',
  'APPLE_OAUTH_AUDIENCES="com.kitchenwizard.kiwi,com.kitchenwizard.kiwi.web"',
  'GOOGLE_OAUTH_CLIENT_IDS=111-web.apps.googleusercontent.com,111-ios.apps.googleusercontent.com,111-android.apps.googleusercontent.com',
  'APPLE_TEAM_ID=FAKETEAM01',
  'APPLE_KEY_ID=FAKEKEY001',
  'APPLE_SERVICES_ID=com.kitchenwizard.kiwi.web',
  'APPLE_WEB_REDIRECT_URI="https://kiwi-api-fake.us-east4.run.app/api/auth/oauth/apple/callback"',
  'REVENUECAT_ENTITLEMENT_ID="premium"'
)

function Write-Fixture {
  param([Parameter(Mandatory = $true)][string]$Path, [hashtable]$Replace = @{})
  $out = foreach ($l in $script:FixtureLines) {
    $k = ($l -split '=', 2)[0]
    if ($Replace.ContainsKey($k)) { '{0}={1}' -f $k, $Replace[$k] } else { $l }
  }
  New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
  [System.IO.File]::WriteAllText($Path, (($out -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
}

# --- tiny assertion kit ----------------------------------------------------------

$script:Failures = 0
function Assert-True {
  param([bool]$Condition, [string]$Label)
  if ($Condition) { Write-Host "  PASS  $Label" } else { Write-Host "  FAIL  $Label" -ForegroundColor Red; $script:Failures++ }
}
function Assert-Equal {
  param($Actual, $Expected, [string]$Label)
  $ok = ([string]$Actual -ceq [string]$Expected)
  if (-not $ok) { Write-Host ("        expected: {0}`n        actual:   {1}" -f $Expected, $Actual) }
  Assert-True $ok $Label
}

# Runs a release script in a child Windows PowerShell (the shell Hans runs them
# from). Returns its exit code and every output line, stderr included.
function Invoke-ReleaseScript {
  param([Parameter(Mandatory = $true)][string]$Script, [string[]]$Arguments = @())
  $ErrorActionPreference = 'Continue'
  $lines = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Script @Arguments 2>&1 | ForEach-Object { "$_" }
  return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Lines = @($lines); Text = (@($lines) -join "`n") }
}

function Get-Sha256Hex {
  param([string]$Value)
  $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($Value)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $sha.Dispose() }
}
