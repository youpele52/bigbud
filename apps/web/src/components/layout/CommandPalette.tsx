import { useEffect } from "react";

import { isTerminalFocused } from "../../lib/terminalFocus";
import { resolveShortcutCommand } from "../../models/keybindings";
import { useServerKeybindings } from "../../rpc/serverState";
import { selectThreadTerminalState, useTerminalStateStore } from "../../stores/terminal";
import { useCommandPaletteStore } from "../../stores/ui";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { CommandPaletteDialogContent } from "./CommandPalette.content";

interface CommandPaletteProps {
  children: React.ReactNode;
}

export function CommandPalette({ children }: CommandPaletteProps) {
  const toggleOpen = useCommandPaletteStore((store) => store.toggleOpen);
  const open = useCommandPaletteStore((store) => store.open);
  const keybindings = useServerKeybindings();
  const { routeThreadId } = useHandleNewThread();
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadId
      ? selectThreadTerminalState(state.terminalStateByThreadId, routeThreadId).terminalOpen
      : false,
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });

      if (command !== "commandPalette.toggle") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      toggleOpen();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [keybindings, terminalOpen, toggleOpen]);

  return (
    <>
      {children}
      {open ? <CommandPaletteDialogContent /> : null}
    </>
  );
}
