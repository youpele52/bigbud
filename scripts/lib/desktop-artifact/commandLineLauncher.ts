import { join } from "node:path";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/unstable/process";
import {
  assertWorkspaceAgentArtifactTarget,
  findDesktopWorkspaceAgentTarget,
} from "../workspace-agent-target.ts";
import {
  BuildScriptError,
  commandOutputOptions,
  runCommand,
  type BuildArch,
  type BuildPlatform,
} from "./shared.ts";

export function commandLineLauncherBuildPlan(input: {
  readonly repoRoot: string;
  readonly arch: typeof BuildArch.Type;
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
}) {
  const target = findDesktopWorkspaceAgentTarget("win", input.arch);
  if (!target) throw new Error(`Unsupported CLI launcher architecture: ${input.arch}`);
  const native =
    (input.hostPlatform ?? process.platform) === "win32" &&
    (input.hostArch ?? process.arch) === target.arch;
  const cargoArgs = ["build", "--locked", "--release", "--package", "bigbud-cli-launcher"];
  if (!native) cargoArgs.push("--target", target.rustTarget);
  const source = native
    ? join(input.repoRoot, "target", "release", "bigbud-cli-launcher.exe")
    : join(input.repoRoot, "target", target.rustTarget, "release", "bigbud-cli-launcher.exe");
  return { target, cargoArgs, source };
}

export const stagePackagedCommandLineLauncher = Effect.fn("stagePackagedCommandLineLauncher")(
  function* (input: {
    readonly repoRoot: string;
    readonly stageServerDir: string;
    readonly platform: typeof BuildPlatform.Type;
    readonly arch: typeof BuildArch.Type;
    readonly skipBuild: boolean;
    readonly verbose: boolean;
  }) {
    if (input.platform !== "win") return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const plan = yield* Effect.try({
      try: () => commandLineLauncherBuildPlan(input),
      catch: (cause) => new BuildScriptError({ message: "Unsupported CLI launcher target", cause }),
    });
    if (!input.skipBuild)
      yield* runCommand(
        ChildProcess.make("cargo", plan.cargoArgs, {
          cwd: input.repoRoot,
          ...commandOutputOptions(input.verbose),
        }),
      );
    yield* Effect.try({
      try: () => assertWorkspaceAgentArtifactTarget(plan.source, plan.target),
      catch: (cause) =>
        new BuildScriptError({
          message: "Native CLI launcher is missing or has the wrong target",
          cause,
        }),
    });
    const destination = path.join(
      input.stageServerDir,
      "cli-launcher",
      "bin",
      "bigbud-cli-launcher.exe",
    );
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fs.copyFile(plan.source, destination);
    yield* Effect.try({
      try: () => assertWorkspaceAgentArtifactTarget(destination, plan.target),
      catch: (cause) =>
        new BuildScriptError({ message: "Staged CLI launcher target verification failed", cause }),
    });
  },
);
