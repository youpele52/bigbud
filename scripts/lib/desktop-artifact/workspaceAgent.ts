import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

import { Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { verifyWorkspaceAgentHandshake } from "../workspace-agent-handshake.ts";
import {
  assertWorkspaceAgentArtifactTarget,
  findDesktopWorkspaceAgentTarget,
  type WorkspaceAgentTarget,
  workspaceAgentBinaryName as targetBinaryName,
} from "../workspace-agent-target.ts";
import {
  BuildArch,
  BuildScriptError,
  commandOutputOptions,
  runCommand,
  type BuildPlatform,
} from "./shared.ts";

export function workspaceAgentBinaryName(platform: typeof BuildPlatform.Type): string {
  return platform === "win" ? "bigbud-remote-agent.exe" : "bigbud-remote-agent";
}

export function packagedWorkspaceAgentPath(serverDir: string, platform: typeof BuildPlatform.Type) {
  return join(serverDir, "workspace-agent", "bin", workspaceAgentBinaryName(platform));
}

export const assertWorkspaceAgentBinary = Effect.fn("assertWorkspaceAgentBinary")(function* (
  binaryPath: string,
  label: string,
  target: WorkspaceAgentTarget,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(binaryPath))) {
    return yield* new BuildScriptError({ message: `${label}: missing ${binaryPath}` });
  }
  const stat = yield* fs.stat(binaryPath);
  if (stat.type !== "File") {
    return yield* new BuildScriptError({ message: `${label}: not a file: ${binaryPath}` });
  }
  if (process.platform !== "win32") {
    yield* Effect.try({
      try: () => accessSync(binaryPath, constants.X_OK),
      catch: (cause) => new BuildScriptError({ message: `${label}: not executable`, cause }),
    });
  }
  yield* Effect.try({
    try: () => assertWorkspaceAgentArtifactTarget(binaryPath, target),
    catch: (cause) => new BuildScriptError({ message: `${label}: wrong target`, cause }),
  });
  const check = yield* Effect.sync(() =>
    spawnSync(binaryPath, ["--check"], { encoding: "utf8", timeout: 5_000 }),
  );
  if (check.status !== 0 || !check.stdout.startsWith("bigbud-remote-agent\t")) {
    return yield* new BuildScriptError({
      message: `${label}: --check failed for ${binaryPath}: ${check.stderr.trim()}`,
    });
  }
  yield* Effect.tryPromise({
    try: () => verifyWorkspaceAgentHandshake(binaryPath),
    catch: (cause) => new BuildScriptError({ message: `${label}: handshake failed`, cause }),
  });
});

export function workspaceAgentBuildPlan(input: {
  readonly repoRoot: string;
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
}) {
  const target = findDesktopWorkspaceAgentTarget(input.platform, input.arch);
  if (!target) {
    throw new Error(`Unsupported workspace watcher target: ${input.platform}/${input.arch}`);
  }
  const native =
    target.platform === (input.hostPlatform ?? process.platform) &&
    target.arch === (input.hostArch ?? process.arch);
  const cargoArgs = ["build", "--locked", "--release", "--package", "bigbud-remote-agent"];
  if (!native) cargoArgs.push("--target", target.rustTarget);
  const source = native
    ? join(input.repoRoot, "target", "release", targetBinaryName(target.platform))
    : join(
        input.repoRoot,
        "target",
        target.rustTarget,
        "release",
        targetBinaryName(target.platform),
      );
  return { target, cargoArgs, source };
}

export const stagePackagedWorkspaceAgent = Effect.fn("stagePackagedWorkspaceAgent")(
  function* (input: {
    readonly repoRoot: string;
    readonly stageServerDir: string;
    readonly platform: typeof BuildPlatform.Type;
    readonly arch: typeof BuildArch.Type;
    readonly skipBuild: boolean;
    readonly verbose: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const plan = yield* Effect.try({
      try: () => workspaceAgentBuildPlan(input),
      catch: (cause) =>
        new BuildScriptError({ message: "Unsupported desktop workspace watcher target", cause }),
    });
    if (!input.skipBuild) {
      yield* Effect.log("[desktop-artifact] Building native workspace watcher agent...");
      yield* runCommand(
        ChildProcess.make("cargo", plan.cargoArgs, {
          cwd: input.repoRoot,
          ...commandOutputOptions(input.verbose),
        }),
      );
    }

    const name = targetBinaryName(plan.target.platform);
    const destination = path.join(input.stageServerDir, "workspace-agent", "bin", name);
    yield* assertWorkspaceAgentBinary(plan.source, "Workspace agent staging failed", plan.target);
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fs.copyFile(plan.source, destination);
    if (input.platform !== "win") yield* fs.chmod(destination, 0o755);
    yield* assertWorkspaceAgentBinary(
      destination,
      "Staged workspace agent verification failed",
      plan.target,
    );
    return destination;
  },
);
