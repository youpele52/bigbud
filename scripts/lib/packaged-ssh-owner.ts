import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync } from "node:fs";

// Relative source import: release jobs run this with plain `node` before any `bun install`.
import {
  isSshOwnerReleaseTarget,
  type SshOwnerTarget,
} from "../../packages/shared/src/SshOwnerTargets.ts";
import { type DesktopBuildPlatform } from "./packaged-workspace-agent.ts";
import {
  assertNativeArtifactTarget,
  findDesktopWorkspaceAgentTarget,
  WORKSPACE_AGENT_TARGETS,
  type WorkspaceAgentTarget,
} from "./workspace-agent-target.ts";

export const SSH_OWNER_BINARY_NAME = "bigbud-ssh-owner";

/** U4 native owner cells; the list itself lives in `@bigbud/shared/SshOwnerTargets`. */
export type SshOwnerDesktopTarget = Extract<WorkspaceAgentTarget, SshOwnerTarget>;

export { isSshOwnerReleaseTarget };

export const SSH_OWNER_RELEASE_TARGETS: readonly SshOwnerDesktopTarget[] =
  WORKSPACE_AGENT_TARGETS.filter(isSshOwnerReleaseTarget);

export function findDesktopSshOwnerTarget(
  platform: DesktopBuildPlatform,
  arch: string,
): SshOwnerDesktopTarget | undefined {
  const target = findDesktopWorkspaceAgentTarget(platform, arch);
  return isSshOwnerReleaseTarget(target) ? target : undefined;
}

export function sshOwnerBinaryName(platform: SshOwnerDesktopTarget["platform"]): string {
  return `${SSH_OWNER_BINARY_NAME}${platform === "win32" ? ".exe" : ""}`;
}

/** Release asset the standalone N package is assembled from (mirrors `server-workspace-agent-*`). */
export function sshOwnerReleaseAssetName(target: SshOwnerDesktopTarget): string {
  return `server-ssh-owner-${target.platform}-${target.arch}${target.platform === "win32" ? ".exe" : ""}`;
}

export function sshOwnerServerRelativePath(platform: SshOwnerDesktopTarget["platform"]): string {
  return `ssh-owner/bin/${sshOwnerBinaryName(platform)}`;
}

export function assertSshOwnerBinary(binaryPath: string, target: SshOwnerDesktopTarget): void {
  if (!lstatSync(binaryPath).isFile()) throw new Error(`SSH owner is not a file: ${binaryPath}`);
  if (target.platform !== "win32") accessSync(binaryPath, constants.X_OK);
  assertNativeArtifactTarget(binaryPath, target, "SSH owner");
}

/** Exercise the loader and the owner's early fail-closed path, without a profile or SSH target. */
export function verifyInactiveSshOwner(binaryPath: string, target: SshOwnerDesktopTarget): void {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith("BIGBUD_SSH_OWNER"),
    ),
  );
  const result = spawnSync(binaryPath, [], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  if (result.error)
    throw new Error(`Could not run SSH owner: ${binaryPath}`, { cause: result.error });
  const expected =
    target.platform === "win32"
      ? "Windows picker proof owner stopped"
      : "S1 picker proof owner stopped";
  if (result.status !== 1 || result.stdout !== "" || result.stderr.trim() !== expected) {
    throw new Error(`SSH owner did not reject inactive startup as expected: ${binaryPath}`);
  }
}
