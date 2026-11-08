# Closes every process whose executable lives inside the bigbud install folder.
#
# Run by the NSIS installer/uninstaller (see installer.nsh) before old files are
# removed. electron-builder's default check only closes bigbud.exe, but bigbud
# also runs helpers from its install folder (backend runtime, OpenCode,
# workspace agent, desktop supervisor, node-pty/ConPTY agents). If any of them
# keeps a file open, the old uninstaller fails with
# "Failed to uninstall old application files ... : 2".
#
# Inputs (environment): BIGBUD_NSIS_INSTDIR, BIGBUD_NSIS_SELF_PID.
# Exit codes: 0 = folder released, 3 = processes still running, other = error.

$ErrorActionPreference = 'SilentlyContinue'

$installDir = $env:BIGBUD_NSIS_INSTDIR
if ([string]::IsNullOrWhiteSpace($installDir)) { exit 2 }
$root = [IO.Path]::GetFullPath($installDir).TrimEnd('\') + '\'
$selfPid = 0
[void][int]::TryParse("$env:BIGBUD_NSIS_SELF_PID", [ref]$selfPid)

function Get-InstalledProcesses {
  @(Get-CimInstance -ClassName Win32_Process | Where-Object {
      $_.ProcessId -ne $selfPid -and
      $_.ProcessId -ne $PID -and
      $_.ExecutablePath -and
      $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
    })
}

function Wait-ForRelease([int]$Milliseconds) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($Milliseconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ((Get-InstalledProcesses).Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return ((Get-InstalledProcesses).Count -eq 0)
}

# The installer already asked bigbud.exe to close; give it time to stop its
# helpers cleanly before forcing anything.
if (Wait-ForRelease 5000) { exit 0 }

for ($round = 0; $round -lt 3; $round++) {
  foreach ($process in Get-InstalledProcesses) {
    # Deliberately not a tree kill: the installer itself may be a child of
    # bigbud.exe when the update was started from inside the app.
    Stop-Process -Id $process.ProcessId -Force
  }
  if (Wait-ForRelease 3000) { exit 0 }
}

exit 3
