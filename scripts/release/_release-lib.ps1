# R3-1 -- shared helpers for the round-3 release scripts. Dot-sourced, never run.
#
# ASCII ONLY, deliberately: Windows PowerShell 5.1 reads a UTF-8 file with no BOM
# as ANSI, and a single non-ASCII character here is a parser error.
#
# Nothing in this file prints a value read from a .env file. Names, lengths
# and (for plain config only) a 4-character mask -- never the value.

Set-StrictMode -Version 2.0

$script:RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

# --- .env parsing --------------------------------------------------------------

# Mirrors Node's --env-file parser (what `pnpm dev` loads the server's .env with)
# for every shape that can occur here:
#   - blank lines and lines starting with '#' are ignored; a leading `export ` is dropped
#   - KEY=VALUE, key and unquoted value trimmed; an unquoted value ends at '#'
#   - a value wrapped in "..." '...' or `...` is taken verbatim between the quotes,
#     and may span lines (a PEM pasted with real newlines)
#   - a literal backslash-n is KEPT as the two characters. Node would expand it
#     inside double quotes; APPLE_PRIVATE_KEY's reader (lib/oauth/config.ts)
#     unescapes it at read, so the secret carries what the file says.
#   - the last occurrence of a key wins
# An unterminated quote throws, naming the key and line -- a guessed secret is
# worse than none.
function Read-DotEnv {
  param([Parameter(Mandatory = $true)][string]$Path)
  $text = [System.IO.File]::ReadAllText($Path)
  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  $lines = $text -split "`r?`n"
  $values = [ordered]@{}
  $i = 0
  while ($i -lt $lines.Count) {
    $line = $lines[$i]
    $lineNo = $i + 1
    $i++
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    if ($t.StartsWith('export ')) { $t = $t.Substring(7).TrimStart() }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { continue }
    $key = $t.Substring(0, $eq).Trim()
    $rest = $t.Substring($eq + 1).TrimStart()
    $value = $null
    if ($rest.Length -gt 0 -and ('"', "'", '`' -contains [string]$rest[0])) {
      $q = $rest[0]
      $close = $rest.IndexOf($q, 1)
      if ($close -ge 1) {
        $value = $rest.Substring(1, $close - 1)
      } else {
        $parts = New-Object System.Collections.Generic.List[string]
        $parts.Add($rest.Substring(1))
        $closed = $false
        while ($i -lt $lines.Count) {
          $next = $lines[$i]
          $i++
          $close = $next.IndexOf($q)
          if ($close -ge 0) {
            $parts.Add($next.Substring(0, $close))
            $closed = $true
            break
          }
          $parts.Add($next)
        }
        if (-not $closed) { throw "Read-DotEnv: unterminated quote for $key (line $lineNo of $Path)" }
        $value = [string]::Join("`n", $parts)
      }
    } else {
      $hash = $rest.IndexOf('#')
      if ($hash -ge 0) { $rest = $rest.Substring(0, $hash) }
      $value = $rest.Trim()
    }
    $values[$key] = $value
  }
  return $values
}

# $null for absent AND for `KEY=` -- an empty value is a missing value.
function Get-DotEnvValue {
  param($Values, [string]$Name)
  if (-not $Values.Contains($Name)) { return $null }
  $v = [string]$Values[$Name]
  if ($v.Trim() -eq '') { return $null }
  return $v
}

# First 4 characters + length. Plain config only -- a secret prints its length alone.
function Format-Masked {
  param([string]$Value)
  if ($null -eq $Value) { return '<none>' }
  $head = if ($Value.Length -le 4) { '' } else { $Value.Substring(0, 4) }
  return ('{0}***({1})' -f $head, $Value.Length)
}

# Cloudflare's published dummy keys: secrets 1x/2x/3x0000...AA, site keys
# 1x/2x/3x00000000000000000000xx. A dev .env may legitimately hold them; production
# must not (a dummy secret passes or fails every token regardless of the widget).
function Test-TurnstileDummyKey {
  param([string]$Value)
  return ($null -ne $Value) -and ($Value -match '^[123]x0{16,}[A-Z]{2}$')
}

