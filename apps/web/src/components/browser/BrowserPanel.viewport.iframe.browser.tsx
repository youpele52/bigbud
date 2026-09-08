import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { BrowserIframeViewport } from "./BrowserPanel.viewport.iframe";
import type { BrowserViewportRef } from "./BrowserPanel.viewport.types";

describe("BrowserIframeViewport lifecycle", () => {
  it("starts the initial and reload navigations", async () => {
    const onLoadStart = vi.fn();
    const ref = createRef<BrowserViewportRef>();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <BrowserIframeViewport
        ref={ref}
        url="https://requested.example/"
        onLoadStart={onLoadStart}
      />,
      { container: host },
    );

    try {
      expect(onLoadStart).toHaveBeenCalledOnce();
      ref.current?.reload();
      expect(onLoadStart).toHaveBeenCalledTimes(2);
      expect(ref.current?.stopLoading).toBeUndefined();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("records the requested URL after a successful load", async () => {
    const onNavigationCommit = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <BrowserIframeViewport
        url="https://requested.example/"
        onNavigationCommit={onNavigationCommit}
      />,
      { container: host },
    );

    try {
      const iframe = host.querySelector("iframe");
      if (!(iframe instanceof HTMLIFrameElement)) {
        throw new Error("Unable to find browser fallback iframe.");
      }

      iframe.dispatchEvent(new Event("load"));

      expect(onNavigationCommit).toHaveBeenCalledWith("https://requested.example/");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("starts and resets lifecycle when React replaces the iframe URL", async () => {
    const onLoadStart = vi.fn();
    const onPageMetadataChange = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <BrowserIframeViewport
        url="https://first.example/"
        onLoadStart={onLoadStart}
        onPageMetadataChange={onPageMetadataChange}
      />,
      { container: host },
    );

    try {
      const firstIframe = host.querySelector("iframe");
      await screen.rerender(
        <BrowserIframeViewport
          url="https://second.example/"
          onLoadStart={onLoadStart}
          onPageMetadataChange={onPageMetadataChange}
        />,
      );

      expect(host.querySelector("iframe")).not.toBe(firstIframe);
      expect(onLoadStart).toHaveBeenCalledTimes(2);
      expect(onPageMetadataChange).toHaveBeenLastCalledWith({ title: "", faviconUrl: null });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("ignores a stale iframe load after replacing the requested URL", async () => {
    const onLoadSuccess = vi.fn();
    const onNavigationCommit = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <BrowserIframeViewport
        url="https://first.example/"
        onLoadSuccess={onLoadSuccess}
        onNavigationCommit={onNavigationCommit}
      />,
      { container: host },
    );

    try {
      const firstIframe = host.querySelector("iframe");
      if (!(firstIframe instanceof HTMLIFrameElement)) {
        throw new Error("Unable to find the first browser fallback iframe.");
      }
      await screen.rerender(
        <BrowserIframeViewport
          url="https://second.example/"
          onLoadSuccess={onLoadSuccess}
          onNavigationCommit={onNavigationCommit}
        />,
      );

      firstIframe.dispatchEvent(new Event("load", { bubbles: true }));

      expect(onLoadSuccess).not.toHaveBeenCalled();
      expect(onNavigationCommit).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("falls back to assigning src when reload cannot access a cross-origin frame", async () => {
    const onLoadStart = vi.fn();
    const ref = createRef<BrowserViewportRef>();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <BrowserIframeViewport
        ref={ref}
        url="https://cross-origin.example/"
        onLoadStart={onLoadStart}
      />,
      { container: host },
    );

    try {
      const iframe = host.querySelector("iframe");
      if (!(iframe instanceof HTMLIFrameElement)) {
        throw new Error("Unable to find browser fallback iframe.");
      }
      Object.defineProperty(iframe, "contentWindow", {
        value: {
          location: {
            reload: () => {
              throw new DOMException("Blocked", "SecurityError");
            },
          },
        },
      });
      ref.current?.reload();

      expect(onLoadStart).toHaveBeenCalledTimes(2);
      expect(iframe.getAttribute("src")).toBe("https://cross-origin.example/");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
