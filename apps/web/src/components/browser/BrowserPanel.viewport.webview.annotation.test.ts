import { describe, expect, it, vi } from "vitest";

import type { BrowserAnnotationSelection } from "./BrowserPanel.annotation";
import type { ElectronWebview } from "./BrowserPanel.viewport.types";
import {
  captureBrowserAnnotation,
  readIsPdfDocument,
} from "./BrowserPanel.viewport.webview.annotation";

function makeWebview(overrides: Partial<ElectronWebview> = {}): ElectronWebview {
  return {
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    openDevTools: vi.fn(),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    getURL: vi.fn(() => "https://example.com"),
    getTitle: vi.fn(() => "Example"),
    getWebContentsId: vi.fn(() => 1),
    executeJavaScript: vi.fn(async () => false),
    capturePage: vi.fn(async () => ({ toDataURL: () => "data:image/png;base64,abc" })),
    ...overrides,
  } as ElectronWebview;
}

describe("webview PDF annotation helpers", () => {
  it("detects workspace PDF preview URLs without probing the guest DOM", async () => {
    const executeJavaScriptSpy = vi.fn();
    const executeJavaScript: ElectronWebview["executeJavaScript"] = async <T = unknown>() => {
      executeJavaScriptSpy();
      return false as T;
    };
    const webview = makeWebview({
      getURL: vi.fn(
        () =>
          "http://127.0.0.1:3773/api/workspace-file-preview?cwd=%2Ftmp&relativePath=docs%2Ffile.pdf",
      ),
      executeJavaScript,
    });

    await expect(readIsPdfDocument(webview, "")).resolves.toBe(true);
    expect(executeJavaScriptSpy).not.toHaveBeenCalled();
  });

  it("captures PDF region annotations with the current browser page metadata", async () => {
    const selection: Exclude<BrowserAnnotationSelection, { cancelled: true }> = {
      cancelled: false,
      comment: "Inspect this",
      intent: "comment",
      element: {
        selector: "",
        tag: "pdf-region",
        role: "region",
        text: "PDF region annotation",
        ariaLabel: null,
        id: null,
        className: "",
        rect: { x: 4, y: 8, width: 120, height: 80 },
      },
      viewport: { width: 640, height: 480, devicePixelRatio: 2 },
    };
    const webview = makeWebview({
      getURL: vi.fn(() => "http://127.0.0.1:3773/api/workspace-file-preview?relativePath=a.pdf"),
      getTitle: vi.fn(() => "a.pdf"),
    });

    await expect(captureBrowserAnnotation(webview, selection)).resolves.toMatchObject({
      comment: "Inspect this",
      intent: "comment",
      page: {
        url: "http://127.0.0.1:3773/api/workspace-file-preview?relativePath=a.pdf",
        title: "a.pdf",
      },
      element: selection.element,
      viewport: selection.viewport,
      screenshot: {
        mime: "image/png",
        dataUrl: "data:image/png;base64,abc",
      },
    });
  });
});
