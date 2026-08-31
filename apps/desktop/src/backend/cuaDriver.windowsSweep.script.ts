export const WINDOWS_CUA_SWEEP_TARGET_PATH_ENV = "BIGBUD_CUA_SWEEP_TARGET_PATH";
export const WINDOWS_CUA_SWEEP_WAIT_TIMEOUT_ENV = "BIGBUD_CUA_SWEEP_WAIT_TIMEOUT_MS";
export const WINDOWS_CUA_SWEEP_DRY_RUN_ENV = "BIGBUD_CUA_SWEEP_DRY_RUN";

export const WINDOWS_CUA_SWEEP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Write-SweepResult([object]$Value, [int]$ExitCode) {
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress))
  exit $ExitCode
}

$targetPath = [Environment]::GetEnvironmentVariable('${WINDOWS_CUA_SWEEP_TARGET_PATH_ENV}', 'Process')
$waitRaw = [Environment]::GetEnvironmentVariable('${WINDOWS_CUA_SWEEP_WAIT_TIMEOUT_ENV}', 'Process')
$dryRunRaw = [Environment]::GetEnvironmentVariable('${WINDOWS_CUA_SWEEP_DRY_RUN_ENV}', 'Process')
try {
  if ([string]::IsNullOrWhiteSpace($targetPath)) { throw 'missing target' }
  $waitTimeoutMs = [uint32]::Parse($waitRaw)
  $dryRun = $dryRunRaw -eq '1'
} catch {
  Write-SweepResult ([ordered]@{ status = 'error'; code = 'invalid_input' }) 1
}

$nativeSource = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public sealed class BigbudCuaSweepResult {
  public int Matched { get; set; }
  public int Terminated { get; set; }
  public int Raced { get; set; }
  public string ErrorCode { get; set; }
  public uint ErrorPid { get; set; }
}

public static class BigbudCuaProcessHandle {
  private const uint ProcessTerminate = 0x0001;
  private const uint ProcessQueryLimitedInformation = 0x1000;
  private const uint Synchronize = 0x00100000;
  private const uint WaitObject0 = 0x00000000;
  private const uint WaitTimeout = 0x00000102;
  private const uint ErrorInvalidParameter = 87;
  private const uint ErrorNotFound = 1168;
  private const uint FileShareRead = 0x1;
  private const uint FileShareWrite = 0x2;
  private const uint FileShareDelete = 0x4;
  private const uint OpenExisting = 3;
  private const uint FileAttributeNormal = 0x80;

