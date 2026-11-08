# Smoke test for apps/desktop/installer/closeInstalledProcesses.ps1.
#
# Runs on a Windows CI runner without building the app. Fakes an install folder
# with a running helper inside it and checks that the script closes it, while
# leaving processes outside the folder (and the excluded "installer" PID) alone.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/nsis-close-processes-smoke.ps1

$ErrorActionPreference = "Stop"

$scriptPath = Resolve-Path (Join-Path $PSScriptRoot "..\apps\desktop\installer\closeInstalledProcesses.ps1")
$pingPath = Join-Path $env:SystemRoot "System32\PING.EXE"

$script:failures = 0
function Assert-True([bool]$Condition, [string]$Message) {
  if ($Condition) {
    Write-Host "  ok: $Message"
  } else {
    Write-Host "  FAIL: $Message" -ForegroundColor Red
    $script:failures++
  }
}

function Start-Holder([string]$Directory, [string]$Name) {
  New-Item -ItemType Directory -Force $Directory | Out-Null
  $exe = Join-Path $Directory $Name
  Copy-Item $pingPath $exe -Force
  Start-Process -FilePath $exe -ArgumentList "-n", "600", "127.0.0.1" -WindowStyle Hidden -PassThru
}

function Invoke-CloseScript([string]$InstallDir, [int]$SelfPid) {
  $env:BIGBUD_NSIS_INSTDIR = $InstallDir
  $env:BIGBUD_NSIS_SELF_PID = "$SelfPid"
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $scriptPath | Out-Host
  return $LASTEXITCODE
}

function Test-Running([System.Diagnostics.Process]$Process) {
  $Process.Refresh()
  return -not $Process.HasExited
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("bigbud-nsis-smoke-" + [Guid]::NewGuid().ToString("N"))
# A sibling folder whose name shares the install folder's prefix must not match.
$installDir = Join-Path $root "bigbud"
$siblingDir = Join-Path $root "bigbud-other"
$started = @()

try {
  Write-Host "Case 1: helpers inside the install folder are closed"
  $inside = Start-Holder (Join-Path $installDir "resources\helper") "bigbud-smoke-helper.exe"
  $outside = Start-Holder $siblingDir "bigbud-smoke-helper.exe"
  $started += $inside, $outside
  Start-Sleep -Milliseconds 500
  Assert-True (Test-Running $inside) "inside helper started"

  $code = Invoke-CloseScript $installDir 0
  Assert-True ($code -eq 0) "script reports the folder released (exit $code)"
  Assert-True (-not (Test-Running $inside)) "inside helper was closed"
  Assert-True (Test-Running $outside) "process in a sibling folder was left alone"

  Write-Host "Case 2: the installer's own PID is never closed"
  $self = Start-Holder $installDir "bigbud-smoke-self.exe"
  $started += $self
  Start-Sleep -Milliseconds 500
  $code = Invoke-CloseScript $installDir $self.Id
  Assert-True ($code -eq 0) "script succeeds with only the excluded PID left (exit $code)"
  Assert-True (Test-Running $self) "excluded PID is still running"

  Write-Host "Case 3: nothing running is a fast no-op"
  $emptyDir = Join-Path $root "empty"
  New-Item -ItemType Directory -Force $emptyDir | Out-Null
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $code = Invoke-CloseScript $emptyDir 0
  Assert-True ($code -eq 0) "empty folder exits 0 (exit $code)"
  Assert-True ($timer.Elapsed.TotalSeconds -lt 15) "empty folder returns quickly ($([int]$timer.Elapsed.TotalSeconds)s)"

  Write-Host "Case 4: missing install folder input is an error, not a silent pass"
  $code = Invoke-CloseScript "" 0
  Assert-True ($code -eq 2) "missing BIGBUD_NSIS_INSTDIR exits 2 (exit $code)"
} finally {
  foreach ($process in $started) {
    if ($process -and (Test-Running $process)) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item Env:BIGBUD_NSIS_INSTDIR, Env:BIGBUD_NSIS_SELF_PID -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

if ($script:failures -gt 0) {
  Write-Host "$($script:failures) check(s) failed" -ForegroundColor Red
  exit 1
}
Write-Host "All NSIS close-process checks passed"
