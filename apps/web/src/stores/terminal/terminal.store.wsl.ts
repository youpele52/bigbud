import { isWslDistributionName, wslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import type { TerminalStateStoreState } from "./terminal.store.types";

/** Selection is a new-manual-terminal preference, never a mutable running-session target. */
export function resolveManualTerminalTarget(
  workspaceTarget: string | undefined,
  distribution: string | undefined,
): string | undefined {
  if ((workspaceTarget ?? "local") !== "local" || distribution === undefined)
    return workspaceTarget;
  // Corrupt saved selections must fail closed at the server, not silently launch locally.
  return typeof distribution === "string" && isWslDistributionName(distribution)
    ? wslTerminalTargetId(distribution)
    : "wsl:";
}

export function terminalWslSelectionPatch(
  state: Pick<TerminalStateStoreState, "terminalWslDistributionByThreadId">,
  threadId: string,
  distribution: string | null,
): Pick<TerminalStateStoreState, "terminalWslDistributionByThreadId"> {
  if (distribution !== null && !isWslDistributionName(distribution))
    throw new Error("Invalid WSL distribution selection.");
  const next = { ...state.terminalWslDistributionByThreadId };
  if (distribution === null) delete next[threadId];
  else next[threadId] = distribution;
  return { terminalWslDistributionByThreadId: next };
}

export function removeOrphanedWslSelections(
  state: Pick<TerminalStateStoreState, "terminalWslDistributionByThreadId">,
  activeThreadIds: ReadonlySet<string>,
): Pick<TerminalStateStoreState, "terminalWslDistributionByThreadId"> {
  const entries = Object.entries(state.terminalWslDistributionByThreadId);
  if (entries.every(([id]) => activeThreadIds.has(id)))
    return { terminalWslDistributionByThreadId: state.terminalWslDistributionByThreadId };
  return {
    terminalWslDistributionByThreadId: Object.fromEntries(
      entries.filter(([id]) => activeThreadIds.has(id)),
    ),
  };
}
