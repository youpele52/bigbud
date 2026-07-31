import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  cuaDriverReleaseUrl,
  resolveCuaDriverReleaseArtifact,
} from "@bigbud/shared/cua-driver/release";
import { CUA_DRIVER_POLICY_YAML } from "@bigbud/shared/cua-driver/policy";
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

function resolveArchive(platform: typeof BuildPlatform.Type, arch: typeof BuildArch.Type) {
  const runtimePlatform = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  return resolveCuaDriverReleaseArtifact(runtimePlatform, arch === "universal" ? "arm64" : arch);
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
    const url = cuaDriverReleaseUrl(archive);

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

    if (input.platform === "win") {
      yield* runCommand(
        ChildProcess.make({
          cwd: downloadDir,
          ...commandOutputOptions(input.verbose),
          shell: true,
        })`powershell -NoProfile -Command "Expand-Archive -Path ${archive.archiveName} -DestinationPath extract -Force"`,
      );
    } else {
      yield* runCommand(
        ChildProcess.make({
          cwd: downloadDir,
          ...commandOutputOptions(input.verbose),
          shell: shellOptionForPlatform(input.platform),
        })`tar -xf ${archive.archiveName} -C extract`,
      );
    }

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
    const targetPolicyDir = path.join(targetRootDir, "policy");
    yield* fs.makeDirectory(targetPolicyDir, { recursive: true });
    yield* fs.writeFileString(path.join(targetPolicyDir, "bigbud.yaml"), CUA_DRIVER_POLICY_YAML);

    if (archive.appPath) {
      const appSourcePath = path.join(extractDir, ...archive.appPath);
      if (yield* fs.exists(appSourcePath)) {
        yield* fs.copy(appSourcePath, path.join(targetRootDir, "CuaDriver.app"));
      }
    }
  },
);
