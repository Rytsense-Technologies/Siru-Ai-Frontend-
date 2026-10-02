# Runs tests/e2e/06-voice-isolation.e2e.cjs against the real stack, in one command.
# LOCAL TESTING ONLY. From the frontend checkout:
#
#   powershell -ExecutionPolicy Bypass -File tests\e2e\run-voice-isolation.ps1 [-LocalDb] [-Headed] [-Channel msedge]
#
#   -BackendDir  the backend checkout (default: $env:SIRU_BACKEND_DIR, else ..\Siru-Ai-Backend)
#   -LocalDb     run the worker and the test's API through the backend's scripts\localdb.py:
#                the local app database (127.0.0.1:5432/app) in sandbox mode, instead of .env's
#   -Headed      show the browser;  -Channel msedge|chrome  use an installed browser
#   -Node        node.exe (default: the one on PATH)
#
# Needs: LiveKit and Redis running (the backend's docker compose: livekit, redis), the backend
# venv (.venv) with its .env (LiveKit keys, SARVAM_API_KEY with credits), and the two speech
# clips (tests\e2e\make-voice-clips.ps1). The voice worker is started here - with the test hook
# (voice-isolation-hook\sitecustomize.py) on its PYTHONPATH - and stopped at the end; the API and
# the static server are started by the e2e config's globalSetup (stack.cjs), as for npm run test:e2e.
param(
  [string]$BackendDir = $(if ($env:SIRU_BACKEND_DIR) { $env:SIRU_BACKEND_DIR } else { Join-Path $PSScriptRoot '..\..\..\Siru-Ai-Backend' }),
  [switch]$LocalDb,
  [switch]$Headed,
  [string]$Channel = $env:PW_CHANNEL,
  [string]$Node = $(if (Get-Command node -ErrorAction SilentlyContinue) { (Get-Command node).Source } else { '' })
)
$ErrorActionPreference = 'Stop'

$frontend = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$backend  = (Resolve-Path $BackendDir).Path
$py       = Join-Path $backend '.venv\Scripts\python.exe'
$localDbScript = Join-Path $backend 'scripts\localdb.py'   # not $localdb: PowerShell names ignore case (-LocalDb)
# The gate, the worker's log and the evidence live outside test-results: Playwright empties it
# at the start of every run.
$work     = Join-Path $env:TEMP 'siru-voice-isolation'
$gate     = Join-Path $work 'gate'
$cli      = Join-Path $frontend 'node_modules\@playwright\test\cli.js'

if (-not (Test-Path $py)) { throw "no backend virtualenv: $py" }
if (-not $Node -or -not (Test-Path $Node)) { throw 'node.exe not found: put Node 22 on PATH or pass -Node <path>' }
if (-not (Test-Path $cli)) { throw 'Playwright is not installed: npm ci (in the frontend checkout)' }
if ($LocalDb -and -not (Test-Path $localDbScript)) { throw "-LocalDb needs the backend's scripts\localdb.py: $localDbScript" }
New-Item -ItemType Directory -Force $gate | Out-Null

# A command, through scripts\localdb.py when -LocalDb is given.
function Wrap([string[]]$command) { if ($LocalDb) { @($localDbScript) + $command } else { $command } }

function Stop-Worker {
  Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -match 'multi_agent_framework\.voice\.worker' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

# 1. The real voice worker, with the test hook (only this process gets PYTHONPATH and the gate).
Stop-Worker
$workerLog = Join-Path $work 'worker.log'
$env:PYTHONPATH = Join-Path $PSScriptRoot 'voice-isolation-hook'
$env:SIRU_E2E_GATE_DIR = $gate
$arguments = (Wrap @($py, '-m', 'multi_agent_framework.voice.worker', 'start')) | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }
$worker = Start-Process -FilePath $py -WorkingDirectory $backend -WindowStyle Hidden -PassThru `
  -ArgumentList $(if ($LocalDb) { $arguments } else { $arguments | Select-Object -Skip 1 }) `
  -RedirectStandardOutput $workerLog -RedirectStandardError "$workerLog.err"
Remove-Item Env:PYTHONPATH, Env:SIRU_E2E_GATE_DIR

try {
  $until = (Get-Date).AddSeconds(90)
  while (-not (Select-String -Path $workerLog, "$workerLog.err" -Pattern '"registered worker"' -Quiet -ErrorAction SilentlyContinue)) {
    if ($worker.HasExited) { throw "the voice worker exited - see $workerLog" }
    if ((Get-Date) -gt $until) { throw "the voice worker did not register with LiveKit in 90 s - see $workerLog" }
    Start-Sleep -Milliseconds 500
  }
  Write-Host 'voice worker registered with LiveKit'

  # 2. The test (its API, started by stack.cjs, also through scripts\localdb.py with -LocalDb).
  $env:E2E_VOICE_ISOLATION = '1'
  $env:E2E_VOICE_GATE_DIR = $gate
  $env:SIRU_BACKEND_DIR = $backend
  if ($Channel) { $env:PW_CHANNEL = $Channel }
  if ($Headed) { $env:E2E_HEADED = '1' }
  Push-Location $frontend
  try {
    $test = Wrap @($Node, $cli, 'test', '--config', 'tests\e2e\e2e.config.cjs', '06-voice-isolation')   # a regex, so no backslashes
    if ($LocalDb) { & $py @test } else { & $test[0] @($test | Select-Object -Skip 1) }
    $code = $LASTEXITCODE
  } finally { Pop-Location }
  Write-Host "evidence: $work\evidence.json   worker messages: $gate\worker-publish.jsonl   worker log: $workerLog"
  exit $code
} finally {
  # 3. Stop the worker and its job processes.
  Stop-Worker
  Stop-Process -Id $worker.Id -Force -ErrorAction SilentlyContinue
}