# Refuses a missing file, and a file git tracks: .env is gitignored, so a tracked
# path means the wrong file was passed.
function Assert-EnvFileSafe {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Env file not found: $Path" }
  $full = (Resolve-Path -LiteralPath $Path).Path
  $root = $script:RepoRoot.TrimEnd('\') + '\'
  if ($full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    $rel = $full.Substring($root.Length) -replace '\\', '/'
    $ErrorActionPreference = 'Continue'
    $tracked = & git -C $script:RepoRoot ls-files -- $rel
    if ($LASTEXITCODE -ne 0) { throw "git ls-files failed checking $rel" }
    if ($tracked) { throw "REFUSED: $rel is tracked by git. The .env this script reads is gitignored -- a tracked file is the wrong path." }
  }
  return $full
}

# --- gcloud ----------------------------------------------------------------------

# PowerShell resolves `gcloud` to gcloud.ps1, which hands its argument array to
# Python directly (no cmd.exe). The stdin path uses the sibling gcloud.cmd through
# System.Diagnostics.Process, because a PowerShell pipe into a native command
# appends CRLF to the value -- and REVENUECAT_WEBHOOK_AUTH is compared whole.
# KIWI_RELEASE_GCLOUD_BIN is the test seam (test-release.ps1 points it at copies of
# these two shims in front of a fake gcloud.py); it announces itself when set.
function Get-GcloudPaths {
  $bin = $env:KIWI_RELEASE_GCLOUD_BIN
  if ($bin) {
    Write-Host "!! TEST SEAM: gcloud from $bin" -ForegroundColor Yellow
  } else {
    $cmdInfo = Get-Command gcloud.ps1 -CommandType ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmdInfo) { throw 'gcloud.ps1 not found on PATH (Google Cloud SDK).' }
    $bin = Split-Path $cmdInfo.Source
  }
  $ps1 = Join-Path $bin 'gcloud.ps1'
  $cmd = Join-Path $bin 'gcloud.cmd'
  foreach ($p in $ps1, $cmd) { if (-not (Test-Path -LiteralPath $p)) { throw "gcloud shim missing: $p" } }
  return [pscustomobject]@{ Ps1 = $ps1; Cmd = $cmd }
}

# Runs gcloud with an argument ARRAY (flag and value as separate elements -- a
# '--flag=a:b' element can be split at the colon by PowerShell's binder on the way
# into gcloud.ps1). -Capture returns stdout as one string; otherwise output streams.
function Invoke-Gcloud {
  param([Parameter(Mandatory = $true)][string[]]$Arguments, [switch]$Capture)
  $ErrorActionPreference = 'Continue'
  $g = (Get-GcloudPaths).Ps1
  if ($Capture) {
    $out = & $g @Arguments
    $code = $LASTEXITCODE
    return [pscustomobject]@{ ExitCode = $code; Output = (@($out) -join "`n") }
  }
  & $g @Arguments | Out-Host
  return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $null }
}

# Runs gcloud with $Value written to its stdin as exact UTF-8 bytes: no BOM, no
# trailing newline, never on a command line. Output is inherited (gcloud prints
# "Created version [n] of the secret [NAME]." -- no value).
function Invoke-GcloudWithStdin {
  param([Parameter(Mandatory = $true)][string[]]$Arguments, [Parameter(Mandatory = $true)][string]$Value)
  foreach ($a in $Arguments) {
    if ($a -notmatch '^[A-Za-z0-9_.:/=@-]+$') { throw "Invoke-GcloudWithStdin: refusing argument with shell metacharacters: $a" }
  }
  $cmd = (Get-GcloudPaths).Cmd
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = '/d /s /c ""' + $cmd + '" ' + ($Arguments -join ' ') + '"'
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  # Process builds its stdin writer from [Console]::InputEncoding with AutoFlush on,
  # so on a UTF-8 console the writer puts EF BB BF into the pipe before a byte of
  # ours -- measured: a 44-char value arrived as 47 bytes. Swap in a BOM-less UTF-8
  # for the Start call only.
  $origInputEncoding = [Console]::InputEncoding
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  try { $p = [System.Diagnostics.Process]::Start($psi) } finally { [Console]::InputEncoding = $origInputEncoding }
  $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($Value)
  $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $p.StandardInput.BaseStream.Flush()
  $p.StandardInput.BaseStream.Close()
  $p.WaitForExit()
  return $p.ExitCode
}

function Get-SecretNames {
  param([Parameter(Mandatory = $true)][string]$Project)
  $r = Invoke-Gcloud -Capture -Arguments @('secrets', 'list', '--project', $Project, '--format', 'value(name.basename())')
  if ($r.ExitCode -ne 0) { throw "gcloud secrets list failed (exit $($r.ExitCode))" }
  return @($r.Output -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function New-EncryptionKeyValue {
  $b = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($b) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($b)
}
