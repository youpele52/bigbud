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

    Write-Info "Done."
  } finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Install-WindowsRelease
