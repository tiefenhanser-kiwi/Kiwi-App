# OTA-1 -- tests for ota-update.ps1. No Pester on this machine, so a plain script:
# PASS/FAIL per assertion, exit 1 on any FAIL.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release\test-ota-update.ps1
#
# Never calls eas and never runs expo: the helpers run against fixtures under the system
# temp folder (removed at the end unless -Keep), and Invoke-OtaExport runs against a fake
# `pnpm` function that records what it was given. The child-process cases stop at step 0.
# Every value here is FAKE.
#
# ASCII ONLY.

param([switch]$Keep)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ota-update.ps1') -Runtime 1.1.0 -Platform android -Message 'test'
. (Join-Path $PSScriptRoot '_fake-gcloud.ps1')

$scratch = Join-Path ([IO.Path]::GetTempPath()) 'kiwi-ota-1-tests'
if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
New-Item -ItemType Directory -Force $scratch | Out-Null
$otaUpdate = Join-Path $PSScriptRoot 'ota-update.ps1'
$api = Get-ProductionApiBaseUrl

function Write-Text {
  param([string]$Path, [string]$Text)
  New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
  [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function New-FakeValues {
  $v = [ordered]@{}
  foreach ($n in $script:RequiredNames) { $v[$n] = "fake-value-for-$n" }
  $v['EXPO_PUBLIC_API_BASE_URL'] = $api
  $v['EXPO_PUBLIC_TURNSTILE_SITE_KEY'] = '0x4AAAAAAAfake_site_0001'
  return $v
}

# An export folder shaped like `expo export --platform <p>`: metadata.json naming one
# bundle, the bundle, an assetmap.
function New-FixtureDist {
  param([string]$Name, [string]$Bundle, [string[]]$Platforms = @('android'))
  $d = Join-Path $scratch "$Name\dist"
  $fm = @{}
  foreach ($p in $Platforms) { $fm[$p] = @{ bundle = "_expo/static/js/$p/entry-fake.hbc"; assets = @() } }
  Write-Text (Join-Path $d 'metadata.json') (@{ version = 0; bundler = 'metro'; fileMetadata = $fm } | ConvertTo-Json -Depth 5)
  Write-Text (Join-Path $d 'assetmap.json') '{}'
  foreach ($p in $Platforms) { Write-Text (Join-Path $d "_expo/static/js/$p/entry-fake.hbc") $Bundle }
  return $d
}

Write-Host '== constants'
Assert-Equal $script:BinaryCommit '216b2a0' 'binary commit (dot-sourced as -Runtime 1.1.0)'
Assert-Equal $script:RuntimeBranch 'release/1.1' 'runtime 1.1.0 ships from release/1.1'
$r = Invoke-GitText @('cat-file', '-t', $script:BinaryCommit)
Assert-Equal $r.Lines[0] 'commit' 'the binary commit exists in this clone'
Assert-True ($script:Binaries.Contains((Get-ExpectedRuntimeVersion))) 'app.json version (appVersion policy) is one of the binaries'
Assert-True ($api -match '^https://kiwi-api-[^/]+\.run\.app/api$') 'production API URL read from eas.json'

Write-Host '== -Runtime: two binaries (1.2-NATIVE G)'
$rp = (Get-Command $otaUpdate).Parameters['Runtime']
$vs = @($rp.Attributes | Where-Object { $_ -is [System.Management.Automation.ValidateSetAttribute] })[0].ValidValues
Assert-Equal ($vs -join ',') (@($script:Binaries.Keys) -join ',') '-Runtime ValidateSet = the Binaries keys'
Assert-True (@($rp.Attributes | Where-Object { $_ -is [System.Management.Automation.ParameterAttribute] -and $_.Mandatory }).Count -eq 1) '-Runtime is mandatory'
Assert-Equal $script:Binaries['1.2.0'].Branch 'next' 'runtime 1.2.0 ships from next'
Assert-Equal $script:BundleAllowListByRuntime.Count $script:Binaries.Count 'a bundle baseline per runtime'
Assert-True ($null -eq (Test-RuntimeBinary -Runtime '1.1.0')) '1.1.0 has its binary commit'
$saved12 = $script:Binaries['1.2.0'].Commit
$script:Binaries['1.2.0'].Commit = $null
Assert-True ((Test-RuntimeBinary -Runtime '1.2.0') -like 'runtime 1.2.0 has no binary commit recorded*') 'a runtime with no recorded commit is refused'
$script:Binaries['1.2.0'].Commit = $saved12
Assert-True ((Test-RuntimeBinary -Runtime '1.0.0') -like 'runtime 1.0.0 is not one of*') 'an unknown runtime is refused'
Assert-True ($null -eq (Test-RuntimeBranch -Runtime '1.1.0' -Branch 'release/1.1')) '1.1.0 on release/1.1: ok'
Assert-True ($null -eq (Test-RuntimeBranch -Runtime '1.2.0' -Branch 'next')) '1.2.0 on next: ok'
$why = Test-RuntimeBranch -Runtime '1.1.0' -Branch 'next'
Assert-Equal $why "branch is 'next'; runtime 1.1.0 updates ship from release/1.1 (run it from your release/1.1 worktree)" '1.1.0 from next: refused, naming the worktree'
Assert-True ((Test-RuntimeBranch -Runtime '1.2.0' -Branch 'release/1.1') -like "branch is 'release/1.1'; runtime 1.2.0 updates ship from next") '1.2.0 from release/1.1: refused'
Assert-True ($null -ne (Test-RuntimeBranch -Runtime '1.1.0' -Branch 'Release/1.1')) 'branch names compared case-sensitively'
Assert-True ($null -eq (Test-TreeRuntime -Runtime '1.2.0' -TreeRuntime '1.2.0')) 'tree runtime = -Runtime: ok'
Assert-Equal (Test-TreeRuntime -Runtime '1.1.0' -TreeRuntime '1.2.0') 'app.json version is 1.2.0, not -Runtime 1.1.0 -- this tree builds runtime 1.2.0 updates' 'a 1.2.0 tree asked for 1.1.0: refused'

Write-Host '== the code reads exactly the EXPO_PUBLIC_* names the script knows'
$reads = Get-CodePublicEnvReads
$known = @($script:RequiredNames + $script:OptionalNames | Sort-Object)
Assert-Equal ($reads -join ',') ($known -join ',') 'Get-CodePublicEnvReads = RequiredNames + OptionalNames'

Write-Host '== Get-EnvListNames: names kept, values dropped'
$names = Get-EnvListNames @('', 'Environment: production', 'EXPO_PUBLIC_A=fake-secret-a', 'EXPO_PUBLIC_B=https://x/y=z', 'not a var line')
Assert-Equal ($names -join ',') 'EXPO_PUBLIC_A,EXPO_PUBLIC_B' 'two names'
Assert-True (-not (($names -join ' ') -like '*fake-secret*')) 'no value in the output'

Write-Host '== Read-EasPulledEnv: the env:pull file shape'
$pf = Join-Path $scratch 'pulled.env'
Write-Text $pf ("# Environment: production`n`nEXPO_PUBLIC_A=a#not-a-comment`nEXPO_PUBLIC_B=b=c`n# SECRET_C=***** (secret)`nEMPTY=")
$v = Read-EasPulledEnv -Path $pf
Assert-Equal $v.Count 3 'three values (secret comment skipped)'
Assert-Equal $v['EXPO_PUBLIC_A'] 'a#not-a-comment' "'#' kept (eas writes values raw)"
Assert-Equal $v['EXPO_PUBLIC_B'] 'b=c' "'=' after the first kept"
Write-Text $pf "EXPO_PUBLIC_A=first line`nfake-second-line-0001"
$err = $null
try { Read-EasPulledEnv -Path $pf | Out-Null } catch { $err = $_.Exception.Message }
Assert-True ($err -like '*line 2 is not NAME=value*') 'a continuation line throws'
Assert-True (-not ($err -like '*fake-second-line*')) 'without echoing it'

Write-Host '== Test-PulledEnv'
$p = Test-PulledEnv -Values (New-FakeValues) -ApiBaseUrl $api
Assert-Equal $p.Count 0 'complete fake set: no problems'
$v = New-FakeValues; $v.Remove('EXPO_PUBLIC_API_BASE_URL')
$p = Test-PulledEnv -Values $v -ApiBaseUrl $api
Assert-True ($p.Count -eq 1 -and $p[0] -like 'EXPO_PUBLIC_API_BASE_URL: not pulled*') 'missing API URL refused'
$v = New-FakeValues; $v['EXPO_PUBLIC_API_BASE_URL'] = 'https://kiwi-api-fake.us-east4.run.app/api'
$p = Test-PulledEnv -Values $v -ApiBaseUrl $api
Assert-True (($p -join ';') -like '*differs from eas.json*') 'API URL other than eas.json refused'
$v = New-FakeValues; $v['EXPO_PUBLIC_API_BASE_URL'] = 'http://192.168.1.20:3000/api'
$p = Test-PulledEnv -Values $v -ApiBaseUrl $api
Assert-True (($p -join ';') -like '*EXPO_PUBLIC_API_BASE_URL: contains a dev host*') 'LAN API URL refused'
Assert-True (-not (($p -join ';') -like '*192.168.1.20*')) 'refusal names the variable, not the value'
$v = New-FakeValues; $v['EXPO_PUBLIC_TURNSTILE_SITE_KEY'] = '1x00000000000000000000AA'
$p = Test-PulledEnv -Values $v -ApiBaseUrl $api
Assert-True (($p -join ';') -like '*dummy test key*') 'Turnstile dummy key refused'
$v = New-FakeValues; $v['EXPO_PUBLIC_APPLE_WEB_REDIRECT_URI'] = 'https://ep-broad-haze-fake.neon.tech/cb'
$p = Test-PulledEnv -Values $v -ApiBaseUrl $api
Assert-True (($p -join ';') -like '*EXPO_PUBLIC_APPLE_WEB_REDIRECT_URI: contains a dev host (ep-broad-haze)*') 'Neon dev host in any value refused'

Write-Host '== Compare-PackageJsonText: the package.json native gate (REL-0), on temp JSON pairs'
$pkgBase = '{ "name": "kiwi", "main": "expo-router/entry", "version": "1.0.0",
  "scripts": { "test": "node --test a/*.test.ts", "start": "expo start" },
  "dependencies": { "expo": "~54.0.37", "react-native": "0.81.5" },
  "devDependencies": { "typescript": "~5.9.2" },
  "expo": { "install": { "exclude": ["react-native-reanimated"] } } }'
function Compare-PackagePair {
  param([string]$Name, [string]$Old, [string]$New)
  $po = Join-Path $scratch "pkg-$Name\old.json"; $pn = Join-Path $scratch "pkg-$Name\new.json"
  Write-Text $po $Old; Write-Text $pn $New
  $c = Compare-PackageJsonText -Old ([IO.File]::ReadAllText($po)) -New ([IO.File]::ReadAllText($pn))
  Write-Host ("    | {0}: Error={1}; Changed=[{2}]; ScriptsChanged={3}" -f $Name, $c.Error, ($c.Changed -join ','), $c.ScriptsChanged)
  return $c
}
$c = Compare-PackagePair 'scripts-only' $pkgBase ($pkgBase.Replace('a/*.test.ts', 'a/*.test.ts b/*.test.ts'))
Assert-True ($null -eq $c.Error -and $c.Changed.Count -eq 0 -and $c.ScriptsChanged) '1. scripts-only: passes, scripts flagged'
$c = Compare-PackagePair 'dep-bump' $pkgBase ($pkgBase.Replace('"react-native": "0.81.5"', '"react-native": "0.81.6"').Replace('a/*.test.ts', 'b/*.test.ts'))
Assert-True ($null -eq $c.Error -and ($c.Changed -join ',') -eq 'dependencies') '2. dependency bump (+ a scripts change): refused, naming dependencies only'
$c = Compare-PackagePair 'new-key' $pkgBase ($pkgBase.Replace('"name": "kiwi",', '"name": "kiwi", "overrides": { "metro": "0.83.1" },'))
Assert-True ($null -eq $c.Error -and ($c.Changed -join ',') -eq 'overrides') '3. new top-level key: refused, naming it'
$reordered = '{"expo":{"install":{"exclude":["react-native-reanimated"]}},"devDependencies":{"typescript":"~5.9.2"},
"dependencies":{"react-native":"0.81.5","expo":"~54.0.37"},"version":"1.0.0","scripts":{"start":"expo start","test":"node --test a/*.test.ts"},"main":"expo-router/entry","name":"kiwi"}'
$c = Compare-PackagePair 'key-order' $pkgBase $reordered
Assert-True ($null -eq $c.Error -and $c.Changed.Count -eq 0 -and -not $c.ScriptsChanged) '4. key order / whitespace only: passes, nothing changed'
$c = Compare-PackagePair 'invalid' $pkgBase ($pkgBase.Replace('"kiwi",', '"kiwi"'))
Assert-True ($c.Error -eq 'not valid JSON at HEAD') '5a. invalid JSON at HEAD: refused'
$c = Compare-PackagePair 'invalid-old' '{ "name": ' $pkgBase
Assert-True ($c.Error -eq 'not valid JSON at the binary commit') '5b. invalid JSON at the binary commit: refused'
$c = Compare-PackageJsonText -Old $pkgBase -New $null
Assert-True ($c.Error -eq 'missing or empty at HEAD') '5c. file gone at HEAD: refused'
$c = Compare-PackageJsonText -Old $pkgBase -New '[{ "name": "kiwi" }]'
Assert-True ($c.Error -eq 'not a JSON object at HEAD') '5d. a top-level array: refused'
$c = Compare-PackageJsonText -Old $pkgBase -New ($pkgBase.Replace('"version": "1.0.0"', '"version": 1'))
Assert-True (($c.Changed -join ',') -eq 'version') 'a type change ("1.0.0" -> 1) is a change'
$c = Compare-PackageJsonText -Old $pkgBase -New ($pkgBase.Replace('["react-native-reanimated"]', '["react-native-reanimated", "expo-image"]'))
Assert-True (($c.Changed -join ',') -eq 'expo') 'a nested array change under "expo" is a change'
$c = Compare-PackageJsonText -Old $pkgBase -New ($pkgBase.Replace('"main"', '"Main"'))
Assert-True (($c.Changed -join ',') -eq 'Main,main') 'key case is significant'

