import { describe, expect, it } from "vitest";

import { planDesktopBrowserReload } from "./BrowserPanel.menuAction";

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
