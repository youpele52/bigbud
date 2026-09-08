import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

export type DesktopBuildPlatform = "linux" | "mac" | "win";

export function getPackagedWorkspaceAgentSuffix(platform: DesktopBuildPlatform): string {
  const binaryName = platform === "win" ? "bigbud-remote-agent.exe" : "bigbud-remote-agent";
  const resourcesDirectory = platform === "mac" ? "Contents/Resources" : "resources";
  return `/${resourcesDirectory}/server/workspace-agent/bin/${binaryName}`;
}

export function findPackagedWorkspaceAgent(
  directory: string,
  platform: DesktopBuildPlatform,
): string | undefined {
  const suffix = getPackagedWorkspaceAgentSuffix(platform);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findPackagedWorkspaceAgent(path, platform);
      if (nested) return nested;
    } else if (entry.isFile() && path.replaceAll("\\", "/").endsWith(suffix)) {
      return path;
    }
  }
  return undefined;
}

export function validateCodeSignatureRequirement(
  platform: DesktopBuildPlatform,
  requireCodeSignature: boolean,
  expectedWindowsPublisher?: string,
): void {
  if (requireCodeSignature && platform === "linux") {
    throw new Error("--require-code-signature is not valid for Linux packages");
  }
  if (requireCodeSignature && platform === "win" && !expectedWindowsPublisher?.trim()) {
    throw new Error("BIGBUD_WINDOWS_SIGNING_SUBJECT is required for Windows signature checks");
  }
}

export function verifyPackagedCodeSignature(
  binaryPath: string,
  platform: Exclude<DesktopBuildPlatform, "linux">,
  expectedWindowsPublisher?: string,
): void {
  if (platform === "mac") {
    execFileSync("codesign", ["--verify", "--strict", "--verbose=2", binaryPath], {
      stdio: "inherit",
    });
    return;
  }
  validateCodeSignatureRequirement(platform, true, expectedWindowsPublisher);
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$signature = Get-AuthenticodeSignature -LiteralPath $env:BIGBUD_SIGNATURE_PATH; " +
        "if ($signature.Status -ne 'Valid') { throw \"Invalid Authenticode status: $($signature.Status)\" }; " +
        'if ($null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Subject -ne $env:BIGBUD_EXPECTED_WINDOWS_PUBLISHER) { throw "Unexpected Authenticode publisher" }',
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        BIGBUD_SIGNATURE_PATH: binaryPath,
        BIGBUD_EXPECTED_WINDOWS_PUBLISHER: expectedWindowsPublisher,
      },
    },
  );
}
