import { ipcMain, type WebContents } from "electron";
import { desktopIpcChannels } from "../main.channels";

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
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, generation: unknown) => {
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
