import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BIGBUD_TERMINAL_THEME,
  resolveTerminalTheme,
  usesTranslucentTerminalBackground,
} from "./terminalThemes";
import { isTranslucentWindowMaterialActive } from "./terminalThemes.translucent";

const bigbud = {
  terminalThemeDark: BIGBUD_TERMINAL_THEME,
  terminalThemeLight: BIGBUD_TERMINAL_THEME,
};
const catalog = {
  terminalThemeDark: "Catppuccin Macchiato",
  terminalThemeLight: "Catppuccin Latte",
};

function stubWindow(options: { material: "solid" | "translucent"; reducedTransparency?: boolean }) {
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: "",
    getImageData: () => ({ data: [12, 34, 56, 255] }),
  };
  vi.stubGlobal("document", {
    documentElement: {
      classList: { contains: (name: string) => name === "dark" },
      dataset: { desktopShell: "macos", windowMaterial: options.material },
    },
    body: {},
    createElement: (tag: string) =>
      tag === "canvas"
        ? { width: 0, height: 0, getContext: () => context }
        : { style: {}, remove: vi.fn(), dataset: {} },
  });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: Boolean(options.reducedTransparency) && query.includes("reduced-transparency"),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal("getComputedStyle", (element: { dataset?: unknown }) => ({
    // The theme host is transparent while translucent; the probe resolves --background-solid.
    backgroundColor: element.dataset ? "color(srgb 0.05 0.13 0.22)" : "rgba(0, 0, 0, 0)",
    color: "rgb(237, 241, 247)",
  }));
}

const host = { append: vi.fn() } as unknown as HTMLElement;

describe("translucent terminal background", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stays opaque while the window material is solid", () => {
    stubWindow({ material: "solid" });
    expect(isTranslucentWindowMaterialActive()).toBe(false);
    expect(usesTranslucentTerminalBackground(bigbud)).toBe(false);
    expect(resolveTerminalTheme(bigbud, host).background).toBe("rgb(14, 18, 24)");
  });

  it("follows the panel with a zero-alpha background that keeps the theme RGB", () => {
    stubWindow({ material: "translucent" });
    expect(isTranslucentWindowMaterialActive()).toBe(true);
    expect(usesTranslucentTerminalBackground(bigbud)).toBe(true);
    expect(resolveTerminalTheme(bigbud, host).background).toBe("rgba(12, 34, 56, 0)");
  });

  it("lets a chosen catalog theme keep its own background", () => {
    stubWindow({ material: "translucent" });
    expect(usesTranslucentTerminalBackground(catalog)).toBe(false);
    expect(resolveTerminalTheme(catalog, host).background).toBe("#24273a");
  });

  it("falls back to opaque when Reduce transparency is on", () => {
    stubWindow({ material: "translucent", reducedTransparency: true });
    expect(isTranslucentWindowMaterialActive()).toBe(false);
    expect(usesTranslucentTerminalBackground(bigbud)).toBe(false);
  });
});
