import { isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { isDevSshOwnerProfile } from "@bigbud/shared/DevLauncher";
import { SSH_OWNER_PRODUCTION_ACTIVATION } from "@bigbud/shared/SshOwnerActivation";

export function resolveDesktopSshOwnerDevProfile(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const profile = env.BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE;
  if (
    isPackaged ||
    !env.VITE_DEV_SERVER_URL ||
    env.BIGBUD_SSH_OWNER_NORMAL_DEV_READY !== "1" ||
    env.BIGBUD_SSH_OWNER !== "1" ||
    !isAbsolute(env.BIGBUD_SSH_OWNER_BIN ?? "") ||
    !profile ||
    !isDevSshOwnerProfile(profile, process.platform, tmpdir()) ||
    env.BIGBUD_HOME !== profile
  ) {
    return undefined;
  }
  return profile;
}

/**
 * Production owner path for a packaged desktop build. The server re-verifies
 * the artifact's native target and fails closed with `sshOwnerUnavailable`, so
 * this is a locator, not a trust decision. Off while the build-time activation
 * constant is off, which keeps today's packaged environment unchanged.
 */
export function resolveDesktopSshOwnerProductionBinary(input: {
  readonly isPackaged: boolean;
  readonly packagedBinary: string | null;
  readonly activation?: boolean;
}): string | undefined {
  const activated = input.activation ?? SSH_OWNER_PRODUCTION_ACTIVATION;
  return activated && input.isPackaged ? (input.packagedBinary ?? undefined) : undefined;
}
