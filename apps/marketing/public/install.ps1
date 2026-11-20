$ErrorActionPreference = "Stop"

$Repo = "youpele52/bigbud"
$LatestReleaseApiUrl = "https://api.github.com/repos/$Repo/releases/latest"
$ReleasesApiUrl = "https://api.github.com/repos/$Repo/releases"
$ReleasesPageUrl = "https://github.com/$Repo/releases"

function Write-Info {
  param([string]$Message)

  Write-Host "bigbud installer: $Message"
}

function Get-InvokeWebRequestParameters {
  $parameters = @{
    Headers = @{
      Accept       = "application/vnd.github+json"
      "User-Agent" = "bigbud-installer"
    }
  }

  if ((Get-Command Invoke-WebRequest).Parameters.ContainsKey("UseBasicParsing")) {
    $parameters.UseBasicParsing = $true
  }

  return $parameters
}

function Get-InvokeRestMethodParameters {
  $parameters = @{
    Headers = @{
      Accept       = "application/vnd.github+json"
      "User-Agent" = "bigbud-installer"
    }
  }

  if ((Get-Command Invoke-RestMethod).Parameters.ContainsKey("UseBasicParsing")) {
    $parameters.UseBasicParsing = $true
  }

  return $parameters
}

function Invoke-GitHubJson {
  param([string]$Uri)

  $parameters = Get-InvokeRestMethodParameters
  $parameters.Uri = $Uri
  return Invoke-RestMethod @parameters
}

function Get-LatestRelease {
  try {
    $latest = Invoke-GitHubJson -Uri $LatestReleaseApiUrl
    if ($null -ne $latest -and $latest.assets.Count -gt 0) {
      return $latest
    }
  } catch {
  }

  $releases = Invoke-GitHubJson -Uri $ReleasesApiUrl
  if ($null -eq $releases) {
    throw "No GitHub releases are available. Visit $ReleasesPageUrl"
  }

  $releaseList = @($releases)
  if ($releaseList.Count -eq 0) {
    throw "No GitHub releases are available. Visit $ReleasesPageUrl"
  }

  $stableRelease = $releaseList | Where-Object {
    -not $_.draft -and -not $_.prerelease -and $_.assets.Count -gt 0
  } | Select-Object -First 1

  if ($null -ne $stableRelease) {
    return $stableRelease
  }

  $fallbackRelease = $releaseList | Where-Object {
    -not $_.draft -and $_.assets.Count -gt 0
  } | Select-Object -First 1

  if ($null -eq $fallbackRelease) {
    throw "No downloadable desktop release assets are available. Visit $ReleasesPageUrl"
  }

  return $fallbackRelease
}

function Get-PreferredWindowsAsset {
  param($Release)

  $arch = $env:PROCESSOR_ARCHITECTURE
  $preferredPatterns = @()
  if ($arch -eq "ARM64") {
    $preferredPatterns += "-arm64\.exe$"
  }
  $preferredPatterns += "-x64\.exe$"
  $preferredPatterns += "\.exe$"

  foreach ($pattern in $preferredPatterns) {
    $match = $Release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
    if ($null -ne $match) {
      return $match
    }
  }

  throw "Could not find a Windows installer asset in the GitHub release. Visit $ReleasesPageUrl"
}

function Download-File {
  param(
    [string]$Uri,
    [string]$OutFile
  )

  $parameters = Get-InvokeWebRequestParameters
  $parameters.Uri = $Uri
  $parameters.OutFile = $OutFile
  Invoke-WebRequest @parameters | Out-Null
}

# Mirrors apps/desktop/installer/addUserPath.ps1 (this script is downloaded standalone, so it
# cannot reference the repo copy). Adds %USERPROFILE%\.local\bin, where the bigbud command-line
# launcher lives, to the user's PATH. Idempotent, preserves every existing entry and the
# REG_EXPAND_SZ type, never touches the machine PATH, and never fails the install.
function Add-UserPathEntry {
  try {
    $userProfile = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($userProfile)) { return }
    $binDir = Join-Path $userProfile ".local\bin"
    $normalize = {
      param([string]$Value)
      [Environment]::ExpandEnvironmentVariables($Value.Trim().Trim('"')).TrimEnd("\", "/").ToLowerInvariant()
    }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
    try {
      $current = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $target = & $normalize $binDir
      foreach ($entry in $current.Split(";")) {
        if ($entry.Trim().Length -gt 0 -and (& $normalize $entry) -eq $target) { return }
      }
      $trimmed = $current.TrimEnd(";")
      $updated = if ($trimmed.Length -eq 0) { $binDir } else { "$trimmed;$binDir" }
      $key.SetValue("Path", $updated, [Microsoft.Win32.RegistryValueKind]::ExpandString)
      Add-Type -Namespace Bigbud -Name Native -MemberDefinition @"
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
"@
      $result = [UIntPtr]::Zero
      [void][Bigbud.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result)
      Write-Info "Added $binDir to your PATH. Open a new terminal to use the bigbud command."
    } finally {
      $key.Close()
    }
  } catch {
    Write-Info "Could not update your PATH automatically. Add $env:USERPROFILE\.local\bin to it manually."
  }
}

function Install-WindowsRelease {
  $release = Get-LatestRelease
  $asset = Get-PreferredWindowsAsset -Release $release
  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString("N"))
  $installerPath = Join-Path $tempDir $asset.name

  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

  try {
    Write-Info "Downloading Windows installer..."
    Download-File -Uri $asset.browser_download_url -OutFile $installerPath

    Write-Info "Launching installer..."
    if ($env:BIGBUD_INSTALL_SILENT -eq "1") {
      $process = Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait -PassThru
    } else {
      $process = Start-Process -FilePath $installerPath -Wait -PassThru
    }
    if ($process.ExitCode -ne 0) {
      throw "Installer exited with code $($process.ExitCode)."
    }

    Add-UserPathEntry

    Write-Info "Done."
  } finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Install-WindowsRelease