Write-Host '== Compare-LockfileText: the pnpm-lock.yaml native gate (REL-0b), on small lock fixtures'
$lockBase = @'
lockfileVersion: '9.0'

overrides:
  esbuild: 0.27.3
  '@expo/ngrok-bin>@expo/ngrok-bin-darwin-x64': '-'

importers:

  .:
    devDependencies:
      typescript:
        specifier: ~5.9.2
        version: 5.9.3

  artifacts/api-server:
    dependencies:
      express:
        specifier: ^5
        version: 5.2.1

  artifacts/kiwi:
    dependencies:
      expo-updates:
        specifier: ~29.0.20
        version: 29.0.20(expo@54.0.37)
    devDependencies:
      '@workspace/api-client-react':
        specifier: workspace:*
        version: link:../../lib/api-client-react
      react-native:
        specifier: 0.81.5
        version: 0.81.5(@babel/core@7.29.0)(react@19.1.0)

  lib/api-client-react:
    dependencies:
      '@tanstack/react-query':
        specifier: 'catalog:'
        version: 5.90.21(react@19.1.0)

packages:

  express@5.2.1:
    resolution: {integrity: sha512-fake0001}

  react-native@0.81.5:
    resolution: {integrity: sha512-fake0002}
'@
function Compare-LockPair {
  param([string]$Name, [string]$Old, [string]$New)
  $c = Compare-LockfileText -Old $Old -New $New
  Write-Host ("    | {0}: Error={1}; Changed=[{2}]; Linked=[{3}]; OtherOverrides=[{4}]" -f $Name, $c.Error, ($c.Changed -join '; '), ($c.Linked -join ','), ($c.OtherOverrides -join ','))
  return $c
}
$lockBase = $lockBase.Replace("`r`n", "`n")
$serverOnly = $lockBase.Replace("        specifier: ^5`n        version: 5.2.1", "        specifier: ^5.3.0`n        version: 5.3.0`n      helmet:`n        specifier: 8.3.0`n        version: 8.3.0").Replace("  express@5.2.1:`n    resolution: {integrity: sha512-fake0001}", "  express@5.3.0:`n    resolution: {integrity: sha512-fake0003}`n`n  helmet@8.3.0:`n    resolution: {integrity: sha512-fake0004}")
Assert-True ($serverOnly -cne $lockBase -and $serverOnly -like '*helmet@8.3.0*') '(fixture) the server-only pair differs'
$c = Compare-LockPair 'a-server-only' $lockBase $serverOnly
Assert-True ($null -eq $c.Error -and $c.Changed.Count -eq 0 -and ($c.Linked -join ',') -eq 'lib/api-client-react') 'a. only the api-server importer and packages: differ: allowed (linked lib importer compared too)'
$scopedOut = $serverOnly.Replace("  esbuild: 0.27.3`n", "  esbuild: 0.27.3`n  router>path-to-regexp: ^8.4.2`n  cheerio>undici: ^7.30.1`n")
$c = Compare-LockPair 'a2-scoped-outside' $lockBase $scopedOut
Assert-True ($null -eq $c.Error -and $c.Changed.Count -eq 0 -and ($c.OtherOverrides -join ',') -eq 'cheerio>undici,router>path-to-regexp') 'a2. + scoped overrides whose parent is not the app''s: allowed, listed'
$c = Compare-LockPair 'b-kiwi-version' $lockBase ($serverOnly.Replace('version: 0.81.5(@babel/core', 'version: 0.81.6(@babel/core'))
Assert-True ($null -eq $c.Error -and ($c.Changed -join '; ') -eq 'react-native version 0.81.5 -> 0.81.6') 'b. a kiwi importer version differs: refused, naming it'
$c = Compare-LockPair 'b2-kiwi-peer' $lockBase ($lockBase.Replace('(@babel/core@7.29.0)(react@19.1.0)', '(@babel/core@7.29.8)(react@19.1.0)'))
Assert-True (($c.Changed -join '; ') -eq 'react-native version 0.81.5 (peer resolution changed)') 'b2. a peer-only resolution change in the kiwi importer: refused'
$c = Compare-LockPair 'b3-kiwi-added' $lockBase ($lockBase.Replace("    devDependencies:`n      '@workspace", "      expo-camera:`n        specifier: ~17.0.0`n        version: 17.0.8(expo@54.0.37)`n    devDependencies:`n      '@workspace"))
Assert-True (($c.Changed -join '; ') -eq 'expo-camera added to dependencies (17.0.8)') 'b3. a dependency added to the kiwi importer: refused'
$c = Compare-LockPair 'c-unscoped-override' $lockBase ($serverOnly.Replace("  esbuild: 0.27.3`n", "  esbuild: 0.27.3`n  metro: 0.83.1`n"))
Assert-True ($null -eq $c.Error -and ($c.Changed -join '; ') -eq 'override metro: <absent> -> 0.83.1') 'c. an unscoped override added: refused'
$c = Compare-LockPair 'c2-scoped-kiwi-parent' $lockBase ($lockBase.Replace("  esbuild: 0.27.3`n", "  esbuild: 0.27.3`n  react-native@0.81>semver: ^7.7.0`n"))
Assert-True (($c.Changed -join '; ') -eq 'override react-native@0.81>semver: <absent> -> ^7.7.0') 'c2. a scoped override under a kiwi package: refused'
$c = Compare-LockPair 'c3-override-value' $lockBase ($lockBase.Replace("'@expo/ngrok-bin>@expo/ngrok-bin-darwin-x64': '-'", "'@expo/ngrok-bin>@expo/ngrok-bin-darwin-x64': 2.3.42"))
Assert-True ($c.Changed.Count -eq 0 -and ($c.OtherOverrides -join ',') -eq '@expo/ngrok-bin>@expo/ngrok-bin-darwin-x64') 'c3. a quoted scoped override, value changed, parent not in the app''s importers: allowed, listed'
$c = Compare-LockPair 'd-linked-importer' $lockBase ($lockBase.Replace('version: 5.90.21(react@19.1.0)', 'version: 5.91.0(react@19.1.0)'))
Assert-True (($c.Changed -join '; ') -eq 'lib/api-client-react: @tanstack/react-query version 5.90.21 -> 5.91.0') 'd. a workspace importer the app links changes: refused, naming it'
$c = Compare-LockPair 'e-crlf' $lockBase ($serverOnly.Replace("`n", "`r`n"))
Assert-True ($null -eq $c.Error -and $c.Changed.Count -eq 0) 'e. CRLF vs LF: same blocks'
$c = Compare-LockfileText -Old $lockBase -New ($lockBase.Replace('  artifacts/kiwi:', '  artifacts/kiwi2:'))
Assert-True ($c.Error -eq 'no artifacts/kiwi importer at HEAD') 'f. kiwi importer gone at HEAD: cannot compare, refused'
$c = Compare-LockfileText -Old $lockBase -New $null
Assert-True ($c.Error -eq 'missing or empty at HEAD') 'f2. lockfile gone at HEAD: refused'
$c = Compare-LockfileText -Old $lockBase -New ($lockBase.Replace("  esbuild: 0.27.3`n", "  esbuild: 0.27.3`n    nested: 1`n"))
Assert-True ($c.Error -like 'unreadable overrides line*') 'f3. an overrides line it cannot read: refused'
$blk = Get-LockImporterBlock -Lines (Split-LockText $lockBase) -Importer 'artifacts/kiwi'
Assert-Equal $blk.Count 12 'the kiwi block: its key line to the next two-space line, trailing blank dropped'
Assert-Equal $blk[-1] '        version: 0.81.5(@babel/core@7.29.0)(react@19.1.0)' 'and it ends on its last dependency line'
Assert-Equal (Resolve-LockLink -From 'artifacts/kiwi' -Link '../../lib/api-client-react') 'lib/api-client-react' 'link: resolved from the importer'

