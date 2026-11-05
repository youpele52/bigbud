import { beforeEach, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
const handlers = vi.hoisted(
  () => new Map<string, (event: unknown, generation: unknown) => Promise<void>>(),
);
vi.mock("electron", () => ({
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, callback: (event: unknown, generation: unknown) => Promise<void>) =>
      handlers.set(channel, callback),
  },
}));
import { registerOwnershipRecoveryIpc } from "./ipcHandlers.ownershipRecovery";
import { desktopIpcChannels } from "../main.channels";
import { authorizeFakeSenders, fakeIpcSender } from "./ipcAuthorization.testSupport";
beforeEach(() => handlers.clear());
it("requires the main window's main frame and a valid generation for both actions", async () => {
  const main = fakeIpcSender(1) as unknown as WebContents;
  const other = fakeIpcSender(2);
  authorizeFakeSenders([
    [main, "main"],
    [other, "main"],
  ]);
  const recover = Object.assign(
    vi.fn(async () => {}),
    { check: vi.fn(async () => {}) },
  );
  registerOwnershipRecoveryIpc(() => main, recover);
  for (const channel of [
    desktopIpcChannels.recoverBackendOwnership,
    desktopIpcChannels.checkBackendOwnership,
  ]) {
    const handler = handlers.get(channel)!;
    // Unregistered sender and subframe: bounded denial before any effect.
    expect(await handler({ sender: {}, senderFrame: main.mainFrame }, 1)).toBeNull();
    expect(await handler({ sender: main, senderFrame: {} }, 1)).toBeNull();
    // A registered main-role sender that is not the current main window.
    await expect(handler({ sender: other, senderFrame: other.mainFrame }, 1)).rejects.toThrow(
      "Untrusted",
    );
    await expect(
      handler({ sender: main, senderFrame: main.mainFrame }, { pid: 123 }),
    ).rejects.toThrow("Invalid");
    await handler({ sender: main, senderFrame: main.mainFrame }, 1);
  }
  expect(recover).toHaveBeenCalledExactlyOnceWith(1);
  expect(recover.check).toHaveBeenCalledExactlyOnceWith(1);
});