  [StructLayout(LayoutKind.Sequential)]
  private struct ByHandleFileInformation {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool QueryFullProcessImageNameW(
    IntPtr process,
    uint flags,
    StringBuilder imagePath,
    ref uint pathLength
  );

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
  private static extern bool GetFileInformationByHandle(
    IntPtr file,
    out ByHandleFileInformation information
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr process, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  private static string NormalizePath(string value) {
    string fullPath = Path.GetFullPath(value);
    if (fullPath.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) {
      return @"\\" + fullPath.Substring(8);
    }
    if (fullPath.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) {
      return fullPath.Substring(4);
    }
    return fullPath;
  }

  private static int CompareFileIdentity(string candidatePath, string targetPath) {
    const uint sharing = FileShareRead | FileShareWrite | FileShareDelete;
    IntPtr leftHandle = CreateFileW(
      candidatePath, 0, sharing, IntPtr.Zero, OpenExisting, FileAttributeNormal, IntPtr.Zero
    );
    if (leftHandle == new IntPtr(-1)) return -1;
    try {
      IntPtr rightHandle = CreateFileW(
        targetPath, 0, sharing, IntPtr.Zero, OpenExisting, FileAttributeNormal, IntPtr.Zero
      );
      if (rightHandle == new IntPtr(-1)) return -2;
      try {
        ByHandleFileInformation leftInfo;
        ByHandleFileInformation rightInfo;
        if (!GetFileInformationByHandle(leftHandle, out leftInfo)) return -3;
        if (!GetFileInformationByHandle(rightHandle, out rightInfo)) return -4;
        bool sameIdentity = leftInfo.VolumeSerialNumber == rightInfo.VolumeSerialNumber
          && leftInfo.FileIndexHigh == rightInfo.FileIndexHigh
          && leftInfo.FileIndexLow == rightInfo.FileIndexLow;
        return sameIdentity ? 1 : 0;
      } finally {
        CloseHandle(rightHandle);
      }
    } finally {
      CloseHandle(leftHandle);
    }
  }

  private static bool ProcessIsGone(uint processId) {
    try {
      using (Process process = Process.GetProcessById((int)processId)) {
        return process.HasExited;
      }
    } catch (ArgumentException) {
      return true;
    } catch {
      return false;
    }
  }

  private static int MatchHandlePath(IntPtr handle, string expectedPath) {
    StringBuilder imagePath = new StringBuilder(32768);
    uint pathLength = (uint)imagePath.Capacity;
    if (!QueryFullProcessImageNameW(handle, 0, imagePath, ref pathLength)) return -1;
    string actualPath;
    string targetPath;
    try {
      actualPath = NormalizePath(imagePath.ToString());
      targetPath = NormalizePath(expectedPath);
    } catch {
      return -1;
    }
    if (String.Equals(actualPath, targetPath, StringComparison.OrdinalIgnoreCase)) return 1;
    int identity = CompareFileIdentity(actualPath, targetPath);
    return identity < 0 ? identity - 1 : identity;
  }

  private static int InspectCandidate(uint processId, string expectedPath) {
    IntPtr handle = OpenProcess(ProcessQueryLimitedInformation, false, processId);
    if (handle == IntPtr.Zero) {
      uint error = (uint)Marshal.GetLastWin32Error();
      if ((error == ErrorInvalidParameter || error == ErrorNotFound) && ProcessIsGone(processId)) {
        return 2;
      }
      return 20;
    }
    try {
      int match = MatchHandlePath(handle, expectedPath);
      if (match == -1) return 21;
      if (match < -1) return 13 - match;
      return match;
    } finally {
      CloseHandle(handle);
    }
  }

  private static int VerifyTerminateAndWait(
    uint processId,
    string expectedPath,
    uint waitMs,
    bool dryRun
  ) {
    IntPtr handle = OpenProcess(
      ProcessTerminate | ProcessQueryLimitedInformation | Synchronize,
      false,
      processId
    );
    if (handle == IntPtr.Zero) {
      uint error = (uint)Marshal.GetLastWin32Error();
      if ((error == ErrorInvalidParameter || error == ErrorNotFound) && ProcessIsGone(processId)) {
        return 2;
      }
      return 10;
    }
    try {
      int match = MatchHandlePath(handle, expectedPath);
      if (match == 0) return 2;
      if (match == -1) return WaitForSingleObject(handle, 0) == WaitObject0 ? 2 : 11;
      if (match < -1) return 13 - match;
      if (dryRun) return 3;
      if (!TerminateProcess(handle, 1)) {
        return WaitForSingleObject(handle, 0) == WaitObject0 ? 2 : 12;
      }
      uint waitResult = WaitForSingleObject(handle, waitMs);
      if (waitResult == WaitObject0) return 1;
      if (waitResult == WaitTimeout) return 13;
      return 14;
    } finally {
      CloseHandle(handle);
    }
  }

  public static BigbudCuaSweepResult Sweep(string expectedPath, uint waitMs, bool dryRun) {
    BigbudCuaSweepResult result = new BigbudCuaSweepResult();
    Process[] candidates;
    try {
      candidates = Process.GetProcessesByName("cua-driver");
    } catch {
      result.ErrorCode = "enumeration_failed";
      return result;
    }
    foreach (Process candidate in candidates) {
      uint processId;
      try {
        processId = (uint)candidate.Id;
      } catch {
        result.Raced += 1;
        candidate.Dispose();
        continue;
      }
      candidate.Dispose();
      int inspectionResult = InspectCandidate(processId, expectedPath);
      if (inspectionResult == 0) continue;
      if (inspectionResult == 2) { result.Raced += 1; continue; }
      if (inspectionResult != 1) {
        result.ErrorPid = processId;
        result.ErrorCode = inspectionResult == 20 ? "inspect_open_failed"
          : inspectionResult == 21 ? "inspect_query_failed"
          : inspectionResult == 15 ? "identity_candidate_open_failed"
          : inspectionResult == 16 ? "identity_target_open_failed"
          : inspectionResult == 17 ? "identity_candidate_query_failed"
          : "identity_target_query_failed";
        return result;
      }
      int candidateResult = VerifyTerminateAndWait(processId, expectedPath, waitMs, dryRun);
      if (candidateResult == 0) continue;
      if (candidateResult == 1) { result.Matched += 1; result.Terminated += 1; continue; }
      if (candidateResult == 2) { result.Raced += 1; continue; }
      if (candidateResult == 3) { result.Matched += 1; continue; }
      result.ErrorPid = processId;
      result.ErrorCode = candidateResult == 10 ? "open_failed"
        : candidateResult == 11 ? "query_failed"
        : candidateResult == 12 ? "termination_failed"
        : candidateResult == 13 ? "wait_timeout"
        : candidateResult == 14 ? "wait_failed"
        : candidateResult == 15 ? "identity_candidate_open_failed"
        : candidateResult == 16 ? "identity_target_open_failed"
        : candidateResult == 17 ? "identity_candidate_query_failed"
        : "identity_target_query_failed";
      return result;
    }
    return result;
  }
}
'@

try {
  $null = Add-Type -TypeDefinition $nativeSource -Language CSharp
} catch {
  Write-SweepResult ([ordered]@{ status = 'error'; code = 'helper_initialization_failed' }) 1
}

try {
  $result = [BigbudCuaProcessHandle]::Sweep($targetPath, $waitTimeoutMs, $dryRun)
} catch {
  Write-SweepResult ([ordered]@{ status = 'error'; code = 'native_execution_failed' }) 1
}
if (![string]::IsNullOrWhiteSpace($result.ErrorCode)) {
  $failure = [ordered]@{ status = 'error'; code = $result.ErrorCode }
  if ($result.ErrorPid -gt 0) { $failure.pid = $result.ErrorPid }
  Write-SweepResult $failure 1
}
Write-SweepResult ([ordered]@{
  status = 'ok'
  matched = $result.Matched
  terminated = $result.Terminated
  raced = $result.Raced
}) 0
`;
