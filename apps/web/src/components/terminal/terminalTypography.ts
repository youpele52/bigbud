import { type TerminalFontFamily } from "@bigbud/contracts/core/settings.ts";

export const SYSTEM_TERMINAL_FONT_FAMILY =
  '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

/** Bundled font names are shared by CSS font loading and xterm configuration. */
export function bundledTerminalFontFromSettings(fontFamily: TerminalFontFamily): string | null {
  switch (fontFamily) {
    case "jetbrains-mono-nerd-font":
      return "JetBrainsMono Nerd Font Mono";
    case "meslo-nerd-font-mono":
      return "MesloLGL Nerd Font Mono";
    case "system-monospace":
      return null;
  }
}

export function terminalFontFamilyFromSettings(fontFamily: TerminalFontFamily): string {
  const bundled = bundledTerminalFontFromSettings(fontFamily);
  return bundled
    ? `"${bundled}", "Symbols Nerd Font Mono", ${SYSTEM_TERMINAL_FONT_FAMILY}`
    : SYSTEM_TERMINAL_FONT_FAMILY;
}

/** Preserve legacy spacing while giving the new default a compact character grid. */
export function terminalLineHeightFromSettings(fontFamily: TerminalFontFamily): number {
  return fontFamily === "jetbrains-mono-nerd-font" ? 1 : 1.2;
}
