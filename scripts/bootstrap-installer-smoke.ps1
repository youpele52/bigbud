# Bootstrap installer smoke test for install.ps1
#
# Validates the Windows bootstrap installer script without hitting GitHub or
# running a real installer.  Mocks Invoke-RestMethod, Invoke-WebRequest, and
# Start-Process so every code path can be exercised on any OS.
#
# Usage:
#   pwsh scripts/bootstrap-installer-smoke.ps1

$ErrorActionPreference = "Stop"

$scriptPath = Resolve-Path (Join-Path $PSScriptRoot ".." "apps" "marketing" "public" "install.ps1")

# -------------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------------

$script:failures = 0
$script:passes = 0

function Assert-True {
  param(
    [bool]$Condition,
    [string]$Message
  )

  if ($Condition) {
    $script:passes++
  } else {
    Write-Host "  FAIL: $Message" -ForegroundColor Red
    $script:failures++
  }
}

function Assert-Equal {
  param(
    $Expected,
    $Actual,
    [string]$Message
  )

  Assert-True -Condition ($Expected -eq $Actual) -Message "$Message (expected='$Expected', actual='$Actual')"
}

# -------------------------------------------------------------------------
# Test: Get-PreferredWindowsAsset selects x64 on AMD64
# -------------------------------------------------------------------------

function Test-AssetSelectionX64 {
  # Source the script to load functions (but NOT execute Install-WindowsRelease)
  $content = Get-Content -Path $scriptPath -Raw
  # Remove the trailing call so we only load function definitions
  $definitionsOnly = $content -replace 'Install-WindowsRelease\s*$', ''
  $definitionsOnly = $definitionsOnly -replace '\r?\n\s*Install-WindowsRelease\s*$', ''

  $oldArch = $env:PROCESSOR_ARCHITECTURE
  $env:PROCESSOR_ARCHITECTURE = "AMD64"

  try {
    . ([ScriptBlock]::Create($definitionsOnly))

    $release = @{
      assets = @(
        @{ name = "bigbud-1.0.0-arm64.exe"; browser_download_url = "https://example.com/arm64.exe" },
        @{ name = "bigbud-1.0.0-x64.exe";  browser_download_url = "https://example.com/x64.exe" },
        @{ name = "bigbud-1.0.0-x64.blockmap"; browser_download_url = "https://example.com/x64.blockmap" }
      )
    }

    $result = Get-PreferredWindowsAsset -Release $release
    Assert-Equal -Expected "bigbud-1.0.0-x64.exe" -Actual $result.name -Message "Should select x64 .exe on AMD64"
    Assert-Equal -Expected "https://example.com/x64.exe" -Actual $result.browser_download_url -Message "Should return x64 download URL"
  } finally {
    $env:PROCESSOR_ARCHITECTURE = $oldArch
  }
}

# -------------------------------------------------------------------------
# Test: Get-PreferredWindowsAsset selects arm64 on ARM64
# -------------------------------------------------------------------------

function Test-AssetSelectionARM64 {
  $content = Get-Content -Path $scriptPath -Raw
  $definitionsOnly = $content -replace '(?m)^\s*Install-WindowsRelease\s*$', ''

  $oldArch = $env:PROCESSOR_ARCHITECTURE
  $env:PROCESSOR_ARCHITECTURE = "ARM64"

  try {
    . ([ScriptBlock]::Create($definitionsOnly))

    $release = @{
      assets = @(
        @{ name = "bigbud-1.0.0-arm64.exe"; browser_download_url = "https://example.com/arm64.exe" },
        @{ name = "bigbud-1.0.0-x64.exe";  browser_download_url = "https://example.com/x64.exe" }
      )
    }

    $result = Get-PreferredWindowsAsset -Release $release
    Assert-Equal -Expected "bigbud-1.0.0-arm64.exe" -Actual $result.name -Message "Should select arm64 .exe on ARM64"
  } finally {
    $env:PROCESSOR_ARCHITECTURE = $oldArch
  }
}

