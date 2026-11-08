# End-to-end update test for the packaged Windows NSIS installer.
#
# Reproduces "Failed to uninstall old application files ... : 2":
#   1. silently install the freshly built installer,
#   2. start a helper from inside the install folder so it holds a file open,
#   3. run the same installer again as an update (/S --updated),
#   4. require a clean exit, the helper closed and the app still installed.
#
# Usage (Windows runner, after the desktop artifact build):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/nsis-update-smoke.ps1 [-ReleaseDir release]

param([string]$ReleaseDir = "release")

$ErrorActionPreference = "Stop"
$installerTimeoutMs = 300000

function Fail([string]$Message) {
  Write-Host "FAIL: $Message" -ForegroundColor Red
  exit 1
}

function Invoke-Installer([string]$Path, [string[]]$Arguments) {
  Write-Host "Running $([IO.Path]::GetFileName($Path)) $($Arguments -join ' ')"
  $process = Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru
  if (-not $process.WaitForExit($installerTimeoutMs)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Fail "installer did not finish within $($installerTimeoutMs / 1000)s"
  }
  return $process.ExitCode
}

function Get-InstallEntry {
  $keys = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
  Get-ItemProperty $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like "bigbud*" -and $_.UninstallString } |
    Select-Object -First 1
}

function Get-QuotedPath([string]$Command) {
  if ($Command -match '^"([^"]+)"') { return $Matches[1] }
  return ($Command -split ' /')[0].Trim()
}

$installer = Get-ChildItem -Path $ReleaseDir -Filter "*.exe" -File |
  Where-Object { $_.Name -notlike "*uninstall*" -and $_.Name -notlike "__*" } |
  Sort-Object Length -Descending |
  Select-Object -First 1
if (-not $installer) { Fail "no NSIS installer found in '$ReleaseDir'" }
Write-Host "Installer: $($installer.FullName)"

$holder = $null
$installDir = $null
try {
  $code = Invoke-Installer $installer.FullName @("/S")
  if ($code -ne 0) { Fail "initial install exited with $code" }

  $entry = Get-InstallEntry
  if (-not $entry) { Fail "install did not register an uninstall entry" }
  $installDir = Split-Path -Parent (Get-QuotedPath $entry.UninstallString)
  Write-Host "Installed to: $installDir"
  $appExe = Get-ChildItem -Path $installDir -Filter "*.exe" -File |
    Where-Object { $_.Name -notlike "Uninstall*" } | Select-Object -First 1
  if (-not $appExe) { Fail "no app executable in $installDir" }

  # Stand-in for a leftover helper (OpenCode, workspace agent, ConPTY, ...):
  # any program started from inside the install folder.
  $helperDir = Join-Path $installDir "resources\bigbud-update-smoke"
  New-Item -ItemType Directory -Force $helperDir | Out-Null
  $helperExe = Join-Path $helperDir "bigbud-update-smoke-helper.exe"
  Copy-Item (Join-Path $env:SystemRoot "System32\PING.EXE") $helperExe -Force
  $holder = Start-Process -FilePath $helperExe -ArgumentList "-n", "600", "127.0.0.1" -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 1

  $holder.Refresh()
  if ($holder.HasExited) { Fail "test setup invalid: helper exited early with $($holder.ExitCode)" }

  # Prove the scenario is real: a running program's image cannot be opened for
  # exclusive write (or deleted), which is exactly what made the old uninstaller
  # give up. Windows still allows renaming a running image, so a move proves nothing.
  $blocked = $false
  try {
    $stream = [IO.File]::Open($helperExe, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $stream.Dispose()
  } catch {
    $blocked = $true
  }
  if (-not $blocked) { Fail "test setup invalid: helper did not lock its file" }
  Write-Host "Helper $($holder.Id) is running from the install folder and locking its file"

  $code = Invoke-Installer $installer.FullName @("/S", "--updated")
  if ($code -ne 0) { Fail "update install exited with $code (old files could not be uninstalled)" }

  $holder.Refresh()
  if (-not $holder.HasExited) { Fail "helper inside the install folder was not closed by the installer" }
  if (-not (Test-Path -LiteralPath (Join-Path $installDir $appExe.Name))) {
    Fail "app executable missing after update"
  }
  if (-not (Get-InstallEntry)) { Fail "uninstall entry missing after update" }

  Write-Host "NSIS update smoke passed: helper closed, update installed cleanly"
} finally {
  if ($holder) {
    $holder.Refresh()
    if (-not $holder.HasExited) { Stop-Process -Id $holder.Id -Force -ErrorAction SilentlyContinue }
  }
  $entry = Get-InstallEntry
  if ($entry) {
    $uninstaller = Get-QuotedPath $entry.UninstallString
    if (Test-Path -LiteralPath $uninstaller) {
      Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -ErrorAction SilentlyContinue
    }
  }
}
