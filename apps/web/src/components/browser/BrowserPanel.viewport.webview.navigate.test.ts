import { describe, expect, it, vi } from "vitest";

import type { ElectronWebview } from "./BrowserPanel.viewport.types";
import {
  isAbortedWebviewNavigation,
  navigateElectronWebview,
  webviewIsShowingUrl,
} from "./BrowserPanel.viewport.webview.navigate";

function makeWebview(overrides: Partial<ElectronWebview> = {}): ElectronWebview {
  const attributes = new Map<string, string>();
  return {
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    openDevTools: vi.fn(),
    inspectElement: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    getURL: vi.fn(() => ""),
    getTitle: vi.fn(() => ""),
    getWebContentsId: vi.fn(() => 1),
    loadURL: vi.fn(async () => undefined),
    stop: vi.fn(),
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: vi.fn((name: string, value: string) => {
      attributes.set(name, value);
    }),
    executeJavaScript: vi.fn(async () => undefined),
    capturePage: vi.fn(async () => ({ toDataURL: () => "data:image/png;base64,abc" })),
    ...overrides,
  } as ElectronWebview;
}

describe("electron webview navigation", () => {
  it("treats Electron abort errors as superseded navigations", () => {
    expect(
      isAbortedWebviewNavigation(
        new Error(
          "Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_ABORTED (-3)",
        ),
      ),
    ).toBe(true);
    expect(isAbortedWebviewNavigation(new Error("net::ERR_FAILED"))).toBe(false);
  });

  it("does not reload a guest that is already showing the requested URL", () => {
    const webview = makeWebview({
      getURL: vi.fn(() => "https://www.whoi.edu/ocean-facts/"),
    });
    expect(webviewIsShowingUrl(webview, "https://www.whoi.edu/ocean-facts/")).toBe(true);
    navigateElectronWebview(webview, "https://www.whoi.edu/ocean-facts/");
    expect(webview.loadURL).not.toHaveBeenCalled();
    expect(webview.setAttribute).not.toHaveBeenCalled();
  });

  it("loads a new URL through loadURL and swallows abort rejections", async () => {
    const loadURL = vi.fn(async () => {
      throw new Error("ERR_ABORTED (-3) loading 'https://www.whoi.edu/'");
    });
    const webview = makeWebview({
      getURL: vi.fn(() => "https://www.whoi.edu/"),
      loadURL,
    });

    navigateElectronWebview(webview, "https://www.earthdata.nasa.gov/centers/ob-daac");
    expect(webview.stop).not.toHaveBeenCalled();
    expect(loadURL).toHaveBeenCalledWith("https://www.earthdata.nasa.gov/centers/ob-daac");
    await Promise.resolve();
  });

  it("does not restart a navigation that already redirected to the requested URL", () => {
    const webview = makeWebview({
      getURL: vi.fn(() => "https://www.whoi.edu/ocean-facts/"),
      getAttribute: vi.fn(() => "https://www.whoi.edu/ocean-facts"),
    });

    navigateElectronWebview(webview, "https://www.whoi.edu/ocean-facts/");
    expect(webview.loadURL).not.toHaveBeenCalled();
    expect(webview.setAttribute).not.toHaveBeenCalled();
  });

  it("falls back to src while the guest is still attaching", () => {
    const webview = makeWebview({
      getWebContentsId: vi.fn(() => {
        throw new Error("Guest has not been attached yet");
      }),
    });

    navigateElectronWebview(webview, "https://example.com");
    expect(webview.setAttribute).toHaveBeenCalledWith("src", "https://example.com");
    expect(webview.loadURL).not.toHaveBeenCalled();
  });
});
