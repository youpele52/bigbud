import * as OS from "node:os";
import { Effect, Path } from "effect";
import {
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLaunchctl,
  readPathFromLoginShell,
} from "@bigbud/shared/shell";

export function fixPath(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    readPath?: typeof readPathFromLoginShell;
    readLaunchctlPath?: typeof readPathFromLaunchctl;
    logWarning?: (message: string) => void;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return;

  const env = options.env ?? process.env;
  const warn = options.logWarning ?? (() => {});
  const candidates = listLoginShellCandidates(platform, env.SHELL);

  for (const shell of candidates) {
    try {
      const shellPath = (options.readPath ?? readPathFromLoginShell)(shell);
      if (shellPath) {
        env.PATH = mergePathEntries(shellPath, env.PATH, platform);
        return;
      }
    } catch (error) {
      warn(
        `Failed to read PATH from login shell '${shell}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (platform === "darwin") {
    try {
      const launchctlPath = (options.readLaunchctlPath ?? readPathFromLaunchctl)();
      if (launchctlPath) {
        env.PATH = mergePathEntries(launchctlPath, env.PATH, platform);
      }
    } catch (error) {
      warn(
        `Failed to read PATH from launchctl: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(OS.homedir(), input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(OS.homedir(), ".bigbud");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
