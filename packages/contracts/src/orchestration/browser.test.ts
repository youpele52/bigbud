import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { BrowserAction } from "./browser";

const decodeBrowserAction = Schema.decodeUnknownSync(BrowserAction);

describe("BrowserAction", () => {
  it("decodes in-app browser navigation without a desktop surface", () => {
    expect(
      decodeBrowserAction({
        action: "navigate",
        url: "https://example.com",
        captureAfter: true,
      }),
    ).toEqual({
      action: "navigate",
      url: "https://example.com",
      captureAfter: true,
    });
  });

  it("does not expose a desktop surface in decoded browser actions", () => {
    expect(decodeBrowserAction({ action: "capture", surface: "browser" })).toEqual({
      action: "capture",
    });
  });

  it("decodes a read-only page-text action", () => {
    expect(decodeBrowserAction({ action: "get_page_text" })).toEqual({
      action: "get_page_text",
    });
  });

  it("decodes a visible browser navigation target", () => {
    expect(
      decodeBrowserAction({
        action: "navigate",
        target: "visible",
        url: "https://example.com",
      }),
    ).toEqual({
      action: "navigate",
      target: "visible",
      url: "https://example.com",
    });
  });

  it("requires a tab id when closing a browser tab", () => {
    expect(decodeBrowserAction({ action: "close_tab", tabId: "browser:agent-tab" })).toEqual({
      action: "close_tab",
      tabId: "browser:agent-tab",
    });
    expect(() => decodeBrowserAction({ action: "close_tab" })).toThrow();
  });
});
