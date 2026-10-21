import { afterEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_THEME_PALETTES, TERMINAL_THEME_SLOTS } from "./terminalThemes.catalog";
import {
  BIGBUD_TERMINAL_THEME,
  isTerminalThemeName,
  resolveTerminalTheme,
  terminalThemeChoices,
} from "./terminalThemes";

function stubAppearance(dark: boolean) {
  vi.stubGlobal("document", {
    documentElement: { classList: { contains: (name: string) => dark && name === "dark" } },
    body: {},
  });
  vi.stubGlobal("getComputedStyle", () => ({
    backgroundColor: "rgb(49, 49, 49)",
    color: "rgb(237, 241, 247)",
  }));
}

describe("terminal theme catalog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("decodes every palette into all xterm colour slots", () => {
    expect(TERMINAL_THEME_PALETTES.length).toBeGreaterThanOrEqual(30);
    const names = new Set<string>();
    for (const [name, colours] of TERMINAL_THEME_PALETTES) {
      expect(names.has(name)).toBe(false);
      names.add(name);
      const values = colours.split(" ");
      expect(values).toHaveLength(TERMINAL_THEME_SLOTS.length);
      for (const value of values) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("classifies themes by background and includes Catppuccin Macchiato", () => {
    const dark = terminalThemeChoices("dark").map((choice) => choice.name);
    const light = terminalThemeChoices("light").map((choice) => choice.name);
    expect(dark).toContain("Catppuccin Macchiato");
    expect(light).toContain("Catppuccin Latte");
    expect(dark).not.toContain("Catppuccin Latte");
    expect(isTerminalThemeName(BIGBUD_TERMINAL_THEME)).toBe(true);
    expect(isTerminalThemeName("Not A Theme")).toBe(false);
  });

  it("resolves the slot for the current appearance and keeps bigbud scrollbars", () => {
    stubAppearance(true);
    const preference = {
      terminalThemeDark: "Catppuccin Macchiato",
      terminalThemeLight: "Catppuccin Latte",
    };
    const dark = resolveTerminalTheme(preference);
    expect(dark.background).toBe("#24273a");
    expect(dark.foreground).toBe("#cad3f5");
    expect(dark.scrollbarSliderBackground).toBe("rgba(255, 255, 255, 0.1)");
    stubAppearance(false);
    expect(resolveTerminalTheme(preference).background).toBe("#eff1f5");
  });

  it("falls back to the app-derived theme for bigbud and unknown names", () => {
    stubAppearance(true);
    for (const name of [BIGBUD_TERMINAL_THEME, "Removed Theme"]) {
      const theme = resolveTerminalTheme({ terminalThemeDark: name, terminalThemeLight: name });
      expect(theme.background).toBe("rgb(49, 49, 49)");
    }
  });
});