Write-Host '== Compare-BundleHits: exact literals, counted'
$al = @{ 'localhost' = @{ 'http://localhost:8081/' = 1 } }
$t = 'xyzwelcome-scrollHeighttp://localhost:8081/assets/__node_modules/.pnpm/fonts'
$e = Compare-BundleHits -Text $t -Hits (Get-BundleHits -Text $t) -AllowList $al
Assert-Equal $e.Count 0 'the RN dev-server fallback is covered, whatever its neighbours'
$t2 = $t + 'abchttp://localhost:8081/'
$e = Compare-BundleHits -Text $t2 -Hits (Get-BundleHits -Text $t2) -AllowList $al
Assert-Equal $e.Count 1 'a second copy is over the count'
$t3 = 'abchttp://localhost:8082/'
$e = Compare-BundleHits -Text $t3 -Hits (Get-BundleHits -Text $t3) -AllowList $al
Assert-Equal $e.Count 1 'a different port is not covered'
$t4 = 'ws://10.0.2.2:9000/x 127.0.0.1 192.168.0.4 ep-broad-haze-123 host:3000 v3000'
$h = Get-BundleHits -Text $t4
Assert-Equal (($h | ForEach-Object { $_.Pattern }) -join ',') '127.0.0.1,10.0.2.2,192.168.,ep-broad-haze,:3000,:9000' 'every pattern found once; v3000 is not :3000'

