import { createHash } from "node:crypto";
import path from "node:path";
import type {
  ShellHostScope,
  TerminalShellKind,
  TerminalShellProfile,
} from "@bigbud/contracts/workspace/terminalShell.ts";

export const LOCAL_SHELL_HOST = { kind: "local", hostId: "local" } as const;

/** Canonicalize for identity only; never rewrite the executable passed to spawn. */
export function shellExecutableIdentity(executable: string, platform: string): string {
  return platform === "win32"
    ? path.win32.normalize(executable).replaceAll("\\", "/").toLowerCase()
    : executable;
}

export function shellProfileId(
  host: ShellHostScope,
  executable: string,
  args: readonly string[],
  platform: string,
): string {
  const identity = JSON.stringify([
    host.kind,
    host.hostId,
    host.kind === "wsl" ? [host.distribution, host.username] : null,
    shellExecutableIdentity(executable, platform),
    args,
  ]);
  return `shell:v1:${createHash("sha256").update(identity).digest("hex")}`;
}

export function shellKind(executable: string, platform: string): TerminalShellKind {
  const basename = (platform === "win32" ? path.win32 : path.posix)
    .basename(executable)
    .toLowerCase()
    .replace(/\.exe$/, "");
  switch (basename) {
    case "zsh":
    case "bash":
    case "fish":
    case "pwsh":
    case "cmd":
      return basename;
    case "powershell":
      return "windows-powershell";
    default:
      return "other";
  }
}

/** Ranking is a one-time fresh-install policy, not a continuously changing default. */
export function preferredFreshWindowsShell(
  profiles: readonly TerminalShellProfile[],
): TerminalShellProfile | undefined {
  for (const kind of ["pwsh", "windows-powershell", "cmd"] as const) {
    const matching = profiles
      .filter(
        (profile) =>
          profile.host.kind === "local" &&
          profile.host.hostId === LOCAL_SHELL_HOST.hostId &&
          profile.platform === "win32" &&
          profile.availability === "available" &&
          profile.kind === kind,
      )
      .toSorted((left, right) =>
        left.profileId < right.profileId ? -1 : left.profileId > right.profileId ? 1 : 0,
      );
    if (matching[0]) return matching[0];
  }
  return undefined;
}
