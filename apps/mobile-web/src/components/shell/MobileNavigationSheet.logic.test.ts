import { describe, expect, it } from "vitest";

import {
  areMobileNavigationViewsEqual,
  parseMobileNavigationView,
  sanitizeMobileBackendOrigin,
  withoutMobileNavigationView,
  withMobileNavigationView,
} from "./MobileNavigationSheet.logic";

describe("mobile navigation sheet history", () => {
  it("round-trips overlay state without changing the canonical route", () => {
    const state = withMobileNavigationView({}, { kind: "settings" });
    expect(parseMobileNavigationView(state)).toEqual({ kind: "settings" });
    expect(withoutMobileNavigationView(state)).toEqual({});
  });

  it("replaces the overlay view without changing the canonical route state", () => {
    const chats = withMobileNavigationView({}, { kind: "chats" });
    const settings = withMobileNavigationView(chats, { kind: "settings" });
    expect(parseMobileNavigationView(settings)).toEqual({ kind: "settings" });
    expect(withoutMobileNavigationView(settings)).toEqual({});
  });

  it("rejects invalid overlay metadata", () => {
    expect(parseMobileNavigationView({ mobileOverlay: { kind: "unknown" } })).toBeNull();
    expect(parseMobileNavigationView({ mobileOverlay: { kind: "project" } })).toBeNull();
  });

  it("compares route views by value for retained drawer state", () => {
    expect(areMobileNavigationViewsEqual({ kind: "chats" }, { kind: "chats" })).toBe(true);
    expect(
      areMobileNavigationViewsEqual(
        { kind: "project", projectId: "one" },
        { kind: "project", projectId: "two" },
      ),
    ).toBe(false);
    expect(areMobileNavigationViewsEqual({ kind: "settings" }, null)).toBe(false);
  });

  it("only exposes a redacted HTTP origin in settings", () => {
    expect(sanitizeMobileBackendOrigin("https://desktop.test/path?token=secret")).toBe(
      "https://desktop.test",
    );
    expect(sanitizeMobileBackendOrigin("wss://desktop.test/socket")).toBeNull();
  });
});
