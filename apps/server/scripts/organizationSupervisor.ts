import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  assertWorkspaceAgentArtifactTarget,
  findWorkspaceAgentTarget,
} from "../../../scripts/lib/workspace-agent-target.ts";
import { smokeTestThreadOrganizationBinary } from "../../../scripts/lib/thread-organization-smoke.ts";
import { SERVER_WORKSPACE_AGENT_TARGETS } from "./workspaceAgent.ts";

export function serverOrganizationSupervisorPath(
  serverDir: string,
  platform: string,
  arch: string,
): string {
  return join(
    serverDir,
    "dist",
    "organization-supervisor",
    `${platform}-${arch}`,
    "bigbud-desktop-supervisor" + (platform === "win32" ? ".exe" : ""),
  );
}
const copy = (source: string, destination: string, platform: string) => {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  if (platform !== "win32") chmodSync(destination, 0o755);
};
export async function stageHostOrganizationSupervisor(
  repoRoot: string,
  serverDir: string,
): Promise<void> {
  const target = findWorkspaceAgentTarget(process.platform, process.arch);
  if (!target) throw new Error("Unsupported native organisation target");
  const result = spawnSync(
    "cargo",
    ["build", "--locked", "--release", "--package", "bigbud-desktop-supervisor"],
    { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.status !== 0) throw new Error("Failed to build the native organisation supervisor");
  const source = join(
    repoRoot,
    "target",
    "release",
    "bigbud-desktop-supervisor" + (process.platform === "win32" ? ".exe" : ""),
  );
  assertWorkspaceAgentArtifactTarget(source, target);
  const destination = serverOrganizationSupervisorPath(serverDir, target.platform, target.arch);
  copy(source, destination, target.platform);
  await smokeTestThreadOrganizationBinary(destination);
}
export function stageReleasedOrganizationSupervisors(repoRoot: string, serverDir: string): void {
  for (const target of SERVER_WORKSPACE_AGENT_TARGETS) {
    const source = join(
      repoRoot,
      "release-assets",
      `server-organization-supervisor-${target.platform}-${target.arch}` +
        (target.platform === "win32" ? ".exe" : ""),
    );
    assertWorkspaceAgentArtifactTarget(source, target);
    copy(
      source,
      serverOrganizationSupervisorPath(serverDir, target.platform, target.arch),
      target.platform,
    );
  }
}
export function assertCompleteOrganizationSupervisorSet(serverDir: string): void {
  for (const target of SERVER_WORKSPACE_AGENT_TARGETS)
    assertWorkspaceAgentArtifactTarget(
      serverOrganizationSupervisorPath(serverDir, target.platform, target.arch),
      target,
    );
}
