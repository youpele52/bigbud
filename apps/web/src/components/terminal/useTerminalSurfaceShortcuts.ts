import { useEffect, type RefObject } from "react";
import type { ResolvedKeybindingsConfig } from "@bigbud/contracts/server/keybindings.ts";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { resolveShortcutCommand } from "../../models/keybindings/keybindings.models";
import type { TerminalSplitDirection } from "../../lib/terminalSplitLayout";

/** Editing shortcuts belong to the terminal surface containing the focused xterm. */
export function useTerminalSurfaceShortcuts(input: {
  surface: RefObject<HTMLElement | null>;
  keybindings: ResolvedKeybindingsConfig;
  activeTerminalId: string;
  split: (direction?: TerminalSplitDirection) => void;
  create: () => void;
  close: (terminalId: string) => void;
}) {
  const { surface, keybindings, activeTerminalId, split, create, close } = input;
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !isTerminalFocused() ||
        !surface.current?.contains(document.activeElement)
      )
        return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: true, terminalOpen: true },
      });
      if (
        command !== "terminal.split" &&
        command !== "terminal.splitDown" &&
        command !== "terminal.new" &&
        command !== "terminal.close"
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (command === "terminal.split" || command === "terminal.splitDown") {
        split(command === "terminal.splitDown" ? "down" : "right");
      } else if (command === "terminal.new") create();
      else close(activeTerminalId);
    };
    window.addEventListener("keydown", handle, { capture: true });
    return () => window.removeEventListener("keydown", handle, { capture: true });
  }, [surface, keybindings, activeTerminalId, split, create, close]);
}
