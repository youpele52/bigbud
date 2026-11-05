import type { WebContents } from "electron";
import { desktopIpcChannels } from "../main.channels";
import { authorizedHandle, type IpcRoles } from "./ipcAuthorization";

const MAIN_ROLES: IpcRoles = ["main"];

/** Only the current trusted main frame can authorize interruption of another backend. */
export function registerOwnershipRecoveryIpc(
  getMain: () => WebContents | undefined,
  recover: ((generation: number) => Promise<void>) & {
    check: (generation: number) => Promise<void>;
  },
): void {
  for (const [channel, action] of [
    [desktopIpcChannels.recoverBackendOwnership, recover],
    [desktopIpcChannels.checkBackendOwnership, recover.check],
  ] as const) {
    authorizedHandle(channel, MAIN_ROLES, async (event, generation: unknown) => {
      if (
        event.sender !== getMain() ||
        !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Untrusted ownership recovery sender.");
      if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1)
        throw new Error("Invalid startup generation.");
      await action(generation);
    });
  }
}
