# Restart `dsh web` and write its startup log to a file.
#
# RUN THIS FROM YOUR OWN WINDOW, not through the agent. The agent runs inside the
# very server this script stops, so asking the agent to run it kills the agent
# mid-command and the log is never written -- which is exactly what happened three
# times before this note was added.
#
#     powershell -ExecutionPolicy Bypass -File <repo>\tools\restart-server.ps1
#
# ASCII only on purpose: Windows PowerShell 5.1 reads a .ps1 as ANSI unless it has a
# BOM, so non-ASCII text here would break the parser.

$ErrorActionPreference = 'Continue'

# Every location is derived, never assumed: this file has to work on a machine that
# cloned the repository somewhere else. `$PSScriptRoot` is `tools\`, so the project and
# its logs sit one level up.
$project = Split-Path -Parent $PSScriptRoot
$log = Join-Path $project 'dsh-web.log'
$err = Join-Path $project 'dsh-web.err.log'

# Resolve the Harness launcher from the running `dsh`, so the script follows the
# installation it was started from. Fall back to the global npm prefix.
$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($dshCmd) {
  $bin = Join-Path (Split-Path -Parent $dshCmd.Source) 'node_modules\@deepseek-ai\dsh\lib\bin.js'
} else {
  $bin = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
}
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }

Write-Host "project: $project"
Write-Host "node:    $node"
Write-Host "dsh:     $bin"
if (-not (Test-Path $bin)) { Write-Host 'WARNING: the Harness entry point was not found; adjust $bin in this script.' }

Write-Host '=== 1. Stopping a running dsh web ==='
# Match the server precisely. The plugin host is the node process whose command line
# runs `...@deepseek-ai\dsh\lib\bin.js web`. The pattern uses `?` for the separators
# because that command line mixes `/` and `\`, and it excludes the short-lived
# `dsh-subprocess-local` runner, whose command line merely quotes those same words.
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -and
  $_.CommandLine -like '*@deepseek-ai?dsh?lib?bin.js*' -and
  $_.CommandLine -like '* web*' -and
  $_.CommandLine -notlike '*dsh-subprocess-local*'
}
if ($running) {
  foreach ($p in $running) {
    Write-Host ('  stopping PID {0} (started {1})' -f $p.ProcessId, $p.CreationDate)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  }
} else {
  Write-Host '  nothing running'
}
Start-Sleep -Seconds 3

Write-Host '=== 2. Clearing the previous log ==='
Remove-Item $log, $err -Force -ErrorAction SilentlyContinue

Write-Host '=== 3. Starting the server with its output redirected ==='
# Start-Process without -WindowStyle: that is the combination that reliably writes
# the redirected files on Windows PowerShell 5.1.
Start-Process -FilePath $node -ArgumentList $bin, 'web', '--no-open' `
  -RedirectStandardOutput $log -RedirectStandardError $err
Write-Host '  started'

Write-Host '=== 4. Waiting for port 3080 ==='
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  if (Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction SilentlyContinue) {
    $ok = $true
    Write-Host ('  listening after {0}s' -f ($i * 2))
    break
  }
}
if (-not $ok) { Write-Host '  WARNING: port 3080 never opened' }
# Leave time for the plugin to publish its token (it happens after activation).
Start-Sleep -Seconds 8

Write-Host ''
Write-Host '=== 5. Plugin-related lines ==='
$hits = @()
foreach ($f in @($log, $err)) {
  if (Test-Path $f) {
    $hits += Select-String -Path $f -Pattern 'telegram|control token|configurable plugin entry|did not activate|Error|WARN' -ErrorAction SilentlyContinue
  }
}
if ($hits.Count -gt 0) {
  $hits | Select-Object -Last 40 | ForEach-Object {
    Write-Host ('  [{0}] {1}' -f (Split-Path $_.Path -Leaf), $_.Line.Trim())
  }
} else {
  Write-Host '  (no matches)'
}

Write-Host ''
Write-Host '=== 6. state.json ==='
# Derived from DSH_HOME, like the plugin derives it, so the script works on any machine.
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$state = Join-Path $dshHome 'telegram-app\state.json'
if (Test-Path $state) {
  Write-Host ('  path: {0}' -f $state)
  Write-Host ('  modified: {0}' -f (Get-Item $state).LastWriteTime)
  $j = Get-Content $state -Raw | ConvertFrom-Json
  if ($j.controlTokenHash) { Write-Host '  token digest: present' } else { Write-Host '  token digest: MISSING' }
  Write-Host ('  paired chats: {0}' -f $j.chats.Count)
} else {
  Write-Host ('  no state.json at {0} - the plugin never ran' -f $state)
}

Write-Host ''
Write-Host '=== 7. Log files ==='
foreach ($f in @($log, $err)) {
  if (Test-Path $f) {
    Write-Host ('  {0}: {1} bytes' -f (Split-Path $f -Leaf), (Get-Item $f).Length)
  } else {
    Write-Host ('  {0}: NOT CREATED' -f (Split-Path $f -Leaf))
  }
}
Write-Host ''
Write-Host 'DONE - send this window and the two log files to the agent.'