Write-Host '== Test-OtaBundle on fixture exports'
$good = 'aaa' + $api + 'bbbhttp://localhost:8081/ccc'
$d = New-FixtureDist -Name 'good' -Bundle $good
$c = Test-OtaBundle -Dist $d -Platform android -ApiBaseUrl $api -AllowList $script:BundleAllowList['android']
$c.Lines | ForEach-Object { Write-Host "    | $_" }
Assert-True $c.Ok 'production URL + baseline hit only: Ok'
Assert-True ($c.Lines[0] -match 'sha256 [0-9a-f]{64}$') 'prints the bundle sha256'
Assert-True ($c.Lines[-1] -match '^export folder: 3 files, sha256 [0-9a-f]{64}$') 'prints the folder hash'
$d = New-FixtureDist -Name 'nourl' -Bundle 'aaahttp://localhost:3000/apibbbhttp://localhost:8081/'
$c = Test-OtaBundle -Dist $d -Platform android -ApiBaseUrl $api -AllowList $script:BundleAllowList['android']
Assert-True (-not $c.Ok -and $c.Lines[-1] -eq 'the production API URL is not in the bundle') 'no production URL: refused'
$d = New-FixtureDist -Name 'fallback-ios' -Bundle ('aaa' + $api + 'bbbhttp://localhost:3000/apiccchttp://localhost:8081/') -Platforms @('ios')
$c = Test-OtaBundle -Dist $d -Platform ios -ApiBaseUrl $api -AllowList $script:BundleAllowList['ios']
Assert-True (-not $c.Ok -and $c.Lines[-1] -eq 'the base.ts dev fallback (localhost:3000/api) is in the bundle') 'base.ts fallback refused even where the iOS baseline allows http://localhost:3000'
Assert-True (($c.Lines -join "`n") -like '*localhost:3000/api (the base.ts dev fallback, never allowed): 1 hit(s)*') 'and counted on its own line'
$d = New-FixtureDist -Name 'lan' -Bundle ('aaa' + $api + 'bbbhttp://192.168.1.20:3000/api')
$c = Test-OtaBundle -Dist $d -Platform android -ApiBaseUrl $api -AllowList $script:BundleAllowList['android']
Assert-True (-not $c.Ok -and $c.Lines[-1] -eq 'dev-host strings outside the baseline') 'LAN host refused'
$d = New-FixtureDist -Name 'both' -Bundle ('aaa' + $api) -Platforms @('android', 'ios')
$c = Test-OtaBundle -Dist $d -Platform android -ApiBaseUrl $api -AllowList $script:BundleAllowList['android']
Assert-True (-not $c.Ok -and $c.Lines[-1] -like 'export holds platform(s)*expected only android') 'a two-platform export refused'

