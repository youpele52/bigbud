import { describe, expect, it, vi } from "vitest";

import type { ElectronWebview } from "./BrowserPanel.viewport.types";
import { bindWebviewLifecycle } from "./BrowserPanel.viewport.webview.lifecycle";

function makeWebview(): ElectronWebview {
  return Object.assign(new EventTarget(), {
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
    canGoBack: vi.fn(() => true),
    canGoForward: vi.fn(() => false),
    getURL: vi.fn(() => "https://redirect.example/"),
    getTitle: vi.fn(() => "Redirected page"),
    getWebContentsId: vi.fn(() => 1),
    loadURL: vi.fn(async () => undefined),
    getAttribute: vi.fn(() => null),
    setAttribute: vi.fn(),
    executeJavaScript: vi.fn(async () => null),
    capturePage: vi.fn(async () => ({ toDataURL: () => "" })),
  }) as unknown as ElectronWebview;
}

function createLifecycle(webview: ElectronWebview) {
  const callbacks = {
    onCertificateChallengeChange: vi.fn(),
    onContextMenu: vi.fn(),
    onLoadFail: vi.fn(),
    onLoadStart: vi.fn(),
    onLoadStop: vi.fn(),
    onLoadSuccess: vi.fn(),
    onWebviewStateChange: vi.fn(),
    onNavigationCommit: vi.fn(),
    onNavigationStateChange: vi.fn(),
    onPageMetadataChange: vi.fn(),
    onUrlChange: vi.fn(),
  };
  const cleanup = bindWebviewLifecycle({
    bridge: undefined,
    getUrl: () => "https://initial.example/",
    webview,
    ...callbacks,
  });

  return { callbacks, cleanup };
}

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve: resolve! };
}

