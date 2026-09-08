import { accessSync, constants } from "node:fs";
import { join } from "node:path";

import { Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/unstable/process";

import {
  smokeTestDesktopSupervisorBinary,
  smokeTestDesktopSupervisorRecovery,
} from "../desktop-supervisor-smoke.ts";
import {
  verifyDesktopSupervisorArtifactEvidence,
  writeDesktopSupervisorArtifactEvidence,
} from "./desktopSupervisorEvidence.ts";
import {
  assertWorkspaceAgentArtifactTarget,
  findDesktopWorkspaceAgentTarget,
  type WorkspaceAgentTarget,
} from "../workspace-agent-target.ts";
import {
  BuildArch,
  BuildScriptError,
  commandOutputOptions,
  runCommand,
  type BuildPlatform,
} from "./shared.ts";

export function desktopSupervisorBinaryName(platform: typeof BuildPlatform.Type): string {
  return platform === "win" ? "bigbud-desktop-supervisor.exe" : "bigbud-desktop-supervisor";
}

export function packagedDesktopSupervisorPath(
  serverDir: string,
  platform: typeof BuildPlatform.Type,
): string {
  return join(serverDir, "delivery-supervisor", "bin", desktopSupervisorBinaryName(platform));
}

export const assertDesktopSupervisorBinary = Effect.fn("assertDesktopSupervisorBinary")(function* (
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
  yield* Effect.tryPromise({
    try: async () => {
      await smokeTestDesktopSupervisorBinary(binaryPath);
      await smokeTestDesktopSupervisorRecovery(binaryPath);
    },
    catch: (cause) => new BuildScriptError({ message: `${label}: handshake failed`, cause }),
  });
});

export const assertDesktopSupervisorEvidence = Effect.fn("assertDesktopSupervisorEvidence")(
  function* (binaryPath: string, label: string) {
    yield* Effect.try({
      try: () => verifyDesktopSupervisorArtifactEvidence(binaryPath),
      catch: (cause) => new BuildScriptError({ message: `${label}: invalid evidence`, cause }),
    });
  },
);

export function desktopSupervisorBuildPlan(input: {
  readonly repoRoot: string;
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
}) {
  const target = findDesktopWorkspaceAgentTarget(input.platform, input.arch);
  if (!target)
    throw new Error(`Unsupported desktop supervisor target: ${input.platform}/${input.arch}`);
  const native =
    target.platform === (input.hostPlatform ?? process.platform) &&
    target.arch === (input.hostArch ?? process.arch);
  const cargoArgs = ["build", "--locked", "--release", "--package", "bigbud-desktop-supervisor"];
  if (!native) cargoArgs.push("--target", target.rustTarget);
  const name = desktopSupervisorBinaryName(input.platform);
  const source = native
    ? join(input.repoRoot, "target", "release", name)
    : join(input.repoRoot, "target", target.rustTarget, "release", name);
  return { target, cargoArgs, source };
}

export const stagePackagedDesktopSupervisor = Effect.fn("stagePackagedDesktopSupervisor")(
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
      try: () => desktopSupervisorBuildPlan(input),
      catch: (cause) => new BuildScriptError({ message: "Unsupported supervisor target", cause }),
    });
    if (!input.skipBuild) {
      yield* Effect.log("[desktop-artifact] Building native delivery supervisor...");
      yield* runCommand(
        ChildProcess.make("cargo", plan.cargoArgs, {
          cwd: input.repoRoot,
          ...commandOutputOptions(input.verbose),
        }),
      );
    }
    const destination = packagedDesktopSupervisorPath(input.stageServerDir, input.platform);
    yield* assertDesktopSupervisorBinary(plan.source, "Supervisor staging failed", plan.target);
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
    yield* fs.copyFile(plan.source, destination);
    if (input.platform !== "win") yield* fs.chmod(destination, 0o755);
    yield* assertDesktopSupervisorBinary(
      destination,
      "Staged supervisor verification failed",
      plan.target,
    );
    yield* Effect.try({
      try: () =>
        writeDesktopSupervisorArtifactEvidence({
          repoRoot: input.repoRoot,
          binaryPath: destination,
          targetTriple: plan.target.rustTarget,
        }),
      catch: (cause) =>
        new BuildScriptError({ message: "Supervisor artifact evidence failed", cause }),
    });
    yield* assertDesktopSupervisorEvidence(destination, "Staged supervisor verification failed");
    return destination;
  },
);
