import { useEffect } from "react";

import { isTerminalFocused } from "~/lib/terminalFocus";
import { resolveShortcutCommand } from "~/models/keybindings";
import { useServerKeybindings } from "~/rpc/serverState";

import { closeActiveRightPanelTab } from "./rightPanel.closeActiveTab";

export function useRightPanelCloseTabShortcut(): void {
  const keybindings = useServerKeybindings();

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
        },
      });

      if (command !== "rightPanel.closeTab") return;

      event.preventDefault();
      event.stopPropagation();
      closeActiveRightPanelTab();
    };

    window.addEventListener("keydown", onWindowKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, { capture: true });
    };
  }, [keybindings]);
}
