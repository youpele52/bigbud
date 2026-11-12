import path from "node:path";
import type {
  ShellHostScope,
  ShellLaunchIdentity,
  ShellSelection,
  TerminalShellProfile,
} from "@bigbud/contracts/workspace/terminalShell.ts";
import type { TerminalDropPathMode } from "@bigbud/contracts/workspace/terminal.ts";
import * as Data from "effect/Data";
import { shellProfileId } from "./ShellProfiles.identity";

export class ShellProfileResolutionError extends Data.TaggedError("ShellProfileResolutionError")<{
  readonly reason: "missing-profile" | "unavailable-profile" | "invalid-profile";
}> {}

export interface ResolvedShellProfileLaunch {
  readonly shell: string;
  readonly args: readonly string[];
  readonly platform: TerminalShellProfile["platform"];
  readonly dropPathMode: TerminalDropPathMode;
  readonly identity: ShellLaunchIdentity;
}

export function sameShellHost(left: ShellHostScope, right: ShellHostScope): boolean {
  if (left.kind !== right.kind || left.hostId !== right.hostId) return false;
  return (
    left.kind !== "wsl" ||
    (right.kind === "wsl" &&
      left.distribution === right.distribution &&
      left.username === right.username)
  );
}

function dropPathMode(profile: TerminalShellProfile): TerminalDropPathMode {
  if (profile.kind === "pwsh" || profile.kind === "windows-powershell") return "powershell";
  if (profile.platform !== "win32") return "posix";
  if (["bash", "zsh", "fish"].includes(profile.kind)) return "msys";
  return "cmd";
}

/**
 * Resolve against a freshly revalidated execution-host inventory, never a client snapshot.
 * Legacy selection returns null so the existing fallback chain stays unchanged. An explicit
 * selection yields exactly one executable/argv pair or fails; callers must never fall back.
 */
export function resolveShellProfileLaunch(input: {
  readonly host: ShellHostScope;
  readonly selection: ShellSelection;
  readonly profiles: readonly TerminalShellProfile[];
}): ResolvedShellProfileLaunch | null {
  if (input.selection.kind === "legacy-auto") return null;
  const selectedId = input.selection.profileId;
  const matches = input.profiles.filter(
    (profile) => profile.profileId === selectedId && sameShellHost(profile.host, input.host),
  );
  if (matches.length === 0) throw new ShellProfileResolutionError({ reason: "missing-profile" });
  if (matches.length !== 1) throw new ShellProfileResolutionError({ reason: "invalid-profile" });
  const profile = matches[0]!;
  if (profile.availability !== "available") {
    throw new ShellProfileResolutionError({ reason: "unavailable-profile" });
  }
  const pathApi = profile.platform === "win32" ? path.win32 : path.posix;
  if (
    !pathApi.isAbsolute(profile.executable) ||
    shellProfileId(profile.host, profile.executable, profile.args, profile.platform) !== selectedId
  ) {
    throw new ShellProfileResolutionError({ reason: "invalid-profile" });
  }
  return {
    shell: profile.executable,
    args: [...profile.args],
    platform: profile.platform,
    dropPathMode: dropPathMode(profile),
    identity: {
      host: profile.host,
      selection: { kind: "profile", profileId: selectedId },
      profileId: selectedId,
      kind: profile.kind,
      integration: profile.integration,
    },
  };
}
