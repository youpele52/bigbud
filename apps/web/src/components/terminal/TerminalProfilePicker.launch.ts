import { useTerminalStateStore } from "../../stores/terminal/terminal.store";
import { terminalProfileKey } from "../../lib/terminalProfileLaunch";
import {
  captureTerminalProfileLaunch,
  type TerminalProfileLaunch,
} from "../../lib/terminalProfileLaunch";
import { toastManager } from "../ui/toast.manager";

export function canCreateProfileTerminal(
  threadId: string,
  sourceId: string,
  profile?: TerminalProfileLaunch,
) {
  try {
    if (
      captureTerminalProfileLaunch(
        threadId,
        sourceId,
        profile,
        useTerminalStateStore.getState().terminalProfileLaunches[
          terminalProfileKey(threadId, sourceId)
        ],
      ).requiresChoice
    )
      throw new Error(
        "This terminal's actual shell profile is unknown or unconfirmed. Choose an explicit profile using its shell menu.",
      );
    return true;
  } catch (cause) {
    toastManager.add({
      type: "warning",
      title: "Choose a terminal shell profile",
      description: cause instanceof Error ? cause.message : "Profile launch unavailable.",
    });
    return false;
  }
}