# -------------------------------------------------------------------------
# Test: Get-PreferredWindowsAsset falls back to generic .exe
# -------------------------------------------------------------------------

function Test-AssetSelectionFallback {
  $content = Get-Content -Path $scriptPath -Raw
  $definitionsOnly = $content -replace '(?m)^\s*Install-WindowsRelease\s*$', ''

  $oldArch = $env:PROCESSOR_ARCHITECTURE
  $env:PROCESSOR_ARCHITECTURE = "AMD64"

  try {
    . ([ScriptBlock]::Create($definitionsOnly))

    $release = @{
      assets = @(
        @{ name = "bigbud-1.0.0-setup.exe"; browser_download_url = "https://example.com/setup.exe" }
      )
    }

    $result = Get-PreferredWindowsAsset -Release $release
    Assert-Equal -Expected "bigbud-1.0.0-setup.exe" -Actual $result.name -Message "Should fall back to generic .exe"
  } finally {
    $env:PROCESSOR_ARCHITECTURE = $oldArch
  }
}

# -------------------------------------------------------------------------
# Test: Get-PreferredWindowsAsset throws when no .exe asset exists
# -------------------------------------------------------------------------

function Test-AssetSelectionNoMatch {
  $content = Get-Content -Path $scriptPath -Raw
  $definitionsOnly = $content -replace '(?m)^\s*Install-WindowsRelease\s*$', ''

  $oldArch = $env:PROCESSOR_ARCHITECTURE
  $env:PROCESSOR_ARCHITECTURE = "AMD64"

  try {
    . ([ScriptBlock]::Create($definitionsOnly))

    $release = @{
      assets = @(
        @{ name = "bigbud-1.0.0-x64.dmg"; browser_download_url = "https://example.com/x64.dmg" }
      )
    }

    $thrown = $false
    try {
      Get-PreferredWindowsAsset -Release $release
    } catch {
      $thrown = $true
    }
    Assert-True -Condition $thrown -Message "Should throw when no .exe asset found"
  } finally {
    $env:PROCESSOR_ARCHITECTURE = $oldArch
  }
}

# -------------------------------------------------------------------------
# Test: Start-Process is called without -ArgumentList in interactive mode
# -------------------------------------------------------------------------

function Test-InteractiveInstall {
  $content = Get-Content -Path $scriptPath -Raw
  $definitionsOnly = $content -replace '(?m)^\s*Install-WindowsRelease\s*$', ''

  $oldSilent = $env:BIGBUD_INSTALL_SILENT
  $env:BIGBUD_INSTALL_SILENT = ""

  $script:capturedArgs = $null
  $script:capturedArgList = $null

  try {
    . ([ScriptBlock]::Create($definitionsOnly))

    # Override Start-Process to capture how it was called
    function Start-Process {
      [CmdletBinding()]
      param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [switch]$Wait,
        [switch]$PassThru
      )
      $script:capturedArgs = $PSBoundParameters
      $script:capturedArgList = $ArgumentList
      # Return a fake process with exit code 0
      [PSCustomObject]@{ ExitCode = 0 }
    }

    # Override Invoke-RestMethod to return a fake release
    function Invoke-RestMethod {
      param([hashtable]$Parameters)
      return @{
        assets = @(
          @{ name = "bigbud-1.0.0-x64.exe"; browser_download_url = "https://example.com/bigbud-1.0.0-x64.exe" }
        )
      }
    }

    # Override web request and file ops
    function Invoke-WebRequest { param([hashtable]$Parameters) }
    function New-Item { param([string]$ItemType, [string]$Path, [switch]$Force); [PSCustomObject]@{ FullName = $Path } }
    function Remove-Item { param([string]$LiteralPath, [switch]$Recurse, [switch]$Force, [string]$ErrorAction) }
    function Join-Path { param([string]$Path, [string]$ChildPath); return "$Path\$ChildPath" }
    function Write-Host { param([string]$Message) }

    $env:PROCESSOR_ARCHITECTURE = "AMD64"
    Install-WindowsRelease

    Assert-True -Condition ($script:capturedArgs.ContainsKey("FilePath")) -Message "Start-Process should be called with -FilePath"
    Assert-True -Condition (-not $script:capturedArgs.ContainsKey("ArgumentList")) -Message "Interactive mode should NOT pass -ArgumentList"
    Assert-True -Condition ($null -eq $script:capturedArgList) -Message "ArgumentList should be null/empty in interactive mode"
  } finally {
    $env:BIGBUD_INSTALL_SILENT = $oldSilent
    Remove-Variable capturedArgs -Scope Script -ErrorAction SilentlyContinue
    Remove-Variable capturedArgList -Scope Script -ErrorAction SilentlyContinue
  }
}