$sp = 'aaa' + $api + 'bbbhttp://localhost:8081/cccZoomInRighttp://localhost:8969/streambiguous'
$d = New-FixtureDist -Name 'spotlight' -Bundle $sp
$c = Test-OtaBundle -Dist $d -Platform android -ApiBaseUrl $api -AllowList $script:BundleAllowListByRuntime['1.2.0']['android']
Assert-True $c.Ok "1.2.0: Sentry's Spotlight default is on its baseline"
$c = Test-OtaBundle -Dist $d -Platform android -ApiBaseUrl $api -AllowList $script:BundleAllowListByRuntime['1.1.0']['android']
Assert-True (-not $c.Ok) '1.1.0: the same string is not (that runtime ships no Sentry)'

Write-Host '== Get-DirHash moves with any file'
$d = New-FixtureDist -Name 'hash' -Bundle ('aaa' + $api)
$h1 = Get-DirHash $d
Assert-Equal (Get-DirHash $d) $h1 'stable'
Write-Text (Join-Path $d 'assetmap.json') '{ }'
Assert-True ((Get-DirHash $d) -ne $h1) 'changes when a file changes'

Write-Host '== Get-PublishArguments'
$a = Get-PublishArguments -Platform android -Message 'm' -InputDir 'C:\t\dist'
$s = $a -join ' '
Assert-Equal $s 'update --branch production --platform android --environment production --message m --skip-bundler --input-dir C:\t\dist --non-interactive --json' 'the publish argv'
Assert-Equal (Format-Command (Get-PublishArguments -Platform ios -Message 'two words' -InputDir 'C:\a b\dist')) 'eas update --branch production --platform ios --environment production --message "two words" --skip-bundler --input-dir "C:\a b\dist" --non-interactive --json' 'printed with quotes where needed'

