import { describe, expect, it, vi } from "vitest";

import { makeDesktopBridge, showContextMenuFallbackMock } from "./wsNativeApi.test.helpers";

describe("wsNativeApi — shell & context menu", () => {
  it("forwards context menu metadata to the desktop bridge", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    const testGlobal = globalThis as typeof globalThis & {
      window?: Window & typeof globalThis & { desktopBridge?: unknown };
    };
    if (!testGlobal.window) {
      testGlobal.window = {} as Window & typeof globalThis & { desktopBridge?: unknown };
    }
    testGlobal.window.desktopBridge = makeDesktopBridge({ showContextMenu });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const api = createWsNativeApi();
    const items = [{ id: "delete", label: "Delete" }] as const;

    await expect(api.contextMenu.show(items)).resolves.toBe("delete");
    expect(showContextMenu).toHaveBeenCalledWith(items, undefined);
  });

  it("routes openExternal through the embedded browser panel store", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const { useBrowserPanelStore } = await import("~/stores/browser/browser.store");
    useBrowserPanelStore.setState({ open: false, tabsById: {} });

    const api = createWsNativeApi();
    await api.shell.openExternal(" https://example.com/path ");

    const browserTabId = Object.keys(useBrowserPanelStore.getState().tabsById)[0] ?? "";

    expect(useBrowserPanelStore.getState()).toMatchObject({
      open: true,
      tabsById: {
        [browserTabId]: {
          url: "https://example.com/path",
        },
      },
    });
  });

  it("routes macOS System Settings links through the desktop bridge", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    const testGlobal = globalThis as typeof globalThis & {
      window?: Window & typeof globalThis & { desktopBridge?: unknown };
    };
    if (!testGlobal.window) {
      testGlobal.window = {} as Window & typeof globalThis & { desktopBridge?: unknown };
    }
    testGlobal.window.desktopBridge = makeDesktopBridge({ openExternal });

    const { createWsNativeApi } = await import("./wsNativeApi");
    const { useBrowserPanelStore } = await import("~/stores/browser/browser.store");
    useBrowserPanelStore.setState({ open: false, tabsById: {} });

    const api = createWsNativeApi();
    await api.shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    );

    expect(openExternal).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    );
    expect(useBrowserPanelStore.getState()).toMatchObject({ open: false, tabsById: {} });
  });

  it("rejects openExternal when the URL is blank", async () => {
    const { createWsNativeApi } = await import("./wsNativeApi");
    const { useBrowserPanelStore } = await import("~/stores/browser/browser.store");
    useBrowserPanelStore.setState({ open: false, tabsById: {} });

    const api = createWsNativeApi();

    await expect(api.shell.openExternal("   ")).rejects.toThrow("Unable to open link.");
    expect(useBrowserPanelStore.getState()).toMatchObject({ open: false, tabsById: {} });
  });

  it("falls back to the browser context menu helper when the desktop bridge is missing", async () => {
    showContextMenuFallbackMock.mockResolvedValue("rename");
    const { createWsNativeApi } = await import("./wsNativeApi");

    const api = createWsNativeApi();
    const items = [{ id: "rename", label: "Rename" }] as const;

    await expect(api.contextMenu.show(items, { x: 4, y: 5 })).resolves.toBe("rename");
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 4, y: 5 });
  });
});
