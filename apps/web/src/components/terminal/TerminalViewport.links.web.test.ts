import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeApi } from "@bigbud/contracts";

const openBrowserPanelMock = vi.hoisted(() => vi.fn());

vi.mock("../../stores/browser/browserPanel.actions", () => ({
  openBrowserPanel: openBrowserPanelMock,
}));

import {
  createTerminalWebLinkHandler,
  isTerminalWebUrl,
  openTerminalWebLink,
} from "./TerminalViewport.links.web";
import { makeTerminalLinkProvider } from "./TerminalViewport.links";

const primarySingleClick = {
  altKey: false,
  button: 0,
  ctrlKey: true,
  detail: 1,
  metaKey: false,
  shiftKey: false,
};

function makeMouseEvent(overrides: Partial<MouseEvent> = {}): MouseEvent {
  return { ...primarySingleClick, ...overrides } as MouseEvent;
}

function setPlatform(platform: string) {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: platform,
  });
}

afterEach(() => {
  openBrowserPanelMock.mockReset();
  vi.unstubAllGlobals();
});

describe("terminal web links", () => {
  it("accepts only valid HTTP(S) URLs", () => {
    expect(isTerminalWebUrl("https://example.com/path")).toBe(true);
    expect(isTerminalWebUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isTerminalWebUrl("javascript:alert(1)")).toBe(false);
    expect(isTerminalWebUrl("file:///tmp/example.txt")).toBe(false);
    expect(isTerminalWebUrl("not a URL")).toBe(false);
  });

  it("routes HTTP(S) links through the browser panel without browser globals", () => {
    const confirm = vi.fn();
    const open = vi.fn();
    vi.stubGlobal("window", { confirm, open });

    expect(openTerminalWebLink(" https://example.com/path ")).toBe(true);

    expect(openBrowserPanelMock).toHaveBeenCalledWith({ url: "https://example.com/path" });
    expect(confirm).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("does not open non-HTTP(S) links", () => {
    expect(openTerminalWebLink("javascript:alert(1)")).toBe(false);
    expect(openTerminalWebLink("file:///tmp/example.txt")).toBe(false);
    expect(openBrowserPanelMock).not.toHaveBeenCalled();
  });

  it("keeps OSC 8 activation behind the exact platform modifier and click", () => {
    setPlatform("Linux");
    const handler = createTerminalWebLinkHandler();

    handler.activate(makeMouseEvent(), "https://example.com");
    handler.activate(makeMouseEvent({ ctrlKey: false }), "https://example.com/no-modifier");
    handler.activate(makeMouseEvent({ detail: 2 }), "https://example.com/double");
    handler.activate(makeMouseEvent({ button: 1 }), "https://example.com/middle");
    handler.activate(makeMouseEvent({ button: 2 }), "https://example.com/right");

    expect(openBrowserPanelMock).toHaveBeenCalledTimes(1);
    expect(openBrowserPanelMock).toHaveBeenCalledWith({ url: "https://example.com" });
  });

  it("keeps plain-text HTTP(S) links on the same browser-panel route", () => {
    setPlatform("Linux");
    const terminal = {
      buffer: {
        active: {
          getLine: (lineNumber: number) =>
            lineNumber === 0
              ? {
                  isWrapped: false,
                  translateToString: () => "visit https://example.com/plain-text",
                }
              : undefined,
        },
      },
    };
    const provider = makeTerminalLinkProvider({
      terminalRef: { current: terminal as never },
      cwd: "/tmp",
      workspaceRoot: "/tmp",
      api: {} as NativeApi,
    });
    let links: Parameters<Parameters<typeof provider.provideLinks>[1]>[0];

    provider.provideLinks(1, (providedLinks) => {
      links = providedLinks;
    });

    expect(links).toHaveLength(1);
    links?.[0]?.activate(makeMouseEvent(), "https://example.com/plain-text");
    expect(openBrowserPanelMock).toHaveBeenCalledWith({ url: "https://example.com/plain-text" });
  });
});