Write-Host '== Invoke-OtaExport against a fake pnpm'
$script:FakePnpm = $null
function global:pnpm {
  $script:FakePnpm = [pscustomobject]@{
    Args    = @($args)
    Cwd     = (Get-Location).Path
    Api     = $env:EXPO_PUBLIC_API_BASE_URL
    Domain  = $env:EXPO_PUBLIC_DOMAIN
    NoDot   = $env:EXPO_NO_DOTENV
    Public  = @(Get-ChildItem Env: | Where-Object { $_.Name -like 'EXPO_PUBLIC_*' } | ForEach-Object { $_.Name } | Sort-Object)
  }
  $global:LASTEXITCODE = 0
}
$before = @{ Api = $env:EXPO_PUBLIC_API_BASE_URL; Domain = $env:EXPO_PUBLIC_DOMAIN; NoDot = $env:EXPO_NO_DOTENV }
$env:EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000/api'
$env:EXPO_PUBLIC_DOMAIN = 'fake-dev.example'
Remove-Item Env:EXPO_NO_DOTENV -ErrorAction SilentlyContinue
$code = Invoke-OtaExport -Values (New-FakeValues) -OutDir 'C:\fake\out\dist' -Platform android
$f = $script:FakePnpm
Assert-Equal $code 0 'exit code passed back'
Assert-Equal ($f.Args -join ' ') 'exec expo export --output-dir C:\fake\out\dist --dump-sourcemap --dump-assetmap --platform android --clear' 'expo export argv (eas-cli buildBundlesAsync, one platform, --clear)'
Assert-Equal $f.Cwd $script:KiwiDir 'run from artifacts\kiwi'
Assert-Equal $f.Api $api 'the EAS value beats the shell dev URL'
Assert-Equal $f.Domain '' 'a shell EXPO_PUBLIC_* the EAS set lacks is dropped'
Assert-Equal $f.NoDot '1' 'EXPO_NO_DOTENV=1 (no .env file is read)'
Assert-Equal ($f.Public -join ',') (($script:RequiredNames | Sort-Object) -join ',') 'the child saw exactly the EAS names'
Assert-Equal $env:EXPO_PUBLIC_API_BASE_URL 'http://localhost:3000/api' 'shell value restored after'
Assert-Equal $env:EXPO_PUBLIC_DOMAIN 'fake-dev.example' 'dropped shell value restored after'
Assert-True ($null -eq $env:EXPO_NO_DOTENV) 'EXPO_NO_DOTENV removed after'
Assert-True ($null -eq $env:EXPO_PUBLIC_TURNSTILE_SITE_KEY) 'EAS values do not linger in the shell'
Remove-Item Function:\pnpm
foreach ($k in 'Api', 'Domain', 'NoDot') {
  $n = @{ Api = 'EXPO_PUBLIC_API_BASE_URL'; Domain = 'EXPO_PUBLIC_DOMAIN'; NoDot = 'EXPO_NO_DOTENV' }[$k]
  [Environment]::SetEnvironmentVariable($n, $before[$k], 'Process')
}

