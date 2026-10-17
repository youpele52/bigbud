import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { BrowserWebviewViewport } from "./BrowserPanel.viewport.webview";

describe("BrowserWebviewViewport setup", () => {
  it("leaves the webview user agent at its default", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<BrowserWebviewViewport url="" />, { container: host });

    try {
      const webview = host.querySelector("webview");
      if (!(webview instanceof HTMLElement)) {
        throw new Error("Unable to find browser webview.");
      }

      expect(webview.getAttribute("useragent")).toBeNull();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
