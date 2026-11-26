import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  nativeReleaseBuildPlan,
  requireNativeBuildOutput,
  resolveServerNativeTarget,
} from "../../../scripts/lib/native-release-build.ts";
import {
  assertSshOwnerBinary,
  isSshOwnerReleaseTarget,
  SSH_OWNER_BINARY_NAME,
  SSH_OWNER_RELEASE_TARGETS,
  type SshOwnerDesktopTarget,
  sshOwnerBinaryName,
  sshOwnerReleaseAssetName,
  verifyInactiveSshOwner,
} from "../../../scripts/lib/packaged-ssh-owner.ts";

/** `dist/ssh-owner/<platform>-<arch>/bigbud-ssh-owner[.exe]`, the layout `sshOwnerExecutable.ts` verifies. */
export function serverSshOwnerPath(serverDir: string, target: SshOwnerDesktopTarget): string {
  return join(
    serverDir,
    "dist",
    "ssh-owner",
    `${target.platform}-${target.arch}`,
    sshOwnerBinaryName(target.platform),
  );
}

/**
 * Builds and stages the SSH owner for the host (or `BIGBUD_SERVER_NATIVE_TARGET_ARCH`) when it is
 * a U4 standalone cell. Windows arm64 has no owner in v1, so it is skipped rather than failed.
 */
export function stageHostServerSshOwner(
  repoRoot: string,
  serverDir: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const { target, native } = resolveServerNativeTarget(environment);
  if (!isSshOwnerReleaseTarget(target)) return undefined;
  const plan = nativeReleaseBuildPlan({
    repoRoot,
    packageName: SSH_OWNER_BINARY_NAME,
    binaryName: sshOwnerBinaryName(target.platform),
    target,
    native,
  });
  const build = spawnSync("cargo", plan.cargoArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (build.status !== 0) throw new Error("Failed to build the native SSH owner.");

  requireNativeBuildOutput(plan.source, "SSH owner");
  assertSshOwnerBinary(plan.source, target);
  const destination = serverSshOwnerPath(serverDir, target);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(plan.source, destination);
  if (target.platform !== "win32") chmodSync(destination, 0o755);
  assertSshOwnerBinary(destination, target);
  // A cross-built architecture may not run on this host; its header check above still applies.
  if (native) verifyInactiveSshOwner(destination, target);
  return destination;
}

export function stageReleasedServerSshOwners(repoRoot: string, serverDir: string): void {
  for (const target of SSH_OWNER_RELEASE_TARGETS) {
    const source = join(repoRoot, "release-assets", sshOwnerReleaseAssetName(target));
    if (!statSync(source).isFile()) throw new Error(`Missing standalone SSH owner: ${source}`);
    const destination = serverSshOwnerPath(serverDir, target);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    if (target.platform !== "win32") chmodSync(destination, 0o755);
  }
}

/** Every U4 N cell is present with the right native header; no Windows arm64 owner is shipped. */
export function assertCompleteServerSshOwnerSet(serverDir: string): void {
  for (const target of SSH_OWNER_RELEASE_TARGETS) {
    assertSshOwnerBinary(serverSshOwnerPath(serverDir, target), target);
  }
}
