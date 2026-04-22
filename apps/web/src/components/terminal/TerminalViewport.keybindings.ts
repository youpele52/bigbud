import { type Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import type { ResolvedKeybindingsConfig } from "@bigbud/contracts";
import {
  isDiffToggleShortcut,
  isTerminalClearShortcut,
  isTerminalCloseShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  isTerminalToggleShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
} from "../../models/keybindings";
import { readNativeApi } from "../../rpc/nativeApi";
import { writeSystemMessage } from "./ThreadTerminalDrawer.logic";

export interface UseTerminalKeybindingsProps {
  terminalRef: React.MutableRefObject<Terminal | null>;
  threadId: string;
  terminalId: string;
  keybindings: ResolvedKeybindingsConfig;
}

/**
 * Hook that attaches keyboard event handlers to the terminal for:
 * - Global app shortcuts (bypass xterm so they reach the app layer)
 * - Navigation shortcuts (cursor movement)
 * - Delete shortcuts (backspace, word delete)
 * - Clear terminal shortcut (Ctrl+L)
 */
export function useTerminalKeybindings({
  terminalRef,
  threadId,
  terminalId,
  keybindings,
}: UseTerminalKeybindingsProps): void {
  const keybindingsRef = useRef(keybindings);

  useEffect(() => {
    keybindingsRef.current = keybindings;
  }, [keybindings]);

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
      // Let global app shortcuts pass through xterm so the app layer handles them.
      const currentKeybindings = keybindingsRef.current;
      const options = { context: { terminalFocus: true, terminalOpen: true } };
      if (
        isTerminalToggleShortcut(event, currentKeybindings, options) ||
        isTerminalSplitShortcut(event, currentKeybindings, options) ||
        isTerminalNewShortcut(event, currentKeybindings, options) ||
        isTerminalCloseShortcut(event, currentKeybindings, options) ||
        isDiffToggleShortcut(event, currentKeybindings, options)
      ) {
        return false;
      }

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
