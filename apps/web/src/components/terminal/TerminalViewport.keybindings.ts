import { type Terminal } from "@xterm/xterm";
import { useEffect } from "react";
import {
  isTerminalClearShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
} from "../../models/keybindings";
import { readNativeApi } from "../../rpc/nativeApi";
import { writeSystemMessage } from "./ThreadTerminalDrawer.logic";

export interface UseTerminalKeybindingsProps {
  terminalRef: React.MutableRefObject<Terminal | null>;
  threadId: string;
  terminalId: string;
}

/**
 * Hook that attaches keyboard event handlers to the terminal for:
 * - Navigation shortcuts (cursor movement)
 * - Delete shortcuts (backspace, word delete)
 * - Clear terminal shortcut (Ctrl+L)
 */
export function useTerminalKeybindings({
  terminalRef,
  threadId,
  terminalId,
}: UseTerminalKeybindingsProps): void {
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const api = readNativeApi();
    if (!api) return;

    const sendTerminalInput = async (data: string, fallbackError: string) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      try {
        await api.terminal.write({ threadId, terminalId, data });
      } catch (error) {
        writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallbackError);
      }
    };

    terminal.attachCustomKeyEventHandler((event) => {
      const navigationData = terminalNavigationShortcutData(event);
      if (navigationData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(navigationData, "Failed to move cursor");
        return false;
      }

      const deleteData = terminalDeleteShortcutData(event);
      if (deleteData !== null) {
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput(deleteData, "Failed to delete terminal input");
        return false;
      }

      if (!isTerminalClearShortcut(event)) return true;
      event.preventDefault();
      event.stopPropagation();
      void sendTerminalInput("\u000c", "Failed to clear terminal");
      return false;
    });
  }, [threadId, terminalId, terminalRef]);
}
