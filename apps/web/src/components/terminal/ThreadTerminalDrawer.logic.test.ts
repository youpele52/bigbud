import { describe, expect, it } from "vitest";

import { resolveTerminalThemeBaseColors } from "./ThreadTerminalDrawer.logic";

describe("resolveTerminalThemeBaseColors", () => {
  it("falls back to an opaque light terminal background when the shell body is transparent", () => {
    expect(
      resolveTerminalThemeBaseColors({
        isDark: false,
        surfaceBackgroundColor: "transparent",
        surfaceForegroundColor: "rgb(28, 33, 41)",
      }),
    ).toEqual({
      background: "rgb(255, 255, 255)",
      foreground: "rgb(28, 33, 41)",
    });
  });

  it("falls back to an opaque dark terminal background when the shell body is transparent", () => {
    expect(
      resolveTerminalThemeBaseColors({
        isDark: true,
        surfaceBackgroundColor: "rgba(0, 0, 0, 0)",
        surfaceForegroundColor: "rgb(237, 241, 247)",
      }),
    ).toEqual({
      background: "rgb(14, 18, 24)",
      foreground: "rgb(237, 241, 247)",
    });
  });

  it("preserves an opaque light body background when one is present", () => {
    expect(
      resolveTerminalThemeBaseColors({
        isDark: false,
        surfaceBackgroundColor: "rgb(250, 250, 250)",
        surfaceForegroundColor: "rgb(20, 20, 20)",
      }),
    ).toEqual({
      background: "rgb(250, 250, 250)",
      foreground: "rgb(20, 20, 20)",
    });
  });
});
