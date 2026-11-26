import { readFile } from "node:fs/promises";

/**
 * Contract between `bun dev:desktop`'s launcher chain and the dev Electron app. Dev-only: packaged
 * builds never read these values and keep their own exit codes.
 */

/** Set by `scripts/dev-runner.ts` (dev:desktop only) so the launcher can end the whole session. */
export const DEV_RUNNER_PID_ENV = "BIGBUD_DEV_RUNNER_PID";

export const DEV_SSH_OWNER_PROFILE_PREFIX = "bigbud-ssh-owner-dev-";
export const DEV_SSH_OWNER_GUARDED_ENV = "BIGBUD_SSH_OWNER_GUARDED_DEV";
export const DEV_SSH_OWNER_GUARDED_MARKER = "ssh-owner-guarded-dev";
export const DEV_SSH_OWNER_GUARDED_APPROVAL = "approved-disposable";

/** Only the disposable host families qualified for the native guarded write recipe. */
export async function supportsDevSshOwnerGuardedFixture(): Promise<boolean> {
  if (process.platform === "darwin") return true;
  if (process.platform !== "linux" || process.arch !== "arm64") return false;
  try {
    return /^ID=(?:debian|"debian"|'debian')$/m.test(await readFile("/etc/os-release", "utf8"));
  } catch {
    return false;
  }
}
export const DEV_SSH_OWNER_RETAIN_ENV = "BIGBUD_SSH_OWNER_RETAIN";
export const DEV_SSH_OWNER_RETAIN_MARKER = "ssh-owner-retain";
export const DEV_SSH_OWNER_LINUX_JUMP_ENV = "BIGBUD_SSH_OWNER_LINUX_JUMP";
export const DEV_SSH_OWNER_LINUX_JUMP_MARKER = "ssh-owner-linux-jump";
export const DEV_SSH_OWNER_WINDOWS_FIXTURE_ENV = "BIGBUD_SSH_OWNER_WINDOWS_FIXTURE";
export const DEV_SSH_OWNER_WINDOWS_FIXTURE_MARKER = "ssh-owner-windows-fixture.path";

const normalizeWindowsTemp = (value: string) =>
  value.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();

/** The caller may select only a newly allocated dev directory, never its regular profile. */
export function isDevSshOwnerProfile(profile: string, platform: string, tempDir: string): boolean {
  const match = /^(.*[/\\])bigbud-ssh-owner-dev-[a-zA-Z0-9]{6}$/.exec(profile);
  if (!match) return false;
  const parent = match[1]?.replace(/[\\/]+$/, "");
  if (!parent) return false;
  if (platform === "win32") {
    return (
      /^[A-Za-z]:[\\/]/.test(profile) &&
      normalizeWindowsTemp(parent) === normalizeWindowsTemp(tempDir)
    );
  }
  return (
    (platform === "darwin" || platform === "linux") &&
    (parent === "/tmp" || (platform === "darwin" && parent === "/private/tmp"))
  );
}

/**
 * Dev Electron exit codes the launcher (`apps/desktop/scripts/dev-electron.mjs`) interprets. Exit 0
 * is reserved for a user quit, which ends the dev session. The values are BSD `sysexits` codes,
 * which Electron itself never uses.
 */
/** Restart: relaunch under supervision instead of `app.relaunch()`. `EX_TEMPFAIL`. */
export const DEV_APP_RESTART_EXIT_CODE = 75;
/** Fatal startup error or uncaught main-process exception: stay idle until the next rebuild. */
export const DEV_APP_FATAL_EXIT_CODE = 70;
/** Another dev instance holds the single-instance lock: stay idle until the next rebuild. */
export const DEV_APP_DUPLICATE_INSTANCE_EXIT_CODE = 69;
