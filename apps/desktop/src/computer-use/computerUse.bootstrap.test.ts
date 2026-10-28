import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { on: vi.fn() },
  BrowserWindow: vi.fn(),
  session: { fromPartition: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

import { sendWhenLoaded } from "./computerUse.bootstrap";

function fakeWindow(loading: boolean) {
  let loaded: (() => void) | undefined;
  const send = vi.fn();
  const window = {
    isDestroyed: () => false,
    webContents: {
      isLoadingMainFrame: () => loading,
      once: (_event: string, fn: () => void) => (loaded = fn),
      send,
    },
  };
  return { window: window as never, send, finishLoad: () => loaded?.() };
}

describe("sendWhenLoaded", () => {
  it("waits for a freshly created window to finish loading", () => {
    // Regression (review P3): open-settings was sent before the page loaded.
    const fresh = fakeWindow(true);
    sendWhenLoaded(fresh.window, "menu-action", "open-settings");
    expect(fresh.send).not.toHaveBeenCalled();
    fresh.finishLoad();
    expect(fresh.send).toHaveBeenCalledWith("menu-action", "open-settings");
  });

  it("sends at once to a loaded window", () => {
    const ready = fakeWindow(false);
    sendWhenLoaded(ready.window, "menu-action", "open-settings");
    expect(ready.send).toHaveBeenCalledOnce();
  });
});
