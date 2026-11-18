import type { ShellHostScope, ShellSelection } from "@bigbud/contracts/workspace/terminalShell.ts";
import { readTerminalLaunch, type TerminalLaunchBinding } from "./terminalLaunchBinding";
import { wslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";

/** A request is not actual shell evidence. Persist only this launch context, never menu state. */
export interface TerminalProfileLaunch {
  shellSelection?: ShellSelection | undefined;
  /** New-pane target preference; never changes the source or supplies shell authority. */
  newExecutionTargetId?: string;
  host?: ShellHostScope | undefined;
  context?:
    | Pick<TerminalLaunchBinding, "cwd" | "worktreePath" | "executionTargetId" | "runtimeEnv">
    | undefined;
  requiresChoice?: boolean | undefined;
  /** Ephemeral inventory provenance; not included in captured/persisted requests. */
  source?: { terminalId: string; runtimeGeneration: string | undefined };
}
export const terminalProfileKey = (threadId: string, terminalId: string) =>
  JSON.stringify([threadId, terminalId]);

export function sameShellHost(a: ShellHostScope, b: ShellHostScope): boolean {
  return (
    a.kind === b.kind &&
    a.hostId === b.hostId &&
    (a.kind !== "wsl" ||
      (b.kind === "wsl" && a.distribution === b.distribution && a.username === b.username))
  );
}

export function captureTerminalProfileLaunch(
  threadId: string,
  sourceId: string,
  request?: TerminalProfileLaunch,
  pending?: TerminalProfileLaunch,
): TerminalProfileLaunch {
  let explicit = request;
  const recorded = readTerminalLaunch(threadId, sourceId);
  const source = recorded ?? pending?.context;
  const pendingIntent = !recorded?.updatedAt ? pending : undefined;
  const actual = recorded?.shellLaunchIdentity;
  if (explicit?.newExecutionTargetId !== undefined) {
    if (explicit.host || explicit.shellSelection || explicit.source)
      throw new Error("Choose the new terminal target separately from a shell profile.");
    if (!source)
      throw new Error("The source terminal context is unavailable. Reopen its workspace.");
    const sourceTarget = recorded?.wslIdentity
      ? wslTerminalTargetId(recorded.wslIdentity.distribution)
      : (source.executionTargetId ?? "local");
    if (sourceTarget !== explicit.newExecutionTargetId) {
      // A target choice requests that host's normal default, not the old host's profile.
      return {
        context: {
          cwd: source.cwd,
          worktreePath: source.worktreePath,
          executionTargetId: explicit.newExecutionTargetId,
          runtimeEnv: source.runtimeEnv ? { ...source.runtimeEnv } : undefined,
        },
      };
    }
    explicit = undefined;
  }
  if (explicit) {
    if (
      explicit.source &&
      (explicit.source.terminalId !== sourceId ||
        explicit.source.runtimeGeneration !== recorded?.runtimeGeneration)
    )
      throw new Error("The source terminal changed. Refresh its profile menu.");
    if (explicit.shellSelection?.kind === "legacy-auto") {
      if (!source)
        throw new Error(
          "The original terminal context is unavailable. Reopen its workspace before creating a terminal.",
        );
      // Explicit recovery uses retained context only, never caller-supplied target/defaults.
      return {
        shellSelection: { kind: "legacy-auto" },
        host:
          actual?.host ??
          recorded?.shellUnconfirmedLaunch?.requestedProfile.host ??
          pendingIntent?.host,
        context: {
          cwd: source.cwd,
          worktreePath: source.worktreePath,
          executionTargetId: recorded?.wslIdentity
            ? wslTerminalTargetId(recorded.wslIdentity.distribution)
            : source.executionTargetId,
          runtimeEnv: source.runtimeEnv ? { ...source.runtimeEnv } : undefined,
        },
      };
    }
    if (!recorded?.updatedAt || !explicit.host || explicit.shellSelection?.kind !== "profile")
      throw new Error(
        "The source terminal is not confirmed. Refresh its view before choosing a profile.",
      );
    if (actual && !sameShellHost(actual.host, explicit.host))
      throw new Error("The terminal host changed. Refresh the profile menu.");
  }
  if (!source) return { requiresChoice: true };
  // Inherit launch intent without presenting an unconfirmed request as actual shell identity.
  const requested = recorded?.shellUnconfirmedLaunch?.requestedProfile;
  const host = explicit?.host ?? actual?.host ?? requested?.host ?? pendingIntent?.host;
  const shellSelection =
    explicit?.shellSelection ??
    actual?.selection ??
    (requested
      ? { kind: "profile" as const, profileId: requested.profileId }
      : pendingIntent?.shellSelection);
  return {
    shellSelection,
    host,
    // Only current-pane inventories are accepted. The server validates cwd on that same host.
    context: {
      cwd: source.cwd,
      worktreePath: source.worktreePath,
      executionTargetId:
        host?.kind === "wsl"
          ? wslTerminalTargetId(host.distribution)
          : recorded?.wslIdentity
            ? wslTerminalTargetId(recorded?.wslIdentity.distribution)
            : source.executionTargetId,
      runtimeEnv: source.runtimeEnv,
    },
  };
}
