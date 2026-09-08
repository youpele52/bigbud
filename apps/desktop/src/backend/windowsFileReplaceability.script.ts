export const WINDOWS_REPLACEABILITY_PATHS_ENV = "BIGBUD_WINDOWS_REPLACEABILITY_PATHS";

export const WINDOWS_FILE_REPLACEABILITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Write-ProbeResult([object]$Value, [int]$ExitCode) {
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress))
  exit $ExitCode
}

try {
  $rawPaths = [Environment]::GetEnvironmentVariable('${WINDOWS_REPLACEABILITY_PATHS_ENV}', 'Process')
  $payload = ConvertFrom-Json -InputObject $rawPaths
  $paths = @($payload.paths)
  if ($paths.Count -lt 1) { throw 'missing paths' }
  foreach ($path in $paths) {
    if (-not ($path -is [string]) -or [string]::IsNullOrWhiteSpace($path)) { throw 'invalid path' }
  }
} catch {
  Write-ProbeResult ([ordered]@{ status = 'error'; code = 'invalid_input' }) 1
}

$nativeSource = @'
using System;
using System.Runtime.InteropServices;

public static class BigbudFileReplaceabilityProbe {
  private const uint GenericRead = 0x80000000u;
  private const uint GenericWrite = 0x40000000u;
  private const uint DeleteAccess = 0x00010000u;
  private const uint FileShareRead = 0x1;
  private const uint FileShareWrite = 0x2;
  private const uint FileShareDelete = 0x4;
  private const uint OpenExisting = 3;
  private const uint FileAttributeNormal = 0x80;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateFileW(
    string fileName,
    uint desiredAccess,
    uint shareMode,
    IntPtr securityAttributes,
    uint creationDisposition,
    uint flagsAndAttributes,
    IntPtr templateFile
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  public static int Probe(string path) {
    IntPtr handle = CreateFileW(
      path,
      GenericRead | GenericWrite | DeleteAccess,
      FileShareRead | FileShareWrite | FileShareDelete,
      IntPtr.Zero,
      OpenExisting,
      FileAttributeNormal,
      IntPtr.Zero
    );
    if (handle == new IntPtr(-1)) return Marshal.GetLastWin32Error();
    CloseHandle(handle);
    return 0;
  }
}
'@

try {
  $null = Add-Type -TypeDefinition $nativeSource -Language CSharp
} catch {
  Write-ProbeResult ([ordered]@{ status = 'error'; code = 'helper_initialization_failed' }) 1
}

for ($index = 0; $index -lt $paths.Count; $index += 1) {
  $errorCode = [BigbudFileReplaceabilityProbe]::Probe($paths[$index])
  if ($errorCode -ne 0) {
    Write-ProbeResult ([ordered]@{
      status = 'error'; code = 'file_not_replaceable'; index = $index; win32Error = $errorCode
    }) 1
  }
}
Write-ProbeResult ([ordered]@{ status = 'ok'; checked = $paths.Count }) 0
`;