# -------------------------------------------------------------------------
# Test: Start-Process is called with -ArgumentList "/S" in silent mode
# -------------------------------------------------------------------------

function Test-SilentInstall {
  $content = Get-Content -Path $scriptPath -Raw
  $definitionsOnly = $content -replace '(?m)^\s*Install-WindowsRelease\s*$', ''

  $oldSilent = $env:BIGBUD_INSTALL_SILENT
  $env:BIGBUD_INSTALL_SILENT = "1"

  $script:capturedArgs = $null
  $script:capturedArgList = $null

  try {
    . ([ScriptBlock]::Create($definitionsOnly))

    function Start-Process {
      [CmdletBinding()]
      param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [switch]$Wait,
        [switch]$PassThru
      )
      $script:capturedArgs = $PSBoundParameters
      $script:capturedArgList = $ArgumentList
      [PSCustomObject]@{ ExitCode = 0 }
    }

    function Invoke-RestMethod {
      param([hashtable]$Parameters)
      return @{
        assets = @(
          @{ name = "bigbud-1.0.0-x64.exe"; browser_download_url = "https://example.com/bigbud-1.0.0-x64.exe" }
        )
      }
    }

    function Invoke-WebRequest { param([hashtable]$Parameters) }
    function New-Item { param([string]$ItemType, [string]$Path, [switch]$Force); [PSCustomObject]@{ FullName = $Path } }
    function Remove-Item { param([string]$LiteralPath, [switch]$Recurse, [switch]$Force, [string]$ErrorAction) }
    function Join-Path { param([string]$Path, [string]$ChildPath); return "$Path\$ChildPath" }
    function Write-Host { param([string]$Message) }

    $env:PROCESSOR_ARCHITECTURE = "AMD64"
    Install-WindowsRelease

    Assert-True -Condition ($script:capturedArgs.ContainsKey("ArgumentList")) -Message "Silent mode SHOULD pass -ArgumentList"
    Assert-Equal -Expected "/S" -Actual ($script:capturedArgList -join ",") -Message "ArgumentList should be '/S' in silent mode"
  } finally {
    $env:BIGBUD_INSTALL_SILENT = $oldSilent
    Remove-Variable capturedArgs -Scope Script -ErrorAction SilentlyContinue
    Remove-Variable capturedArgList -Scope Script -ErrorAction SilentlyContinue
  }
}

# -------------------------------------------------------------------------
# Run all tests
# -------------------------------------------------------------------------

Write-Host ""
Write-Host "=== Bootstrap installer smoke tests ===" -ForegroundColor Cyan
Write-Host ""

Test-AssetSelectionX64
Test-AssetSelectionARM64
Test-AssetSelectionFallback
Test-AssetSelectionNoMatch
Test-InteractiveInstall
Test-SilentInstall

Write-Host ""
Write-Host "Results: $script:passes passed, $script:failures failed" -ForegroundColor $(if ($script:failures -gt 0) { "Red" } else { "Green" })
Write-Host ""

if ($script:failures -gt 0) {
  exit 1
}