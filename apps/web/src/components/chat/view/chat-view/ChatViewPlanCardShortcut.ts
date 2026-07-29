import type { ResolvedKeybindingsConfig } from "@bigbud/contracts";
import { useEffect } from "react";

import { isTerminalFocused } from "~/lib/terminalFocus";
import { resolveShortcutCommand } from "~/models/keybindings";

interface UsePlanCardToggleShortcutInput {
  enabled: boolean;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  togglePlanCard: () => void;
}

export function usePlanCardToggleShortcut({
  enabled,
  keybindings,
  terminalOpen,
  togglePlanCard,
}: UsePlanCardToggleShortcutInput): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        resolveShortcutCommand(event, keybindings, {
          context: { terminalFocus: isTerminalFocused(), terminalOpen },
        }) !== "planCard.toggle"
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      togglePlanCard();
    };

    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
  }, [enabled, keybindings, terminalOpen, togglePlanCard]);
}
