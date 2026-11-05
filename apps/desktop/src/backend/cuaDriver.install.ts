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

import {
  resolveManagedPaths,
  resolveManagedVersionPaths,
  resolvePrivateStateHome,
} from "./cuaDriver.paths";
import { writeFileAtomically } from "./cuaDriver.atomicFile";
import { readPointerRuntimeVersion } from "./cuaDriver.runtime";
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
  writeFileAtomically(filePath, JSON.stringify(value));
}

export function writeManagedPolicy(policyPath: string): void {
  writeFileAtomically(policyPath, CUA_DRIVER_POLICY_YAML, 0o600);
}

function readPointer(pointerPath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(FS.readFileSync(pointerPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readVersionPath(pointerPath: string): string | null {
  const value = readPointer(pointerPath);
  return typeof value?.versionPath === "string" ? value.versionPath : null;
}

/**
 * The pointer to keep in `previous.json` after activating `installingVersion`:
 * one retained generation per known version, so a repair or reinstall of the
 * pinned version never evicts the other version's rollback slot (plan §11).
 * `null` leaves `previous.json` untouched.
 */
export function retainedPreviousPointer(input: {
  readonly active: Record<string, unknown> | null;
  readonly previous: Record<string, unknown> | null;
  readonly installingVersion: string;
}): Record<string, unknown> | null {
  if (!input.active) return null;
  const activeVersion = readPointerRuntimeVersion(input.active);
  const previousVersion = input.previous ? readPointerRuntimeVersion(input.previous) : null;
  const activeIsSameVersion = activeVersion === input.installingVersion;
  const previousIsOtherVersion =
    input.previous !== null &&
    previousVersion !== null &&
    previousVersion !== input.installingVersion;
  return activeIsSameVersion && previousIsOtherVersion ? null : input.active;
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

/**
 * `active.json` contents. `runtimeVersion` lets runtime selection skip a
 * generation whose Driver version differs from the pin, so a pin flip falls
 * back to the retained `previous.json` generation with no download.
 */
export function activeRuntimePointer(
  versionPaths: Pick<
    ReturnType<typeof resolveManagedVersionPaths>,
    "rootDir" | "binaryPath" | "policyPath"
  >,
) {
  return {
    versionPath: versionPaths.rootDir,
    binaryPath: versionPaths.binaryPath,
    policyPath: versionPaths.policyPath,
    policyVersion: CUA_DRIVER_POLICY_VERSION,
    policySha256: CUA_DRIVER_POLICY_SHA256,
    runtimeVersion: CUA_DRIVER_VERSION,
  };
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
  const stateHome = resolvePrivateStateHome(input.baseDir);
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
    await validateCuaDriverRuntime(versionPaths.binaryPath, versionPaths.policyPath, stateHome);
    await validateCuaDriverActivation({
      binaryPath: versionPaths.binaryPath,
      policyPath: versionPaths.policyPath,
      hostBundleId: input.hostBundleId,
    });
    const retainedPrevious = retainedPreviousPointer({
      active: readPointer(managedPaths.activePath),
      previous: readPointer(managedPaths.previousPath),
      installingVersion: CUA_DRIVER_VERSION,
    });
    if (retainedPrevious) writeJsonAtomically(managedPaths.previousPath, retainedPrevious);
    writeJsonAtomically(managedPaths.activePath, activeRuntimePointer(versionPaths));
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
