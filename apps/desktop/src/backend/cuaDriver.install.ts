import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import {
  CUA_DRIVER_VERSION,
  cuaDriverReleaseUrl,
  resolveCuaDriverReleaseArtifact,
  type CuaDriverReleaseArtifact,
} from "@bigbud/shared/cua-driver/release";
import {
  CUA_DRIVER_POLICY_SHA256,
  CUA_DRIVER_POLICY_VERSION,
  CUA_DRIVER_POLICY_YAML,
} from "@bigbud/shared/cua-driver/policy";
import type {
  DesktopComputerUseInstallResult,
  DesktopComputerUseRuntimeStatus,
} from "@bigbud/contracts/server/ipc.desktopComputerUse.ts";

import { resolveManagedPaths, resolveManagedVersionPaths } from "./cuaDriver.paths";
import { validateCuaDriverActivation } from "./cuaDriver.activation";
import { validateCuaDriverRuntime } from "./cuaDriver.manifest";
import { runCommand } from "./cuaDriver.process";

const INSTALL_COMMAND_TIMEOUT_MS = 5 * 60_000;
let installPromise: Promise<DesktopComputerUseInstallResult> | null = null;

function installManagedBinary(sourcePath: string, destinationPath: string): void {
  const tempPath = `${destinationPath}.${Crypto.randomUUID()}.tmp`;
  const binaryContents = FS.readFileSync(sourcePath);
  FS.mkdirSync(Path.dirname(destinationPath), { recursive: true });
  FS.writeFileSync(tempPath, binaryContents);
  if (process.platform !== "win32") {
    FS.chmodSync(tempPath, 0o755);
  }
  FS.rmSync(destinationPath, { force: true });
  FS.renameSync(tempPath, destinationPath);
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  writeTextAtomically(filePath, JSON.stringify(value));
}

function writeTextAtomically(filePath: string, contents: string, mode?: number): void {
  const tempPath = `${filePath}.${Crypto.randomUUID()}.tmp`;
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(tempPath, contents, mode === undefined ? undefined : { encoding: "utf8", mode });
  FS.renameSync(tempPath, filePath);
}

export function writeManagedPolicy(policyPath: string): void {
  writeTextAtomically(policyPath, CUA_DRIVER_POLICY_YAML, 0o600);
}

function readVersionPath(pointerPath: string): string | null {
  try {
    const value = JSON.parse(FS.readFileSync(pointerPath, "utf8")) as Record<string, unknown>;
    return typeof value.versionPath === "string" ? value.versionPath : null;
  } catch {
    return null;
  }
}

export function cleanupUnreferencedVersions(baseDir: string): void {
  const managed = resolveManagedPaths(baseDir);
  const retained = new Set(
    [readVersionPath(managed.activePath), readVersionPath(managed.previousPath)].filter(
      (value): value is string => value !== null,
    ),
  );
  if (!FS.existsSync(managed.versionsDir)) return;
  for (const entry of FS.readdirSync(managed.versionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = Path.join(managed.versionsDir, entry.name);
    if (!retained.has(candidate)) FS.rmSync(candidate, { recursive: true, force: true });
  }
}

function resolveManagedArtifact(): CuaDriverReleaseArtifact {
  if (
    process.platform !== "darwin" &&
    process.platform !== "linux" &&
    process.platform !== "win32"
  ) {
    throw new Error(`Unsupported Computer Use runtime platform '${process.platform}'.`);
  }
  if (process.arch !== "arm64" && process.arch !== "x64") {
    throw new Error(`Unsupported Computer Use runtime architecture '${process.arch}'.`);
  }
  return resolveCuaDriverReleaseArtifact(process.platform, process.arch);
}

function verifySha256(filePath: string, expected: string): void {
  const hash = Crypto.createHash("sha256").update(FS.readFileSync(filePath)).digest("hex");
  if (hash !== expected) {
    throw new Error(`Computer Use runtime checksum mismatch for ${Path.basename(filePath)}.`);
  }
}

async function downloadArtifact(url: string, archivePath: string): Promise<void> {
  const result = await runCommand(
    "curl",
    ["-fsSL", "-o", archivePath, url],
    undefined,
    INSTALL_COMMAND_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      [result.stderr, result.stdout].filter(Boolean).join("\n\n") ||
        "Computer Use runtime download failed.",
    );
  }
}

