import { useEffect, type MutableRefObject, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import {
  resolveTerminalTheme,
  resolveTerminalThemeHost,
  usesTranslucentTerminalBackground,
} from "./terminalThemes";
import { onReducedTransparencyChange } from "./terminalThemes.translucent";

/**
 * Applies the terminal theme in place: on app appearance changes (class/style/window material on
 * <html>, Reduce transparency) and on theme setting changes. Never recreates xterm or the PTY.
 * xterm answers OSC 10/11 colour queries from this theme, so TUIs see the colours actually rendered.
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
      const preference = { terminalThemeDark, terminalThemeLight };
      // Set before the theme so a transparent background is never rendered without it.
      const allowTransparency = usesTranslucentTerminalBackground(preference);
      if (terminal.options.allowTransparency !== allowTransparency) {
        terminal.options.allowTransparency = allowTransparency;
      }
      terminal.options.theme = resolveTerminalTheme(preference, resolveTerminalThemeHost(mount));
      terminal.refresh(0, terminal.rows - 1);
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-window-material"],
    });
    const unsubscribeReducedTransparency = onReducedTransparencyChange(apply);
    return () => {
      observer.disconnect();
      unsubscribeReducedTransparency();
    };
  }, [terminalRef, containerRef, terminalThemeDark, terminalThemeLight]);
}
