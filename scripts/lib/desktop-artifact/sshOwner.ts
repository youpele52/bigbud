import { basename } from "node:path";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { nativeReleaseBuildPlan } from "../native-release-build.ts";
import {
  assertSshOwnerBinary,
  findDesktopSshOwnerTarget,
  SSH_OWNER_BINARY_NAME,
  sshOwnerServerRelativePath,
  verifyInactiveSshOwner,
} from "../packaged-ssh-owner.ts";
import {
  type BuildArch,
  type BuildPlatform,
  BuildScriptError,
  commandOutputOptions,
  runCommand,
} from "./shared.ts";

export function sshOwnerBuildPlan(input: {
  readonly repoRoot: string;
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
}) {
  const target = findDesktopSshOwnerTarget(input.platform, input.arch);
  if (!target) return undefined;
  const relativePath = sshOwnerServerRelativePath(target.platform);
  const plan = nativeReleaseBuildPlan({
    repoRoot: input.repoRoot,
    packageName: SSH_OWNER_BINARY_NAME,
    binaryName: basename(relativePath),
    target,
    native:
      target.platform === (input.hostPlatform ?? process.platform) &&
      target.arch === (input.hostArch ?? process.arch),
  });
  return { target, relativePath, ...plan };
}

export const stagePackagedSshOwner = Effect.fn("stagePackagedSshOwner")(function* (input: {
  readonly repoRoot: string;
  readonly stageServerDir: string;
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly skipBuild: boolean;
  readonly verbose: boolean;
}) {
  const plan = sshOwnerBuildPlan(input);
  if (!plan) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!input.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building native SSH owner (packaging only)...");
    yield* runCommand(
      ChildProcess.make("cargo", plan.cargoArgs, {
        cwd: input.repoRoot,
        ...commandOutputOptions(input.verbose),
      }),
    );
  }

  const destination = path.join(input.stageServerDir, plan.relativePath);
  const assertBinary = (binaryPath: string) =>
    Effect.try({
      try: () => assertSshOwnerBinary(binaryPath, plan.target),
      catch: (cause) =>
        new BuildScriptError({ message: `Invalid SSH owner at ${binaryPath}`, cause }),
    });
  yield* assertBinary(plan.source);
  yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
  yield* fs.copyFile(plan.source, destination);
  if (plan.target.platform === "darwin") yield* fs.chmod(destination, 0o755);
  yield* assertBinary(destination);
  yield* Effect.try({
    try: () => verifyInactiveSshOwner(destination, plan.target),
    catch: (cause) => new BuildScriptError({ message: "Staged SSH owner smoke failed", cause }),
  });
});
