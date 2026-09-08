import { describe, expect, it } from "vitest";

import { isBrowserGuestFocusLocationShortcut } from "./browserGuestShortcuts";

describe("browser guest focus-location shortcut", () => {
  it("matches Cmd+L on Darwin", () => {
    expect(
      isBrowserGuestFocusLocationShortcut({ type: "keyDown", key: "l", meta: true }, "darwin"),
    ).toBe(true);
  });

  it("matches Ctrl+L on Windows and Linux", () => {
    const input = { type: "keyDown", key: "L", control: true };
    expect(isBrowserGuestFocusLocationShortcut(input, "win32")).toBe(true);
    expect(isBrowserGuestFocusLocationShortcut(input, "linux")).toBe(true);
  });

  it("rejects modified, opposite-modifier, and non-keydown input", () => {
    expect(
      isBrowserGuestFocusLocationShortcut(
        { type: "keyDown", key: "l", meta: true, control: true },
        "darwin",
      ),
    ).toBe(false);
    expect(
      isBrowserGuestFocusLocationShortcut({ type: "keyDown", key: "l", control: true }, "darwin"),
    ).toBe(false);
    expect(
      isBrowserGuestFocusLocationShortcut(
        { type: "keyDown", key: "l", control: true, shift: true },
        "linux",
      ),
    ).toBe(false);
    expect(
      isBrowserGuestFocusLocationShortcut(
        { type: "keyDown", key: "l", control: true, alt: true },
        "win32",
      ),
    ).toBe(false);
    expect(
      isBrowserGuestFocusLocationShortcut({ type: "keyUp", key: "l", control: true }, "linux"),
    ).toBe(false);
  });
});
