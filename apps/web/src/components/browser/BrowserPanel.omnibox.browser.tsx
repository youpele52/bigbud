import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useBrowserPanelStore } from "~/stores/browser/browser.store";

const browserHistoryStorageMock = vi.hoisted(() => ({ set: vi.fn() }));
const viewportCallbacks = vi.hoisted(() => ({
  onNavigationCommit: undefined as ((url: string) => void) | undefined,
}));

vi.mock("~/hooks/useLocalStorage", () => ({
  getLocalStorageItem: vi.fn(() => null),
  setLocalStorageItem: browserHistoryStorageMock.set,
}));

vi.mock("./BrowserPanel.annotation.hook", () => ({
  useBrowserAnnotation: () => ({
    annotationActive: false,
    cancelAnnotation: async () => undefined,
    handleAnnotate: async () => undefined,
  }),
}));

vi.mock("./BrowserPanel.viewport", async () => {
  const React = await import("react");

  const BrowserViewport = React.forwardRef(function MockBrowserViewport(
    props: { onNavigationCommit?: (url: string) => void },
    ref: React.ForwardedRef<unknown>,
  ) {
    viewportCallbacks.onNavigationCommit = props.onNavigationCommit;
    React.useImperativeHandle(ref, () => ({
      goBack: () => undefined,
      goForward: () => undefined,
      reload: () => undefined,
      reloadIgnoringCache: () => undefined,
    }));

    return <div data-testid="mock-browser-viewport" />;
  });

  return { BrowserViewport };
});

import BrowserPanel from "./BrowserPanel";

describe("BrowserPanel omnibox", () => {
  beforeEach(() => {
    browserHistoryStorageMock.set.mockClear();
    viewportCallbacks.onNavigationCommit = undefined;
    useBrowserPanelStore.setState({
      open: true,
      tabsById: {
        browser: { faviconUrl: null, title: "", url: "https://example.com" },
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    useBrowserPanelStore.setState({ open: false, tabsById: {} });
  });

  it("shows a validation error without navigating for unsupported schemes", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />, {
      container: host,
    });

    try {
      const input = document.querySelector('input[placeholder="Enter a URL or search"]');
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Unable to find browser omnibox.");
      }
      await page.getByPlaceholder("Enter a URL or search").fill("javascript:alert(1)");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      await vi.waitFor(() => {
        expect(useBrowserPanelStore.getState().tabsById.browser?.url).toBe("https://example.com");
        expect(host.textContent).toContain("This URL can't be opened");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("submits encoded searches and records them after navigation commits", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />, {
      container: host,
    });

    try {
      const searchUrl = "https://www.google.com/search?q=caf%C3%A9%20%26%20tea";
      const input = document.querySelector('input[placeholder="Enter a URL or search"]');
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Unable to find browser omnibox.");
      }
      await page.getByPlaceholder("Enter a URL or search").fill("café & tea");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      await vi.waitFor(() => {
        expect(useBrowserPanelStore.getState().tabsById.browser?.url).toBe(searchUrl);
      });
      viewportCallbacks.onNavigationCommit?.(searchUrl);

      await vi.waitFor(() => {
        expect(browserHistoryStorageMock.set).toHaveBeenCalledWith(
          "bigbud:browser-history:v2",
          expect.objectContaining({
            visits: [expect.objectContaining({ normalizedUrl: searchUrl })],
          }),
          expect.anything(),
          expect.anything(),
        );
      });
    } finally {
      await screen.unmount();
    }
  });
});
