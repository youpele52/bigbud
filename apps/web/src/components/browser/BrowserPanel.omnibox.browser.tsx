import "../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useBrowserPanelStore } from "~/stores/browser/browser.store";

const searchSettings = vi.hoisted(() => ({ browserSearchEngine: "duckduckgo" }));
const browserHistoryStorageMock = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    set: vi.fn((key: string, value: unknown) => values.set(key, value)),
  };
});
const viewportCallbacks = vi.hoisted(() => ({
  onNavigationCommit: undefined as ((url: string) => void) | undefined,
  onPageMetadataChange: undefined as
    | ((metadata: { title: string; faviconUrl: string | null }, url?: string) => void)
    | undefined,
}));

vi.mock("~/hooks/useSettings", () => ({
  useSettings: (selector: (settings: { browserSearchEngine: string }) => unknown) =>
    selector(searchSettings),
}));

vi.mock("~/hooks/useLocalStorage", () => ({
  getLocalStorageItem: vi.fn((key: string) => browserHistoryStorageMock.values.get(key) ?? null),
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
    props: {
      onNavigationCommit?: (url: string) => void;
      onPageMetadataChange?: typeof viewportCallbacks.onPageMetadataChange;
    },
    ref: React.ForwardedRef<unknown>,
  ) {
    viewportCallbacks.onNavigationCommit = props.onNavigationCommit;
    viewportCallbacks.onPageMetadataChange = props.onPageMetadataChange;
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
    searchSettings.browserSearchEngine = "duckduckgo";
    browserHistoryStorageMock.set.mockClear();
    browserHistoryStorageMock.values.clear();
    viewportCallbacks.onNavigationCommit = undefined;
    viewportCallbacks.onPageMetadataChange = undefined;
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

  it.each([
    ["duckduckgo", "https://duckduckgo.com/?q="],
    ["google", "https://www.google.com/search?q="],
    ["brave", "https://search.brave.com/search?q="],
    ["bing", "https://www.bing.com/search?q="],
    ["startpage", "https://www.startpage.com/sp/search?query="],
  ])("submits encoded %s searches and records navigation commits", async (engine, prefix) => {
    searchSettings.browserSearchEngine = engine;
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />, {
      container: host,
    });

    try {
      const searchUrl = `${prefix}caf%C3%A9%20%26%20tea`;
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

  it("shows learned site icons in the address bar and URL suggestions, not search rows", async () => {
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />);
    const iconUrl = `${window.location.origin}/favicon-16x16.png`;
    try {
      viewportCallbacks.onNavigationCommit?.("https://example.com/");
      viewportCallbacks.onPageMetadataChange?.(
        { title: "Example", faviconUrl: iconUrl },
        "https://example.com/",
      );
      await vi.waitFor(() => {
        expect(document.querySelector("[data-browser-address-icon] img")?.getAttribute("src")).toBe(
          iconUrl,
        );
      });
      await vi.waitFor(() =>
        expect(
          document
            .querySelector("[data-browser-address-icon] img")
            ?.classList.contains("invisible"),
        ).toBe(false),
      );
      await page.getByPlaceholder("Enter a URL or search").fill("example.com");
      await vi.waitFor(() => {
        expect(document.querySelectorAll('[data-browser-suggestion="url"]')).toHaveLength(1);
        expect(
          document.querySelector('[data-browser-suggestion="url"] img')?.getAttribute("src"),
        ).toBe(iconUrl);
        expect(
          document.querySelector('[data-browser-suggestion="search"] .lucide-search'),
        ).not.toBeNull();
        expect(document.querySelector('[data-browser-suggestion="search"] img')).toBeNull();
      });
      await page.getByPlaceholder("Enter a URL or search").fill("coffee & tea");
      expect(document.querySelector("[data-browser-address-icon] .lucide-search")).not.toBeNull();
      expect(document.querySelector("[data-browser-address-icon] img")).toBeNull();
      expect(useBrowserPanelStore.getState().tabsById.browser?.url).toBe("https://example.com");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps direct Enter navigation and supports keyboard selection of search and site rows", async () => {
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />);
    try {
      const input = page.getByPlaceholder("Enter a URL or search");
      await input.fill("example.org");
      input
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await vi.waitFor(() =>
        expect(
          document
            .querySelector('[data-browser-suggestion="search"]')
            ?.classList.contains("bg-accent"),
        ).toBe(true),
      );
      input.element().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await vi.waitFor(() =>
        expect(useBrowserPanelStore.getState().tabsById.browser?.url).toBe(
          "https://duckduckgo.com/?q=example.org",
        ),
      );
      await input.fill("example.net");
      input
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      await vi.waitFor(() =>
        expect(
          document
            .querySelector('[data-browser-suggestion="url"]')
            ?.classList.contains("bg-accent"),
        ).toBe(true),
      );
      input.element().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await vi.waitFor(() =>
        expect(useBrowserPanelStore.getState().tabsById.browser?.url).toBe("https://example.net/"),
      );
      await input.fill("example.org");
      input.element().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await vi.waitFor(() =>
        expect(useBrowserPanelStore.getState().tabsById.browser?.url).toBe("https://example.org/"),
      );
      await input.fill("example.edu");
      await page.getByRole("button", { name: "https://example.edu/", exact: true }).click();
      await vi.waitFor(() =>
        expect(useBrowserPanelStore.getState().tabsById.browser?.url).toBe("https://example.edu/"),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("dismisses a clicked search suggestion and navigates its URL normally on Enter", async () => {
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />);
    try {
      const input = page.getByPlaceholder("Enter a URL or search");
      const searchUrl = "https://duckduckgo.com/?q=coffee%20%26%20tea";
      await input.fill("coffee & tea");
      await page.getByRole("button", { name: "coffee & tea — Search DuckDuckGo" }).click();
      await vi.waitFor(() => {
        expect(useBrowserPanelStore.getState().tabsById.browser?.url).toBe(searchUrl);
        expect(document.querySelectorAll("[data-browser-suggestion]")).toHaveLength(0);
        expect(document.activeElement).not.toBe(input.element());
      });
      await input.click();
      await vi.waitFor(() =>
        expect(document.querySelectorAll("[data-browser-suggestion]").length).toBeGreaterThan(0),
      );
      input.element().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await vi.waitFor(() => {
        expect(input.element()).toHaveValue(searchUrl);
        expect(useBrowserPanelStore.getState().tabsById.browser?.url).toBe(searchUrl);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("debounces new-site icons in web mode without live page metadata", async () => {
    const session = cdp();
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />);
    try {
      // Keep image requests pending until the test explicitly exercises the error fallback.
      await session.send("Fetch.enable", {
        patterns: [{ urlPattern: "*/favicon.ico", resourceType: "Image" }],
      });
      const input = page.getByPlaceholder("Enter a URL or search");
      const iconUrl = `${window.location.origin}/favicon.ico`;
      const siteUrl = `${window.location.origin}/new-site?secret=1#fragment`;
      await input.fill(siteUrl);
      expect(document.querySelector("[data-browser-address-icon] img")).toBeNull();
      expect(document.querySelector('[data-browser-suggestion="url"] img')).toBeNull();
      await vi.waitFor(() => {
        expect(document.querySelector("[data-browser-address-icon] img")?.getAttribute("src")).toBe(
          iconUrl,
        );
        expect(
          document.querySelector('[data-browser-suggestion="url"] img')?.getAttribute("src"),
        ).toBe(iconUrl);
      });
      expect(document.querySelector('[data-browser-suggestion="search"] img')).toBeNull();
      expect(viewportCallbacks.onPageMetadataChange).toBeDefined();
      expect(useBrowserPanelStore.getState().tabsById.browser?.url).toBe("https://example.com");
      document.querySelector("[data-browser-address-icon] img")!.dispatchEvent(new Event("error"));
      await vi.waitFor(() => {
        expect(document.querySelector("[data-browser-address-icon] img")).toBeNull();
        expect(document.querySelector("[data-browser-address-icon] .lucide-globe")).not.toBeNull();
      });
      await page.getByRole("button", { name: siteUrl, exact: true }).click();
      await vi.waitFor(() =>
        expect(useBrowserPanelStore.getState().tabsById.browser?.url).toBe(siteUrl),
      );
    } finally {
      await session.send("Fetch.disable");
      await screen.unmount();
    }
  });

  it("loads settled web-history favicons for partial searches without probing search URLs", async () => {
    const session = cdp();
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />);
    try {
      // Keep the favicon pending so a 404 from Vite cannot replace the icon with its fallback.
      await session.send("Fetch.enable", {
        patterns: [{ urlPattern: "*/favicon.ico", resourceType: "Image" }],
      });
      const siteUrl = `${window.location.origin}/example`;
      const iconUrl = `${window.location.origin}/favicon.ico`;
      viewportCallbacks.onNavigationCommit?.(siteUrl);
      await page.getByPlaceholder("Enter a URL or search").fill("example");
      expect(document.querySelector('[data-browser-suggestion="url"] img')).toBeNull();
      await vi.waitFor(() => {
        const siteRow = document.querySelector('[data-browser-suggestion="url"]');
        expect(siteRow?.textContent).toBe(siteUrl);
        expect(siteRow?.querySelector("img")?.getAttribute("src")).toBe(iconUrl);
        expect(document.querySelector("[data-browser-address-icon] .lucide-search")).not.toBeNull();
        expect(
          document.querySelector('[data-browser-suggestion="search"] .lucide-search'),
        ).not.toBeNull();
        expect(document.querySelector("[data-browser-address-icon] img")).toBeNull();
        expect(document.querySelector('[data-browser-suggestion="search"] img')).toBeNull();
        expect(Array.from(document.querySelectorAll("img"), (image) => image.src)).toEqual([
          iconUrl,
        ]);
      });
      expect(useBrowserPanelStore.getState().tabsById.browser?.url).toBe("https://example.com");
    } finally {
      await session.send("Fetch.disable");
      await screen.unmount();
    }
  });

  it.each([
    "coffee & tea",
    "https://user:secret@example.com/",
    "javascript:alert(1)",
    "file:///secret",
    "data:text/html,hello",
  ])("does not request speculative favicons for search terms or unsafe input %s", async (query) => {
    const screen = await render(<BrowserPanel activeThreadId={"thread-1" as never} />);
    try {
      await page.getByPlaceholder("Enter a URL or search").fill(query);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(document.querySelector("[data-browser-address-icon] img")).toBeNull();
      expect(document.querySelector('[data-browser-suggestion="url"] img')).toBeNull();
      expect(
        document.querySelector(
          `[data-browser-address-icon] ${query === "coffee & tea" ? ".lucide-search" : ".lucide-globe"}`,
        ),
      ).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
