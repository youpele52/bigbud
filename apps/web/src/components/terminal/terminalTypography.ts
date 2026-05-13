import { type TerminalFontFamily } from "@bigbud/contracts/settings";

export function terminalFontFamilyFromSettings(fontFamily: TerminalFontFamily): string {
  if (fontFamily === "system-monospace") {
    return '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';
  }

  return '"MesloLGL Nerd Font Mono", "Symbols Nerd Font Mono", "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';
}
