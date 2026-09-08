import { describe, expect, it, vi } from "vitest";

import { bindBrowserNavigationPolicy, isAllowedBrowserNavigation } from "./browserNavigationPolicy";

describe("browser navigation policy", () => {
  it.each([
    ["https://example.com", true],
    ["http://example.com", true],
    ["javascript:alert(1)", false],
    ["file:///etc/passwd", false],
    ["data:text/html,blocked", false],
    ["blob:https://example.com/id", false],
    ["mailto:user@example.com", false],
    ["not a URL", false],
  ])("allows %s: %s", (url, expected) => {
    expect(isAllowedBrowserNavigation(url)).toBe(expected);
  });

  it("allows about:blank only when explicitly required for guest bootstrap", () => {
    expect(isAllowedBrowserNavigation("about:blank")).toBe(false);
    expect(isAllowedBrowserNavigation("about:blank", { allowAboutBlank: true })).toBe(true);
  });

  it("enforces top-level navigations and redirects while leaving child frames alone", () => {
    const handlers = new Map<string, (...args: any[]) => void>();
    const guestWebContents = {
      getURL: vi.fn(() => "https://example.com"),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    bindBrowserNavigationPolicy(guestWebContents as any);

    const blockedNavigation = { preventDefault: vi.fn() };
    const allowedNavigation = { preventDefault: vi.fn() };
    const blockedRedirect = { preventDefault: vi.fn() };
    const childNavigation = { preventDefault: vi.fn() };

    handlers.get("will-navigate")?.(blockedNavigation, "file:///etc/passwd", false, true);
    handlers.get("will-navigate")?.(allowedNavigation, "https://example.com/next", false, true);
    handlers.get("will-redirect")?.(blockedRedirect, "data:text/html,blocked", false, true);
    handlers.get("will-navigate")?.(childNavigation, "javascript:alert(1)", false, false);

    expect(blockedNavigation.preventDefault).toHaveBeenCalledOnce();
    expect(allowedNavigation.preventDefault).not.toHaveBeenCalled();
    expect(blockedRedirect.preventDefault).toHaveBeenCalledOnce();
    expect(childNavigation.preventDefault).not.toHaveBeenCalled();
  });

  it("allows about:blank during initial guest bootstrap", () => {
    const handlers = new Map<string, (...args: any[]) => void>();
    const guestWebContents = {
      getURL: vi.fn(() => ""),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler);
      }),
    };
    bindBrowserNavigationPolicy(guestWebContents as any);
    const event = { preventDefault: vi.fn() };

    handlers.get("will-navigate")?.(event, "about:blank", false, true);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
