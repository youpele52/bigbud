import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CUA_CURSOR_THEME_ID,
  cuaDriverCursorThemeDirectory,
  cuaDriverCursorThemePath,
  cuaDriverHonoursCursorTheme,
} from "./cursorTheme";

describe("cua-driver cursor theme", () => {
  it("honours installed themes for 0.38.0 only", () => {
    expect(cuaDriverHonoursCursorTheme("0.38.0")).toBe(true);
    expect(cuaDriverHonoursCursorTheme("0.9.1")).toBe(false);
    expect(cuaDriverHonoursCursorTheme(null)).toBe(false);
    expect(cuaDriverHonoursCursorTheme(undefined)).toBe(false);
    expect(cuaDriverHonoursCursorTheme("0.38.1")).toBe(false); // unlisted: decided when pinned
  });

  it("keeps the theme store inside the private state home", () => {
    const stateHome = Path.join("/base", "runtime", "cua-driver", "home");
    expect(cuaDriverCursorThemeDirectory(stateHome)).toBe(Path.join(stateHome, "cursor-themes"));
    expect(cuaDriverCursorThemePath(stateHome)).toBe(
      Path.join(stateHome, "cursor-themes", `${CUA_CURSOR_THEME_ID}.cua-theme`),
    );
  });

  it("uses a reverse-DNS id the Driver accepts as a store filename", () => {
    // cursor-overlay `valid_theme_id`: dotted, each part [A-Za-z0-9_-]{1,63}.
    expect(CUA_CURSOR_THEME_ID).toMatch(/^[A-Za-z0-9_-]{1,63}(\.[A-Za-z0-9_-]{1,63})+$/);
  });
});