Write-Host '== Sentry source maps (1.2-NATIVE B)'
$p = Get-SentryUploadPlan -Shell @{ SENTRY_AUTH_TOKEN = ''; SENTRY_ORG = 'fake-org'; SENTRY_PROJECT = 'fake-proj' }
Assert-True (-not $p.Upload -and -not $p.Refuse -and $p.Reason -eq 'skipped: no SENTRY_AUTH_TOKEN in the shell') 'no token: skipped, not refused'
$p = Get-SentryUploadPlan -Shell @{ SENTRY_AUTH_TOKEN = 'fake-token-0001'; SENTRY_ORG = ''; SENTRY_PROJECT = $null }
Assert-True (-not $p.Upload -and $p.Refuse -like 'SENTRY_AUTH_TOKEN is set but SENTRY_ORG and SENTRY_PROJECT is not*') 'a token without org/project: refused'
Assert-True (-not ($p.Refuse -like '*fake-token*')) 'the refusal never prints the token'
$p = Get-SentryUploadPlan -Shell @{ SENTRY_AUTH_TOKEN = 'fake-token-0001'; SENTRY_ORG = 'fake-org'; SENTRY_PROJECT = 'fake-proj' } -DsnInBundle $false
Assert-True (-not $p.Upload -and $p.Reason -like 'skipped: EXPO_PUBLIC_SENTRY_DSN is empty*') 'no DSN in the bundle: skipped'
$p = Get-SentryUploadPlan -Shell @{ SENTRY_AUTH_TOKEN = 'fake-token-0001'; SENTRY_ORG = 'fake-org'; SENTRY_PROJECT = 'fake-proj' }
Assert-True ($p.Upload -and $p.Reason -eq 'source maps upload to Sentry project fake-org/fake-proj') 'token + org + project + DSN: uploads'
Assert-True ($script:OptionalNames -contains 'EXPO_PUBLIC_SENTRY_DSN' -and $script:RequiredNames -notcontains 'EXPO_PUBLIC_SENTRY_DSN') 'the DSN is optional, never required'

