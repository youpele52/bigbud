import type { ITheme } from "@xterm/xterm";
import { TERMINAL_THEME_PALETTES, TERMINAL_THEME_SLOTS } from "./terminalThemes.catalog";
import { terminalThemeFromApp } from "./ThreadTerminalDrawer.logic";

/** Default theme name: the app-derived look bigbud has always used. */
export const BIGBUD_TERMINAL_THEME = "bigbud";

export interface TerminalThemePreference {
  readonly terminalThemeDark: string;
  readonly terminalThemeLight: string;
}

export interface TerminalThemeChoice {
  readonly name: string;
  readonly kind: "dark" | "light";
  readonly background: string;
}

function relativeLuminance(hex: string): number {
  const channel = (offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

const catalog = new Map<string, ITheme>();
const choices: TerminalThemeChoice[] = [];
for (const [name, colours] of TERMINAL_THEME_PALETTES) {
  const values = colours.split(" ");
  const theme: Record<string, string> = {};
  TERMINAL_THEME_SLOTS.forEach((slot, index) => {
    theme[slot] = values[index] ?? "";
  });
  catalog.set(name, theme as ITheme);
  const background = theme.background ?? "#000000";
  choices.push({ name, background, kind: relativeLuminance(background) > 0.5 ? "light" : "dark" });
}

/** Built-in catalog themes of one kind, sorted by name (the bigbud default is listed separately). */
export function terminalThemeChoices(kind: "dark" | "light"): ReadonlyArray<TerminalThemeChoice> {
  return choices.filter((choice) => choice.kind === kind);
}

export function isTerminalThemeName(name: string): boolean {
  return name === BIGBUD_TERMINAL_THEME || catalog.has(name);
}

/** The element whose computed colours define the app-derived theme for a mounted terminal. */
export function resolveTerminalThemeHost(mount: HTMLElement): HTMLElement {
  return (
    mount.closest<HTMLElement>(".thread-terminal-theme-host") ??
    mount.closest<HTMLElement>(".thread-terminal-drawer") ??
    mount
  );
}

/**
 * Theme for the current app appearance. Unknown names (renamed or removed themes, hand-edited
 * settings) fall back to the bigbud theme. Catalog themes keep bigbud's scrollbar styling.
 */
export function resolveTerminalTheme(
  preference: TerminalThemePreference,
  themeHost?: HTMLElement | null,
): ITheme {
  const appTheme = terminalThemeFromApp(themeHost);
  const isDark = document.documentElement.classList.contains("dark");
  const name = isDark ? preference.terminalThemeDark : preference.terminalThemeLight;
  const theme = catalog.get(name);
  if (!theme) return appTheme;
  const {
    scrollbarSliderBackground,
    scrollbarSliderHoverBackground,
    scrollbarSliderActiveBackground,
  } = appTheme;
  return {
    ...(scrollbarSliderBackground ? { scrollbarSliderBackground } : {}),
    ...(scrollbarSliderHoverBackground ? { scrollbarSliderHoverBackground } : {}),
    ...(scrollbarSliderActiveBackground ? { scrollbarSliderActiveBackground } : {}),
    ...theme,
  };
}
