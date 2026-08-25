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
): void {
  if (requireCodeSignature && platform !== "mac") {
    throw new Error("--require-code-signature is only valid for macOS packages");
  }
}