$d = New-FixtureDist -Name 'sentry' -Bundle ('aaa' + $api)
Write-Text (Join-Path $d '_expo/static/js/android/entry-fake.hbc.map') '{"version":3,"debugId":"fake-debug-0001"}'
$h0 = Get-DirHash $d
$copy = Join-Path $scratch 'sentry\copy'
$script:FakePnpm = $null
function global:pnpm {
  $map = Join-Path $args[2] '_expo/static/js/android/entry-fake.hbc.map'
  $script:FakePnpm = [pscustomobject]@{ Args = @($args); Cwd = (Get-Location).Path; SawMap = (Test-Path -LiteralPath $map) }
  # The real uploader rewrites each .map it uploads.
  [IO.File]::WriteAllText($map, '{"version":3,"debugId":"fake-debug-0001","debug_id":"fake-debug-0001"}')
  $global:LASTEXITCODE = 0
}
$code = Invoke-SentryUpload -Dist $d -CopyDir $copy
$f = $script:FakePnpm
Remove-Item Function:\pnpm
Assert-Equal $code 0 'exit code passed back'
Assert-Equal ($f.Args -join ' ') "exec sentry-expo-upload-sourcemaps $copy" 'the upload argv names the copy'
Assert-Equal $f.Cwd $script:KiwiDir 'run from artifacts\kiwi'
Assert-True $f.SawMap 'the copy holds the source map'
Assert-Equal (Get-DirHash $d) $h0 'the verified folder is untouched by the rewrite'
Assert-True (-not (Test-Path -LiteralPath $copy)) 'the copy is deleted after'

Write-Host '== the script refuses before any git or eas call'
$x = Invoke-ReleaseScript -Script $otaUpdate -Arguments @('-Runtime', '1.1.0', '-Platform', 'android', '-Message', 'm', '-DryRun')
$x.Lines | ForEach-Object { Write-Host "    | $_" }
Assert-Equal $x.ExitCode 1 'no -ConfirmReleased: exit 1'
Assert-True ($x.Text -like '*REFUSED at step 0: -ConfirmReleased not passed*android 1.1.0 binary*D-WS9-279*') 'step 0 names the runtime and D-WS9-279'
Assert-True (-not ($x.Text -like '*`[1`]*')) 'nothing after step 0 ran'
$x = Invoke-ReleaseScript -Script $otaUpdate -Arguments @('-Runtime', '1.1.0', '-Platform', 'all', '-ConfirmReleased', '-Message', 'm', '-DryRun')
Assert-True ($x.ExitCode -ne 0 -and $x.Text -like '*ValidateSet*') '-Platform all is not accepted'
$x = Invoke-ReleaseScript -Script $otaUpdate -Arguments @('-Runtime', '1.0.0', '-Platform', 'android', '-ConfirmReleased', '-Message', 'm', '-DryRun')
Assert-True ($x.ExitCode -ne 0 -and $x.Text -like '*ValidateSet*') '-Runtime 1.0.0 is not accepted'
$x = Invoke-ReleaseScript -Script $otaUpdate -Arguments @('-Runtime', '1.1.0', '-Platform', 'android', '-ConfirmReleased', '-Message', ' ', '-DryRun')
Assert-True ($x.ExitCode -eq 1 -and $x.Text -like '*REFUSED at step 0: -Message is empty*') 'blank -Message refused'
if (-not $script:Binaries['1.2.0'].Commit) {
  $x = Invoke-ReleaseScript -Script $otaUpdate -Arguments @('-Runtime', '1.2.0', '-Platform', 'ios', '-ConfirmReleased', '-Message', 'm', '-DryRun')
  $x.Lines | ForEach-Object { Write-Host "    | $_" }
  Assert-True ($x.ExitCode -eq 1 -and $x.Text -like '*REFUSED at step 0: runtime 1.2.0 has no binary commit recorded*') '-Runtime 1.2.0 before its build is recorded: refused at step 0'
  Assert-True (-not ($x.Text -like '*`[1`]*')) 'and no git or eas call ran'
}
$x = Invoke-ReleaseScript -Script $otaUpdate -Arguments @('-Runtime', '1.1.0', '-Platform', 'android', '-ConfirmReleased', '-Message', 'm', '-DryRun')
$x.Lines | ForEach-Object { Write-Host "    | $_" }
$onBranch = (Invoke-GitText @('rev-parse', '--abbrev-ref', 'HEAD')).Lines -join ''
if ($onBranch -cne 'release/1.1') {
  Assert-True ($x.ExitCode -eq 1 -and $x.Text -like "*REFUSED at step 1: branch is '$onBranch'; runtime 1.1.0 updates ship from release/1.1*") '-Runtime 1.1.0 off release/1.1: refused at step 1, before any eas call'
}

if (-not $Keep) { Remove-Item -LiteralPath $scratch -Recurse -Force }
Write-Host ''
if ($script:Failures -gt 0) { Write-Host "FAILED: $($script:Failures)" -ForegroundColor Red; exit 1 }
Write-Host 'ALL PASS'
exit 0
