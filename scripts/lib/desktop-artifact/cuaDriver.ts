import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/unstable/process";

import {
  BuildArch,
  BuildPlatform,
  BuildScriptError,
  commandOutputOptions,
  runCommand,
} from "./shared.ts";
import { shellOptionForPlatform } from "./platform.ts";

const CUA_DRIVER_VERSION = "0.6.8";
const REPO = "trycua/cua";

function resolveArchive(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
): {
  archiveName: string;
  sha256: string;
  binaryName: string;
  binaryPath: string[];
  appPath: string[] | null;
} {
  if (platform === "mac") {
    const stageDir = `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal`;
    return {
      archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal.tar.gz`,
      sha256: "33910c98e8e022b42cc4d079f9932ed406bccfaa9fabfe898edea7934d8bd154",
      binaryName: "cua-driver",
      binaryPath: [stageDir, "cua-driver"],
      appPath: [stageDir, "CuaDriver.app"],
    };
  }

  if (platform === "linux") {
    const label = arch === "arm64" ? "linux-arm64" : "linux-x86_64";
    return {
      archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-${label}-binary.tar.gz`,
      sha256:
        arch === "arm64"
          ? "aa154aed01568c20201f75d07bbb0edad93ba132bf21c429b69e48d438d473df"
          : "de885c6ad82b5e10ed0213be4642dda74b5922990ad6002eb5bc481d5d89c05b",
      binaryName: "cua-driver",
      binaryPath: ["cua-driver"],
      appPath: null,
    };
  }

  if (platform === "win") {
    const label = arch === "arm64" ? "windows-arm64" : "windows-x86_64";
    const stageDir = `cua-driver-rs-${CUA_DRIVER_VERSION}-${label}`;
    return {
      archiveName: `cua-driver-rs-${CUA_DRIVER_VERSION}-${label}-binary.zip`,
      sha256:
        arch === "arm64"
          ? "7d950d24aaf902357ce51827d23dd9c9c89a62720c1ff77effeec971139c696f"
          : "8cde6fa362a5d6c7d3e38be29ffd36eba42bdfb235cb0692bec79697a54affbe",
      binaryName: "cua-driver.exe",
      binaryPath: [stageDir, "cua-driver.exe"],
      appPath: null,
    };
  }

  throw new Error(`Unsupported desktop artifact platform '${platform}'.`);
}

const verifySha256 = Effect.fn("verifyCuaDriverSha256")(function* (
  filePath: string,
  expected: string,
) {
  const bytes = yield* Effect.promise(() => readFile(filePath));
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== expected) {
    return yield* new BuildScriptError({
      message: `Checksum mismatch for ${filePath}.`,
    });
  }
});

export const stagePackagedCuaDriverRuntime = Effect.fn("stagePackagedCuaDriverRuntime")(
  function* (input: {
    readonly stageRoot: string;
    readonly stageServerDir: string;
    readonly platform: typeof BuildPlatform.Type;
    readonly arch: typeof BuildArch.Type;
    readonly verbose: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const archive = resolveArchive(input.platform, input.arch);
    const downloadDir = path.join(input.stageRoot, "cua-driver-download");
    const extractDir = path.join(downloadDir, "extract");
    const archivePath = path.join(downloadDir, archive.archiveName);
    const url = `https://github.com/${REPO}/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/${archive.archiveName}`;

    yield* fs.makeDirectory(downloadDir, { recursive: true });
    yield* fs.makeDirectory(extractDir, { recursive: true });

    yield* runCommand(
      ChildProcess.make({
        cwd: downloadDir,
        ...commandOutputOptions(input.verbose),
        shell: shellOptionForPlatform(input.platform),
      })`curl -fsSL -o ${archivePath} ${url}`,
    );
    yield* verifySha256(archivePath, archive.sha256);

    yield* runCommand(
      ChildProcess.make({
        cwd: downloadDir,
        ...commandOutputOptions(input.verbose),
        shell: shellOptionForPlatform(input.platform),
      })`tar -xf ${archivePath} -C ${extractDir}`,
    );

    const binarySourcePath = path.join(extractDir, ...archive.binaryPath);
    if (!(yield* fs.exists(binarySourcePath))) {
      return yield* new BuildScriptError({
        message: `Expected packaged Cua driver binary at ${binarySourcePath}.`,
      });
    }

    const targetRootDir = path.join(input.stageServerDir, "cua-driver");
    const targetBinDir = path.join(targetRootDir, "bin");
    yield* fs.makeDirectory(targetBinDir, { recursive: true });
    yield* fs.copyFile(binarySourcePath, path.join(targetBinDir, archive.binaryName));

    if (archive.appPath) {
      const appSourcePath = path.join(extractDir, ...archive.appPath);
      if (yield* fs.exists(appSourcePath)) {
        yield* fs.copy(appSourcePath, path.join(targetRootDir, "CuaDriver.app"));
      }
    }
  },
);
