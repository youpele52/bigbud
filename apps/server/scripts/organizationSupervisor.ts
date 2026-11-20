import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertWorkspaceAgentArtifactTarget } from "../../../scripts/lib/workspace-agent-target.ts";
import {
  nativeReleaseBuildPlan,
  requireNativeBuildOutput,
  resolveServerNativeTarget,
} from "../../../scripts/lib/native-release-build.ts";
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
/** Same target rule as `stageHostServerWorkspaceAgent`: host, or the desktop cross-build arch. */
export async function stageHostOrganizationSupervisor(
  repoRoot: string,
  serverDir: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { target, native } = resolveServerNativeTarget(environment);
  const plan = nativeReleaseBuildPlan({
    repoRoot,
    packageName: "bigbud-desktop-supervisor",
    binaryName: "bigbud-desktop-supervisor" + (target.platform === "win32" ? ".exe" : ""),
    target,
    native,
  });
  const result = spawnSync("cargo", plan.cargoArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) throw new Error("Failed to build the native organisation supervisor");
  requireNativeBuildOutput(plan.source, "Native organisation supervisor");
  assertWorkspaceAgentArtifactTarget(plan.source, target);
  const destination = serverOrganizationSupervisorPath(serverDir, target.platform, target.arch);
  copy(plan.source, destination, target.platform);
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
