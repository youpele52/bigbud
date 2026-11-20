import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  assertWorkspaceAgentArtifactTarget,
  type WorkspaceAgentTarget,
  WORKSPACE_AGENT_TARGETS,
  workspaceAgentBinaryName,
} from "../../../scripts/lib/workspace-agent-target.ts";
import {
  nativeReleaseBuildPlan,
  requireNativeBuildOutput,
  resolveServerNativeTarget,
} from "../../../scripts/lib/native-release-build.ts";

export const SERVER_WORKSPACE_AGENT_TARGETS = WORKSPACE_AGENT_TARGETS;

export function serverWorkspaceAgentPath(
  serverDir: string,
  platform: NodeJS.Platform,
  arch: string,
): string {
  const name = workspaceAgentBinaryName(platform as "darwin" | "linux" | "win32");
  return join(serverDir, "dist", "workspace-agent", `${platform}-${arch}`, name);
}

export function assertServerWorkspaceAgent(path: string, target: WorkspaceAgentTarget): void {
  if (!statSync(path).isFile()) throw new Error(`Workspace watcher agent is not a file: ${path}`);
  if (target.platform !== "win32") accessSync(path, constants.X_OK);
  const result = spawnSync(path, ["--check"], { encoding: "utf8" });
  if (result.error) {
    // For example "Bad CPU type in executable" for x64 on Apple Silicon without Rosetta 2.
    throw new Error(
      `Workspace watcher agent ${target.platform}/${target.arch} could not run: ${result.error.message}`,
    );
  }
  const fields = result.stdout.trim().split("\t");
  if (
    result.status !== 0 ||
    fields[0] !== "bigbud-remote-agent" ||
    fields.at(-2) !== target.rustOs ||
    fields.at(-1) !== target.rustArch
  ) {
    throw new Error(
      `Workspace watcher agent identity mismatch for ${target.platform}/${target.arch}: ${result.stderr.trim()}`,
    );
  }
}

/**
 * Builds and stages the workspace watcher for the host, or for the architecture named by
 * `BIGBUD_SERVER_NATIVE_TARGET_ARCH` on a desktop cross build (the host build is then skipped).
 */
export function stageHostServerWorkspaceAgent(
  repoRoot: string,
  serverDir: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const { target, native } = resolveServerNativeTarget(environment);
  const plan = nativeReleaseBuildPlan({
    repoRoot,
    packageName: "bigbud-remote-agent",
    binaryName: workspaceAgentBinaryName(target.platform),
    target,
    native,
  });
  const build = spawnSync("cargo", plan.cargoArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.status !== 0) throw new Error("Failed to build the native workspace watcher agent.");

  requireNativeBuildOutput(plan.source, "Workspace watcher agent");
  assertWorkspaceAgentArtifactTarget(plan.source, target);
  assertServerWorkspaceAgent(plan.source, target);
  const destination = serverWorkspaceAgentPath(serverDir, target.platform, target.arch);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(plan.source, destination);
  if (process.platform !== "win32") chmodSync(destination, 0o755);
  assertServerWorkspaceAgent(destination, target);
  return destination;
}

export function assertCompleteServerWorkspaceAgentSet(serverDir: string): void {
  for (const target of SERVER_WORKSPACE_AGENT_TARGETS) {
    assertWorkspaceAgentArtifactTarget(
      serverWorkspaceAgentPath(serverDir, target.platform, target.arch),
      target,
    );
  }
}

export function stageReleasedServerWorkspaceAgents(repoRoot: string, serverDir: string): void {
  for (const target of SERVER_WORKSPACE_AGENT_TARGETS) {
    const extension = target.platform === "win32" ? ".exe" : "";
    const source = join(
      repoRoot,
      "release-assets",
      `server-workspace-agent-${target.platform}-${target.arch}${extension}`,
    );
    if (!statSync(source).isFile()) {
      throw new Error(`Missing standalone server workspace watcher artifact: ${source}`);
    }
    const destination = serverWorkspaceAgentPath(serverDir, target.platform, target.arch);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    if (target.platform !== "win32") chmodSync(destination, 0o755);
  }
}
