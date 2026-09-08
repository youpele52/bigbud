import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  assertWorkspaceAgentArtifactTarget,
  findWorkspaceAgentTarget,
  type WorkspaceAgentTarget,
  WORKSPACE_AGENT_TARGETS,
  workspaceAgentBinaryName,
} from "../../../scripts/lib/workspace-agent-target.ts";

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

export function stageHostServerWorkspaceAgent(repoRoot: string, serverDir: string): string {
  const supported = findWorkspaceAgentTarget(process.platform, process.arch);
  if (!supported) {
    throw new Error(`Unsupported workspace watcher target: ${process.platform}/${process.arch}`);
  }
  const build = spawnSync(
    "cargo",
    ["build", "--locked", "--release", "--package", "bigbud-remote-agent"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (build.status !== 0) throw new Error("Failed to build the native workspace watcher agent.");

  const source = join(repoRoot, "target", "release", workspaceAgentBinaryName(supported.platform));
  assertServerWorkspaceAgent(source, supported);
  const destination = serverWorkspaceAgentPath(serverDir, supported.platform, supported.arch);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  if (process.platform !== "win32") chmodSync(destination, 0o755);
  assertServerWorkspaceAgent(destination, supported);
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
