import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DesktopBuildPlatform } from "./packaged-workspace-agent.ts";

export function getPackagedDesktopSupervisorSuffix(platform: DesktopBuildPlatform): string {
  const binaryName =
    platform === "win" ? "bigbud-desktop-supervisor.exe" : "bigbud-desktop-supervisor";
  const resourcesDirectory = platform === "mac" ? "Contents/Resources" : "resources";
  return `/${resourcesDirectory}/server/delivery-supervisor/bin/${binaryName}`;
}

export function findPackagedDesktopSupervisor(
  directory: string,
  platform: DesktopBuildPlatform,
): string | undefined {
  const suffix = getPackagedDesktopSupervisorSuffix(platform);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findPackagedDesktopSupervisor(path, platform);
      if (nested) return nested;
    } else if (entry.isFile() && path.replaceAll("\\", "/").endsWith(suffix)) {
      return path;
    }
  }
  return undefined;
}

export function verifyPackagedDesktopSupervisorEvidence(
  binaryPath: string,
  options: { readonly verifyDigest?: boolean } = {},
): void {
  const evidenceDirectory = dirname(binaryPath);
  const manifest = JSON.parse(
    readFileSync(join(evidenceDirectory, "artifact-manifest.json"), "utf8"),
  ) as {
    readonly binary?: unknown;
    readonly protocol?: { readonly major?: unknown; readonly minor?: unknown };
    readonly sha256?: unknown;
  };
  const validDigest = typeof manifest.sha256 === "string" && /^[0-9a-f]{64}$/.test(manifest.sha256);
  const digestMatches =
    options.verifyDigest === false ||
    manifest.sha256 === createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
  if (
    manifest.binary !== binaryPath.split(/[\\/]/).at(-1) ||
    !validDigest ||
    !digestMatches ||
    manifest.protocol?.major !== 1 ||
    manifest.protocol.minor !== 3
  ) {
    throw new Error("Packaged desktop supervisor manifest is incompatible or stale");
  }
  const sbom = JSON.parse(readFileSync(join(evidenceDirectory, "sbom.cdx.json"), "utf8")) as {
    readonly bomFormat?: unknown;
    readonly components?: unknown;
  };
  if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components)) {
    throw new Error("Packaged desktop supervisor SBOM is missing or incompatible");
  }
}
