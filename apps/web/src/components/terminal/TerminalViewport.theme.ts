import { useEffect, type MutableRefObject, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { resolveTerminalTheme, resolveTerminalThemeHost } from "./terminalThemes";

/**
 * Applies the terminal theme in place: on app appearance changes (class/style on <html>) and on
 * theme setting changes. Never recreates xterm or the PTY. xterm answers OSC 10/11 colour queries
 * from this theme, so TUIs see the colours actually rendered.
 */
export function useTerminalTheme(input: {
  terminalRef: MutableRefObject<Terminal | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  terminalThemeDark: string;
  terminalThemeLight: string;
}): void {
  const { terminalRef, containerRef, terminalThemeDark, terminalThemeLight } = input;
  useEffect(() => {
    const apply = () => {
      const terminal = terminalRef.current;
      const mount = containerRef.current;
      if (!terminal || !mount) return;
      terminal.options.theme = resolveTerminalTheme(
        { terminalThemeDark, terminalThemeLight },
        resolveTerminalThemeHost(mount),
      );
      terminal.refresh(0, terminal.rows - 1);
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    return () => observer.disconnect();
  }, [terminalRef, containerRef, terminalThemeDark, terminalThemeLight]);
}
