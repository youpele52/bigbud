import path from "node:path";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { TerminalShellProfile } from "@bigbud/contracts/workspace/terminalShell.ts";
import { LocalShellDiscoveryError } from "../Services/LocalShellProfiles";
import { LOCAL_SHELL_HOST, shellKind, shellProfileId } from "./ShellProfiles.identity";
import { unixShellCandidates } from "./ShellProfiles.candidates";

export interface LocalShellDiscoveryOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

/** Fixed trusted locations only: inventory never executes a workspace PATH entry or profile. */
export function localShellCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  if (platform === "win32") {
    const candidates: string[] = [];
    // Stable PS7, not preview/version wildcards or WindowsApps execution aliases.
    for (const root of [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (root && path.win32.isAbsolute(root)) {
        candidates.push(path.win32.join(root, "PowerShell", "7", "pwsh.exe"));
      }
    }
    const systemRoot = env.SystemRoot;
    if (systemRoot && path.win32.isAbsolute(systemRoot)) {
      candidates.push(
        path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        path.win32.join(systemRoot, "System32", "cmd.exe"),
      );
    }
    // Preserve custom absolute ComSpec installations without invoking a relative PATH alias.
    if (env.ComSpec && path.win32.isAbsolute(env.ComSpec)) candidates.push(env.ComSpec);
    return [...new Set(candidates)];
  }
  return unixShellCandidates();
}

const displayNames = {
  zsh: "zsh",
  bash: "Bash",
  fish: "fish",
  pwsh: "PowerShell 7",
  "windows-powershell": "Windows PowerShell",
  cmd: "Command Prompt",
  other: "Shell",
} as const;

/** Local inventory only. Remote and WSL discovery must run on their own execution host. */
export const discoverLocalShellProfiles = Effect.fn("discoverLocalShellProfiles")(function* (
  options: LocalShellDiscoveryOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const candidates = localShellCandidates(platform, env);
  const profiles: TerminalShellProfile[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const executable = yield* fs.realPath(candidate).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
    );
    if (executable === null) continue;
    const info = yield* fs.stat(executable);
    if (info.type !== "File") continue;
    // Inventory must establish executability, not merely file existence.
    const executableAccess = yield* Effect.tryPromise(() =>
      access(executable, platform === "win32" ? constants.F_OK : constants.X_OK),
    ).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) =>
          error.cause instanceof Error &&
          "code" in error.cause &&
          ["EACCES", "ENOENT"].includes(String(error.cause.code)),
        () => Effect.succeed(false),
      ),
    );
    if (!executableAccess) continue;
    const kind = shellKind(candidate, platform);
    const args = kind === "zsh" ? ["-o", "nopromptsp"] : [];
    const profileId = shellProfileId(LOCAL_SHELL_HOST, executable, args, platform);
    if (seen.has(profileId)) continue;
    const profile = yield* Schema.decodeUnknownEffect(TerminalShellProfile)({
      profileId,
      host: LOCAL_SHELL_HOST,
      kind,
      displayName: displayNames[kind],
      executable,
      args,
      platform: ["win32", "darwin", "linux"].includes(platform) ? platform : "other",
      availability: "available",
      integration: {
        status: "unavailable",
        reason: kind === "cmd" ? "unsupported-shell" : "not-qualified",
      },
    });
    seen.add(profileId);
    profiles.push(profile);
  }
  return profiles;
});

/** A failed probe is not an empty inventory and must not drive fresh-default ranking. */
export const probeLocalShellProfiles = Effect.fn("probeLocalShellProfiles")(function* (
  options: LocalShellDiscoveryOptions = {},
) {
  return yield* discoverLocalShellProfiles(options).pipe(
    Effect.mapError(() => new LocalShellDiscoveryError({ reason: "probe-failed" })),
    Effect.timeoutOrElse({
      duration: "3 seconds",
      orElse: () => Effect.fail(new LocalShellDiscoveryError({ reason: "timed-out" })),
    }),
  );
});
