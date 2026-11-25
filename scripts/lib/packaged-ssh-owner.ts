import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync } from "node:fs";

import { type DesktopBuildPlatform } from "./packaged-workspace-agent.ts";
import {
  assertNativeArtifactTarget,
  findDesktopWorkspaceAgentTarget,
  type WorkspaceAgentTarget,
} from "./workspace-agent-target.ts";

export const SSH_OWNER_BINARY_NAME = "bigbud-ssh-owner";

type SshOwnerDesktopTarget = Extract<
  WorkspaceAgentTarget,
  { platform: "darwin"; arch: "arm64" } | { platform: "win32"; arch: "x64" }
>;

export function findDesktopSshOwnerTarget(
  platform: DesktopBuildPlatform,
  arch: string,
): SshOwnerDesktopTarget | undefined {
  const target = findDesktopWorkspaceAgentTarget(platform, arch);
  if (
    (target?.platform === "darwin" && target.arch === "arm64") ||
    (target?.platform === "win32" && target.arch === "x64")
  ) {
    return target;
  }
  return undefined;
}

export function sshOwnerServerRelativePath(platform: SshOwnerDesktopTarget["platform"]): string {
  return `ssh-owner/bin/${SSH_OWNER_BINARY_NAME}${platform === "win32" ? ".exe" : ""}`;
}

export function assertSshOwnerBinary(binaryPath: string, target: SshOwnerDesktopTarget): void {
  if (!lstatSync(binaryPath).isFile()) throw new Error(`SSH owner is not a file: ${binaryPath}`);
  if (target.platform === "darwin") accessSync(binaryPath, constants.X_OK);
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
