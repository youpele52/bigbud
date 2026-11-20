import { useEffect } from "react";

import {
  focusActiveBrowserLocation,
  focusContextualChatTarget,
  hasOpenChatModal,
} from "~/lib/chatFocus";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { resolveShortcutCommand } from "~/models/keybindings";
import { useServerKeybindings } from "~/rpc/serverState";
import { useCommandPaletteStore } from "~/stores/ui";

const FOCUS_BROWSER_LOCATION_ACTION = "focus-browser-location";

export function ChatFocusShortcutCoordinator() {
  const keybindings = useServerKeybindings();
  const commandPaletteOpen = useCommandPaletteStore((state) => state.open);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || commandPaletteOpen || hasOpenChatModal()) return;

      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused() },
      });
      if (command !== "chat.focus" || !focusContextualChatTarget()) return;

      event.preventDefault();
      event.stopPropagation();
    };

    const onMenuAction = window.desktopBridge?.onMenuAction;
    const unsubscribe =
      typeof onMenuAction === "function"
        ? onMenuAction((action) => {
            if (
              action === FOCUS_BROWSER_LOCATION_ACTION &&
              !commandPaletteOpen &&
              !hasOpenChatModal()
            ) {
              focusActiveBrowserLocation();
            }
          })
        : undefined;

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      unsubscribe?.();
    };
  }, [commandPaletteOpen, keybindings]);

  return null;
}
