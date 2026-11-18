# Adds the bigbud command-line directory (%USERPROFILE%\.local\bin) to the current
# user's PATH. Run by the NSIS installer (see installer.nsh); apps/marketing/public/
# install.ps1 carries the same logic because it is downloaded standalone.
#
# Safe to repeat: an existing entry (compared after expanding %VARS% and ignoring case
# and a trailing slash) is left alone. Other entries are preserved byte for byte and the
# value keeps the REG_EXPAND_SZ type so entries such as %USERPROFILE%\bin still expand.
# Only HKCU is touched, never the machine PATH, and shell startup files do not exist here.
#
# Exit codes: 0 = present or added, 2 = no home directory, 1 = could not update.

$ErrorActionPreference = 'Stop'

try {
  # Not named $home: that is a read-only automatic variable in PowerShell.
  $userProfile = $env:USERPROFILE
  if ([string]::IsNullOrWhiteSpace($userProfile)) { exit 2 }
  $binDir = Join-Path $userProfile '.local\bin'

  function Normalize([string]$Value) {
    $expanded = [Environment]::ExpandEnvironmentVariables($Value.Trim().Trim('"'))
    return $expanded.TrimEnd('\', '/').ToLowerInvariant()
  }

  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try {
    # Read unexpanded so %VARS% already in the value survive the rewrite.
    $current = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $current = [string]$current
    $target = Normalize $binDir
    $present = $false
    foreach ($entry in $current.Split(';')) {
      if ($entry.Trim().Length -gt 0 -and (Normalize $entry) -eq $target) { $present = $true; break }
    }
    if (-not $present) {
      $trimmed = $current.TrimEnd(';')
      $updated = if ($trimmed.Length -eq 0) { $binDir } else { "$trimmed;$binDir" }
      $key.SetValue('Path', $updated, [Microsoft.Win32.RegistryValueKind]::ExpandString)

      # Tell running shells and Explorer to reload the environment.
      Add-Type -Namespace Bigbud -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
'@
      $result = [UIntPtr]::Zero
      [void][Bigbud.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
    }
  } finally {
    $key.Close()
  }
  exit 0
} catch {
  exit 1
}
