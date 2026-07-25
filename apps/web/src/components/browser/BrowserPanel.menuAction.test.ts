import { describe, expect, it } from "vitest";

import { planDesktopBrowserContextMenu, planDesktopBrowserReload } from "./BrowserPanel.menuAction";

describe("planDesktopBrowserReload", () => {
  it("ignores unrelated menu actions", () => {
    expect(
      planDesktopBrowserReload({
        action: "open-settings",
        browserOpen: true,
        browserVisible: true,
      }),
    ).toEqual({
      reloadMode: null,
      shouldActivateBrowser: false,
    });
  });

  it("ignores browser reload shortcuts when the browser is closed", () => {
    expect(
      planDesktopBrowserReload({
        action: "reload-browser",
        browserOpen: false,
        browserVisible: false,
      }),
    ).toEqual({
      reloadMode: null,
      shouldActivateBrowser: false,
    });
  });

  it("reloads the active browser tab immediately", () => {
    expect(
      planDesktopBrowserReload({
        action: "reload-browser",
        browserOpen: true,
        browserVisible: true,
      }),
    ).toEqual({
      reloadMode: "normal",
      shouldActivateBrowser: false,
    });
  });

  it("activates a background browser tab before reloading it", () => {
    expect(
      planDesktopBrowserReload({
        action: "reload-browser-ignoring-cache",
        browserOpen: true,
        browserVisible: false,
      }),
    ).toEqual({
      reloadMode: "ignoring-cache",
      shouldActivateBrowser: true,
    });
  });
});

describe("planDesktopBrowserContextMenu", () => {
  it("toggles only for a visible browser with a URL", () => {
    expect(
      planDesktopBrowserContextMenu({
        action: "toggle-browser-context-menu",
        browserVisible: true,
        hasUrl: true,
      }),
    ).toBe("toggle");
    expect(
      planDesktopBrowserContextMenu({
        action: "toggle-browser-context-menu",
        browserVisible: false,
        hasUrl: true,
      }),
    ).toBeNull();
    expect(
      planDesktopBrowserContextMenu({
        action: "toggle-browser-context-menu",
        browserVisible: true,
        hasUrl: false,
      }),
    ).toBeNull();
  });

  it("closes from guest browser input", () => {
    expect(
      planDesktopBrowserContextMenu({
        action: "close-browser-context-menu",
        browserVisible: true,
        hasUrl: true,
      }),
    ).toBe("close");
  });
});