async function extractArtifact(archivePath: string, extractDir: string): Promise<void> {
  FS.rmSync(extractDir, { recursive: true, force: true });
  FS.mkdirSync(extractDir, { recursive: true });

  const result =
    process.platform === "win32"
      ? await runCommand(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "Expand-Archive",
            "-LiteralPath",
            archivePath,
            "-DestinationPath",
            extractDir,
            "-Force",
          ],
          undefined,
          INSTALL_COMMAND_TIMEOUT_MS,
        )
      : await runCommand(
          "tar",
          ["-xf", archivePath, "-C", extractDir],
          undefined,
          INSTALL_COMMAND_TIMEOUT_MS,
        );
  if (result.code !== 0) {
    throw new Error(
      [result.stderr, result.stdout].filter(Boolean).join("\n\n") ||
        "Computer Use runtime extraction failed.",
    );
  }
}

async function installManagedComputerUseRuntimeExclusive(input: {
  readonly baseDir: string;
  readonly getStatus: () => Promise<DesktopComputerUseRuntimeStatus>;
  readonly hostBundleId: string;
}): Promise<DesktopComputerUseInstallResult> {
  const managedPaths = resolveManagedPaths(input.baseDir);
  const versionPaths = resolveManagedVersionPaths(input.baseDir, Crypto.randomUUID());
  const artifact = resolveManagedArtifact();
  const archivePath = Path.join(managedPaths.downloadDir, artifact.archiveName);
  const extractDir = Path.join(managedPaths.downloadDir, "extract");
  FS.mkdirSync(managedPaths.homeDir, { recursive: true });
  FS.mkdirSync(managedPaths.downloadDir, { recursive: true });
  cleanupUnreferencedVersions(input.baseDir);

  try {
    await downloadArtifact(cuaDriverReleaseUrl(artifact), archivePath);
    verifySha256(archivePath, artifact.sha256);
    await extractArtifact(archivePath, extractDir);
    const binarySourcePath = Path.join(extractDir, ...artifact.binaryPath);
    if (!FS.existsSync(binarySourcePath)) {
      throw new Error(`Expected Computer Use runtime binary at ${binarySourcePath}.`);
    }
    installManagedBinary(binarySourcePath, versionPaths.binaryPath);
    writeManagedPolicy(versionPaths.policyPath);
    writeJsonAtomically(versionPaths.installManifestPath, {
      schemaVersion: "1",
      runtimeVersion: CUA_DRIVER_VERSION,
      artifactSha256: artifact.sha256,
      binaryPath: versionPaths.binaryPath,
      policyPath: versionPaths.policyPath,
      policyVersion: CUA_DRIVER_POLICY_VERSION,
      policySha256: CUA_DRIVER_POLICY_SHA256,
    });
    if (artifact.appPath) {
      const appSourcePath = Path.join(extractDir, ...artifact.appPath);
      if (FS.existsSync(appSourcePath)) {
        FS.rmSync(versionPaths.appPath, { recursive: true, force: true });
        FS.cpSync(appSourcePath, versionPaths.appPath, {
          recursive: true,
          force: true,
        });
      }
    }
    await validateCuaDriverRuntime(versionPaths.binaryPath, versionPaths.policyPath);
    await validateCuaDriverActivation({
      binaryPath: versionPaths.binaryPath,
      policyPath: versionPaths.policyPath,
      hostBundleId: input.hostBundleId,
    });
    const previous = FS.existsSync(managedPaths.activePath)
      ? FS.readFileSync(managedPaths.activePath, "utf8")
      : null;
    if (previous) {
      writeJsonAtomically(managedPaths.previousPath, JSON.parse(previous));
    }
    writeJsonAtomically(managedPaths.activePath, {
      versionPath: versionPaths.rootDir,
      binaryPath: versionPaths.binaryPath,
      policyPath: versionPaths.policyPath,
      policyVersion: CUA_DRIVER_POLICY_VERSION,
      policySha256: CUA_DRIVER_POLICY_SHA256,
    });
    cleanupUnreferencedVersions(input.baseDir);
  } catch (error) {
    FS.rmSync(versionPaths.rootDir, { recursive: true, force: true });
    const status = await input.getStatus();
    return {
      ok: false,
      status: {
        ...status,
        message:
          error instanceof Error ? error.message : "Computer Use runtime installation failed.",
      },
    };
  }

  const status = await input.getStatus();
  return { ok: status.available, status };
}

export function installManagedComputerUseRuntime(input: {
  readonly baseDir: string;
  readonly getStatus: () => Promise<DesktopComputerUseRuntimeStatus>;
  readonly hostBundleId: string;
}): Promise<DesktopComputerUseInstallResult> {
  if (installPromise) return installPromise;
  installPromise = installManagedComputerUseRuntimeExclusive(input).finally(() => {
    installPromise = null;
  });
  return installPromise;
}