describe("webview lifecycle coordination", () => {
  it("keeps redirected navigation and page metadata synchronized", () => {
    const webview = makeWebview();
    const { callbacks, cleanup } = createLifecycle(webview);

    webview.dispatchEvent(
      Object.assign(new Event("page-title-updated"), { title: "Original page" }),
    );
    webview.dispatchEvent(
      Object.assign(new Event("page-favicon-updated"), {
        favicons: ["https://initial.example/favicon.ico"],
      }),
    );
    webview.dispatchEvent(
      Object.assign(new Event("did-navigate"), { url: "https://redirect.example/" }),
    );

    expect(callbacks.onUrlChange).toHaveBeenCalledWith("https://redirect.example/");
    expect(callbacks.onNavigationCommit).toHaveBeenCalledWith("https://redirect.example/");
    expect(callbacks.onNavigationStateChange).toHaveBeenCalledWith({
      canGoBack: true,
      canGoForward: false,
    });
    expect(callbacks.onPageMetadataChange).toHaveBeenLastCalledWith(
      {
        title: "",
        faviconUrl: null,
      },
      "https://redirect.example/",
    );
    cleanup();
  });

  it("associates page metadata with the latest committed URL", () => {
    const webview = makeWebview();
    const { callbacks, cleanup } = createLifecycle(webview);

    webview.dispatchEvent(
      Object.assign(new Event("did-navigate"), { url: "https://latest.example/" }),
    );
    webview.dispatchEvent(Object.assign(new Event("page-title-updated"), { title: "Latest page" }));

    expect(callbacks.onPageMetadataChange).toHaveBeenLastCalledWith(
      { title: "Latest page", faviconUrl: null },
      "https://latest.example/",
    );
    cleanup();
  });

  it("ignores asynchronous metadata from a stale navigation", async () => {
    const webview = makeWebview();
    const metadata = deferred<{ title: string; faviconUrl: string } | null>();
    vi.mocked(webview.getURL)
      .mockReturnValueOnce("https://first.example/")
      .mockReturnValue("https://second.example/");
    vi.mocked(webview.executeJavaScript).mockImplementation((source) =>
      source.includes("document.querySelector") ? metadata.promise : Promise.resolve(null),
    );
    const { callbacks, cleanup } = createLifecycle(webview);

    webview.dispatchEvent(
      Object.assign(new Event("did-navigate"), { url: "https://first.example/" }),
    );
    webview.dispatchEvent(new Event("dom-ready"));
    webview.dispatchEvent(Object.assign(new Event("did-start-navigation"), { isMainFrame: true }));
    metadata.resolve({ title: "First page", faviconUrl: "https://first.example/favicon.ico" });
    await Promise.resolve();

    expect(callbacks.onPageMetadataChange).not.toHaveBeenCalledWith(
      { title: "First page", faviconUrl: "https://first.example/favicon.ico" },
      "https://first.example/",
    );
    cleanup();
  });

  it("isolates asynchronous metadata between tabs and after cleanup", async () => {
    const firstWebview = makeWebview();
    const secondWebview = makeWebview();
    const firstMetadata = deferred<{ title: string; faviconUrl: string } | null>();
    const secondMetadata = deferred<{ title: string; faviconUrl: string } | null>();
    vi.mocked(firstWebview.getURL).mockReturnValue("https://first.example/");
    vi.mocked(secondWebview.getURL).mockReturnValue("https://second.example/");
    vi.mocked(firstWebview.executeJavaScript).mockImplementation((source) =>
      source.includes("document.querySelector") ? firstMetadata.promise : Promise.resolve(null),
    );
    vi.mocked(secondWebview.executeJavaScript).mockImplementation((source) =>
      source.includes("document.querySelector") ? secondMetadata.promise : Promise.resolve(null),
    );
    const first = createLifecycle(firstWebview);
    const second = createLifecycle(secondWebview);

    firstWebview.dispatchEvent(
      Object.assign(new Event("did-navigate"), { url: "https://first.example/" }),
    );
    firstWebview.dispatchEvent(new Event("dom-ready"));
    secondWebview.dispatchEvent(
      Object.assign(new Event("did-navigate"), { url: "https://second.example/" }),
    );
    secondWebview.dispatchEvent(new Event("dom-ready"));
    first.cleanup();
    firstMetadata.resolve({ title: "First page", faviconUrl: "https://first.example/favicon.ico" });
    secondMetadata.resolve({
      title: "Second page",
      faviconUrl: "https://second.example/favicon.ico",
    });
    await Promise.resolve();

    expect(first.callbacks.onPageMetadataChange).not.toHaveBeenCalledWith(
      { title: "First page", faviconUrl: "https://first.example/favicon.ico" },
      "https://first.example/",
    );
    expect(second.callbacks.onPageMetadataChange).toHaveBeenLastCalledWith(
      { title: "Second page", faviconUrl: "https://second.example/favicon.ico" },
      "https://second.example/",
    );
    second.cleanup();
  });

  it("does not record in-page navigation as a main-frame visit commit", () => {
    const webview = makeWebview();
    const { callbacks, cleanup } = createLifecycle(webview);

    webview.dispatchEvent(
      Object.assign(new Event("did-navigate-in-page"), {
        url: "https://redirect.example/#section",
      }),
    );

    expect(callbacks.onUrlChange).toHaveBeenCalledWith("https://redirect.example/#section");
    expect(callbacks.onNavigationCommit).not.toHaveBeenCalled();
    cleanup();
  });

  it("suppresses success after a main-frame failure until the next load starts", () => {
    const webview = makeWebview();
    const { callbacks, cleanup } = createLifecycle(webview);

    webview.dispatchEvent(Object.assign(new Event("did-start-navigation"), { isMainFrame: true }));
    webview.dispatchEvent(Object.assign(new Event("did-frame-finish-load"), { isMainFrame: true }));
    webview.dispatchEvent(
      Object.assign(new Event("did-fail-load"), {
        errorCode: -105,
        errorDescription: "Name not resolved",
        isMainFrame: true,
        validatedURL: "https://missing.example/",
      }),
    );
    webview.dispatchEvent(Object.assign(new Event("did-frame-finish-load"), { isMainFrame: true }));
    webview.dispatchEvent(Object.assign(new Event("did-start-navigation"), { isMainFrame: true }));
    webview.dispatchEvent(Object.assign(new Event("did-frame-finish-load"), { isMainFrame: true }));

    expect(callbacks.onLoadFail).toHaveBeenCalledWith({
      errorCode: -105,
      errorDescription: "Name not resolved",
      validatedURL: "https://missing.example/",
    });
    expect(callbacks.onLoadSuccess).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("navigates on attach and ignores events after cleanup", () => {
    const webview = makeWebview();
    const { callbacks, cleanup } = createLifecycle(webview);

    webview.dispatchEvent(new Event("did-attach"));
    expect(webview.loadURL).toHaveBeenCalledWith("https://initial.example/");

    cleanup();
    webview.dispatchEvent(
      Object.assign(new Event("did-navigate"), { url: "https://after-cleanup.example/" }),
    );
    webview.dispatchEvent(Object.assign(new Event("did-start-navigation"), { isMainFrame: true }));
    webview.dispatchEvent(Object.assign(new Event("did-frame-finish-load"), { isMainFrame: true }));
    webview.dispatchEvent(new Event("did-stop-loading"));
    webview.dispatchEvent(new Event("render-process-gone"));

    expect(callbacks.onUrlChange).not.toHaveBeenCalled();
    expect(callbacks.onLoadStart).not.toHaveBeenCalled();
    expect(callbacks.onLoadSuccess).not.toHaveBeenCalled();
    expect(callbacks.onLoadStop).not.toHaveBeenCalled();
    expect(callbacks.onWebviewStateChange).not.toHaveBeenCalled();
  });

  it("tracks only main-frame loading, stops loading after a crash, and reports webview states", () => {
    const webview = makeWebview();
    const { callbacks, cleanup } = createLifecycle(webview);

    webview.dispatchEvent(Object.assign(new Event("did-start-navigation"), { isMainFrame: false }));
    webview.dispatchEvent(Object.assign(new Event("did-start-navigation"), { isMainFrame: true }));
    webview.dispatchEvent(new Event("did-stop-loading"));
    webview.dispatchEvent(new Event("unresponsive"));
    webview.dispatchEvent(new Event("responsive"));
    webview.dispatchEvent(new Event("render-process-gone"));

    expect(callbacks.onLoadStart).toHaveBeenCalledOnce();
    expect(callbacks.onLoadStop).toHaveBeenCalledTimes(2);
    expect(callbacks.onWebviewStateChange.mock.calls).toEqual([
      ["unresponsive"],
      [null],
      ["crashed"],
    ]);
    cleanup();
  });
});
