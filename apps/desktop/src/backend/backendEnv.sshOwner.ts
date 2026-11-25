import { isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { isDevSshOwnerProfile } from "@bigbud/shared/DevLauncher";

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
