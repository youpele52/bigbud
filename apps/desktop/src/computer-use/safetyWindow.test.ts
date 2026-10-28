import { describe, expect, it, vi } from "vitest";

type Listener = (event: unknown, ...args: unknown[]) => unknown;
const handlers = vi.hoisted(() => new Map<string, Listener>());
vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  session: { fromPartition: vi.fn() },
  ipcMain: {
    handle: (channel: string, fn: Listener) => handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

import { COMPUTER_USE_SAFETY_ROLE } from "../window/DesktopWindowRegistry";
import { authorizeFakeSenders, fakeIpcSender } from "../window/ipcAuthorization.testSupport";
import { computerUseSafetyChannels } from "./safetyWindow.channels";
import {
  keepSafetyWindowUntilQuit,
  lockDownSafetyContents,
  lockDownSafetySession,
  SAFETY_WINDOW_CHROME,
} from "./safetyWindow";
import { registerComputerUseSafetyIpc, unavailableSafetyController } from "./safetyWindow.ipc";

describe("safety window lockdown", () => {
  it("cancels every request outside the fixed page directory and denies permissions", () => {
    let filter:
      | ((details: { url: string }, callback: (r: { cancel: boolean }) => void) => void)
      | undefined;
    const on = vi.fn();
    let permission: ((c: unknown, p: string, cb: (ok: boolean) => void) => void) | undefined;
    let check: (() => boolean) | undefined;
    lockDownSafetySession(
      {
        webRequest: { onBeforeRequest: (fn: NonNullable<typeof filter>) => (filter = fn) },
        setPermissionRequestHandler: (fn: NonNullable<typeof permission>) => (permission = fn),
        setPermissionCheckHandler: (fn: NonNullable<typeof check>) => (check = fn),
        on,
      } as never,
      "file:///app/resources/computer-use-safety/",
    );
    const verdict = (url: string) => {
      let cancel: boolean | undefined;
      filter!({ url }, (result) => (cancel = result.cancel));
      return cancel;
    };
    expect(verdict("file:///app/resources/computer-use-safety/safety.js")).toBe(false);
    for (const url of [
      "http://localhost:3773/ws",
      "https://example.com",
      "file:///etc/passwd",
      "file:///app/resources/computer-use-safety-other/x.js",
      "data:text/html,x",
    ]) {
      expect(verdict(url), url).toBe(true);
    }
    const granted = vi.fn();
    permission!(null, "media", granted);
    expect(granted).toHaveBeenCalledWith(false);
    expect(check!()).toBe(false);
    expect(on).toHaveBeenCalledWith("will-download", expect.any(Function));
  });

  it("denies new windows, navigation, redirects and webviews", () => {
    const listeners = new Map<string, (event: { preventDefault: () => void }) => void>();
    let open: (() => { action: string }) | undefined;
    lockDownSafetyContents({
      setWindowOpenHandler: (fn: NonNullable<typeof open>) => (open = fn),
      on: (name: string, fn: (event: { preventDefault: () => void }) => void) =>
        listeners.set(name, fn),
    } as never);
    expect(open!()).toEqual({ action: "deny" });
    for (const name of ["will-navigate", "will-redirect", "will-attach-webview"]) {
      const preventDefault = vi.fn();
      listeners.get(name)?.({ preventDefault });
      expect(preventDefault, name).toHaveBeenCalledOnce();
    }
  });
});

describe("safety window lifetime", () => {
  it("is neither closable nor focusable", () => {
    // Regression (review P3): Cmd+W could close it and menu actions reached it.
    expect(SAFETY_WINDOW_CHROME).toMatchObject({ closable: false, focusable: false });
  });

  it("refuses every close until quit starts, then destroys itself", () => {
    let onClose: ((event: { preventDefault: () => void }) => void) | undefined;
    let onQuit: (() => void) | undefined;
    const destroy = vi.fn();
    keepSafetyWindowUntilQuit(
      {
        on: ((_name: string, fn: typeof onClose) => (onClose = fn)) as never,
        destroy,
        isDestroyed: () => false,
      },
      (listener) => (onQuit = listener),
    );
    const early = vi.fn();
    onClose!({ preventDefault: early });
    expect(early).toHaveBeenCalledOnce();
    onQuit!();
    expect(destroy).toHaveBeenCalledOnce();
    const late = vi.fn();
    onClose!({ preventDefault: late });
    expect(late).not.toHaveBeenCalled();
  });
});

const event = (sender: { readonly mainFrame: object }) => ({
  sender,
  senderFrame: sender.mainFrame,
});

describe("safety channels", () => {
  const safety = fakeIpcSender(1);
  const main = fakeIpcSender(2);
  const compact = fakeIpcSender(3);

  it("reports unavailable honestly and lets only the safety and main roles stop", async () => {
    authorizeFakeSenders([
      [safety, COMPUTER_USE_SAFETY_ROLE],
      [main, "main"],
      [compact, "compact-chat"],
    ]);
    const openRestrictions = vi.fn();
    registerComputerUseSafetyIpc(unavailableSafetyController(openRestrictions));
    const stop = handlers.get(computerUseSafetyChannels.stop)!;
    expect(await stop(event(safety))).toEqual({ revoked: false, reason: "control_unavailable" });
    expect(await stop(event(main))).toEqual({ revoked: false, reason: "control_unavailable" });
    expect(await stop(event(compact))).toBeNull();
    const status = handlers.get(computerUseSafetyChannels.getStatus)!;
    expect(await status(event(safety))).toMatchObject({ state: "unavailable" });
    const ack = handlers.get(computerUseSafetyChannels.acknowledgeWarning)!;
    expect(await ack(event(safety), "x".repeat(129))).toBe(false);
    // The fixed restrictions link belongs to the safety surface only.
    const restrictions = handlers.get(computerUseSafetyChannels.openRestrictions)!;
    expect(await restrictions(event(main))).toBeNull();
    expect(openRestrictions).not.toHaveBeenCalled();
    expect(await restrictions(event(safety))).toBe(true);
    expect(openRestrictions).toHaveBeenCalledOnce();
  });
});
