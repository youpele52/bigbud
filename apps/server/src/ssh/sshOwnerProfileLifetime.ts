import type { SshOwnerProfile } from "./sshOwnerProductionArtifact.ts";

/**
 * One rule for owner lifetime by profile kind. A surviving owner may outlive its
 * launcher and is detached on shutdown; a non-surviving one (`desktop-dev`) is
 * reaped on shutdown AND started with `--launcher-lifetime` plus a socket at FD 3,
 * so it retires on its own when the launcher is gone without shutting it down.
 *
 * @module sshOwnerProfileLifetime
 */
export const sshOwnerProfileSurvivesLauncher = (profile: SshOwnerProfile): boolean =>
  profile !== "desktop-dev";

/** The kind named by a `bbso1:<kind>:<hex>` startup binding is tied to its launcher. */
export const sshOwnerBindingTiedToLauncher = (bindingText: string): boolean => {
  const kind = bindingText.split(":")[1];
  return kind === "desktop-dev" && !sshOwnerProfileSurvivesLauncher(kind);
};
