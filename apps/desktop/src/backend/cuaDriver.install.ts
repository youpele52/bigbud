import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import type {
  DesktopComputerUseInstallResult,
  DesktopComputerUseRuntimeStatus,
} from "@bigbud/contracts/server/ipc.desktopComputerUse.ts";

import { resolveManagedPaths } from "./cuaDriver.paths";
import { runCommand } from "./cuaDriver.process";

const CUA_DRIVER_VERSION = "0.6.8";
const CUA_DRIVER_RELEASE_BASE_URL = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}`;
const INSTALL_COMMAND_TIMEOUT_MS = 5 * 60_000;

interface CuaDriverArtifact {
  readonly archiveName: string;
  readonly sha256: string;
  readonly binaryPath: readonly string[];
  readonly appPath: readonly string[] | null;
}

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

function resolveManagedArtifact(): CuaDriverArtifact {
  if (process.platform === "darwin") {
    const stageDir = `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal`;
    return {
      archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal.tar.gz`,
      sha256: "33910c98e8e022b42cc4d079f9932ed406bccfaa9fabfe898edea7934d8bd154",
      binaryPath: [stageDir, "cua-driver"],
      appPath: [stageDir, "CuaDriver.app"],
    };
  }

  if (process.platform === "linux") {
    const label = process.arch === "arm64" ? "linux-arm64" : "linux-x86_64";
    return {
      archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-${label}-binary.tar.gz`,
      sha256:
        process.arch === "arm64"
          ? "aa154aed01568c20201f75d07bbb0edad93ba132bf21c429b69e48d438d473df"
          : "de885c6ad82b5e10ed0213be4642dda74b5922990ad6002eb5bc481d5d89c05b",
      binaryPath: ["cua-driver"],
      appPath: null,
    };
  }

  if (process.platform === "win32") {
    const label = process.arch === "arm64" ? "windows-arm64" : "windows-x86_64";
    const stageDir = `cua-driver-rs-${CUA_DRIVER_VERSION}-${label}`;
    return {
      archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-${label}-binary.zip`,
      sha256:
        process.arch === "arm64"
          ? "7d950d24aaf902357ce51827d23dd9c9c89a62720c1ff77effeec971139c696f"
          : "8cde6fa362a5d6c7d3e38be29ffd36eba42bdfb235cb0692bec79697a54affbe",
      binaryPath: [stageDir, "cua-driver.exe"],
      appPath: null,
    };
  }

  throw new Error(`Unsupported Computer Use runtime platform '${process.platform}'.`);
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

export async function installManagedComputerUseRuntime(input: {
  readonly baseDir: string;
  readonly getStatus: () => Promise<DesktopComputerUseRuntimeStatus>;
}): Promise<DesktopComputerUseInstallResult> {
  const managedPaths = resolveManagedPaths(input.baseDir);
  const artifact = resolveManagedArtifact();
  const archivePath = Path.join(managedPaths.downloadDir, artifact.archiveName);
  const extractDir = Path.join(managedPaths.downloadDir, "extract");
  FS.mkdirSync(managedPaths.binDir, { recursive: true });
  FS.mkdirSync(managedPaths.homeDir, { recursive: true });
  FS.mkdirSync(managedPaths.downloadDir, { recursive: true });

  try {
    await downloadArtifact(`${CUA_DRIVER_RELEASE_BASE_URL}/${artifact.archiveName}`, archivePath);
    verifySha256(archivePath, artifact.sha256);
    await extractArtifact(archivePath, extractDir);
    const binarySourcePath = Path.join(extractDir, ...artifact.binaryPath);
    if (!FS.existsSync(binarySourcePath)) {
      throw new Error(`Expected Computer Use runtime binary at ${binarySourcePath}.`);
    }
    installManagedBinary(binarySourcePath, managedPaths.binaryPath);
    if (artifact.appPath) {
      const appSourcePath = Path.join(extractDir, ...artifact.appPath);
      if (FS.existsSync(appSourcePath)) {
        FS.cpSync(appSourcePath, Path.join(managedPaths.rootDir, "CuaDriver.app"), {
          recursive: true,
          force: true,
        });
      }
    }
  } catch (error) {
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
