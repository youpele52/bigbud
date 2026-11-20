import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { readTerminalLaunch, recordTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { terminalProfileKey } from "../../lib/terminalProfileLaunch";
import { useTerminalStateStore } from "../../stores/terminal/terminal.store";

/** Accepted snapshots reconcile persisted requests without storing actual metadata in UI state. */
export function recordTerminalProfileSnapshot(snapshot: TerminalSessionSnapshot): boolean {
  if (!recordTerminalLaunch(snapshot)) return false;
  useTerminalStateStore.getState().hydrateTerminalAgentFromSnapshot(snapshot);
  return true;
}

export function terminalProfileOpenOptions(threadId: string, terminalId: string) {
  const launch = readTerminalLaunch(threadId, terminalId);
  // Surviving sessions keep their recorded identity; old unknown sessions remain legacy attach.
  if (launch?.updatedAt) {
    const actual = launch.shellLaunchIdentity;
    if (actual) return { shellSelection: actual.selection };
    return {};
  }
  const request =
    useTerminalStateStore.getState().terminalProfileLaunches[
      terminalProfileKey(threadId, terminalId)
    ];
  if (request?.requiresChoice)
    throw new Error(
      "This pane's shell profile is unknown or unconfirmed. Choose a profile from the source terminal's menu to open a new terminal.",
    );
  return request?.shellSelection ? { shellSelection: request.shellSelection } : {};
}
