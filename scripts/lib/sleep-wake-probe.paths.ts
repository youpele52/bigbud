import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { ProbeBuild } from "./sleep-wake-probe.types.ts";

/** Release tracks from `packages/shared/src/releaseChannel.ts`. */
export const PROBE_CHANNELS = ["stable", "beta", "preview", "nightly"] as const;
export type ProbeChannel = (typeof PROBE_CHANNELS)[number];

/** Stable keeps a pre-rename Chromium profile when it exists; prerelease channels never do. */
const STABLE_LEGACY_USER_DATA_DIR = "T3 Code (Alpha)";

export function isProbeChannel(value: string): value is ProbeChannel {
  return (PROBE_CHANNELS as ReadonlyArray<string>).includes(value);
}

/**
 * bigbud's state folder. `bun dev:desktop` uses `~/.bigbud/dev`. The packaged app uses
 * `~/.bigbud/userdata`, or `~/.bigbud/channels/<channel>/userdata` for prerelease
 * channels (`desktopReleaseIdentity.ts` `baseDirSuffix`).
 */
export function defaultStateDir(build: ProbeBuild, channel: ProbeChannel = "stable"): string {
  const base = process.env.BIGBUD_HOME?.trim() || path.join(homedir(), ".bigbud");
  if (build === "dev") return path.join(base, "dev");
  return channel === "stable"
    ? path.join(base, "userdata")
    : path.join(base, "channels", channel, "userdata");
}

/** Mirrors `resolveUserDataPath` in `apps/desktop/src/main.appIdentity.ts`. */
export function packagedUserDataPath(
  channel: ProbeChannel,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  exists: (candidate: string) => boolean = existsSync,
): string {
  const appDataBase =
    platform === "win32"
      ? env.APPDATA || path.join(home, "AppData", "Roaming")
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : env.XDG_CONFIG_HOME || path.join(home, ".config");
  if (channel === "stable") {
    const legacy = path.join(appDataBase, STABLE_LEGACY_USER_DATA_DIR);
    if (exists(legacy)) return legacy;
  }
  return path.join(appDataBase, channel === "stable" ? "bigbud" : `bigbud-${channel}`);
}

/**
 * The packaged desktop writes `desktop-main.log` under Electron `userData/logs`
 * (`resolveDesktopLogDir`), not under bigbud's state folder. Dev writes no desktop log.
 */
export function defaultDesktopLogPath(build: ProbeBuild, channel: ProbeChannel): string | null {
  if (build === "dev") return null;
  return path.join(packagedUserDataPath(channel), "logs", "desktop-main.log");
}

export function traceFilePath(stateDir: string): string {
  return path.join(stateDir, "logs", "server.trace.ndjson");
}
