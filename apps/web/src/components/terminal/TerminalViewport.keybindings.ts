import { type Terminal } from "@xterm/xterm";
import { useRef, type MutableRefObject } from "react";
import type { NativeApi, ResolvedKeybindingsConfig } from "@bigbud/contracts";
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
import { writeSystemMessage } from "./ThreadTerminalDrawer.logic";

export interface UseTerminalKeybindingsProps {
  keybindings: ResolvedKeybindingsConfig;
}

interface AttachTerminalKeybindingsInput {
  readonly terminal: Terminal;
  readonly terminalRef: MutableRefObject<Terminal | null>;
  readonly threadId: string;
  readonly terminalId: string;
  readonly keybindingsRef: MutableRefObject<ResolvedKeybindingsConfig>;
  readonly api: NativeApi;
}

interface TerminalKeyEventHandlerInput extends Omit<AttachTerminalKeybindingsInput, "terminal"> {
  readonly terminal: Pick<Terminal, "input">;
}

/** Keep changing keybinding configuration available to the terminal session. */
export function useTerminalKeybindings({
  keybindings,
}: UseTerminalKeybindingsProps): MutableRefObject<ResolvedKeybindingsConfig> {
  const keybindingsRef = useRef(keybindings);
  keybindingsRef.current = keybindings;
  return keybindingsRef;
}

function isExactShiftEnter(event: KeyboardEvent): boolean {
  return (
    event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
  );
}

function suppressShiftEnter(event: KeyboardEvent, terminal: Pick<Terminal, "input">): boolean {
  if (!isExactShiftEnter(event) || event.isComposing || event.keyCode === 229) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  if (event.type === "keydown") {
    terminal.input("\u000a", true);
  }
  return true;
}

export function createTerminalKeyEventHandler({
  terminal,
  terminalRef,
  threadId,
  terminalId,
  keybindingsRef,
  api,
}: TerminalKeyEventHandlerInput): (event: KeyboardEvent) => boolean {
  const sendTerminalInput = async (data: string, fallbackError: string) => {
    const activeTerminal = terminalRef.current;
    if (!activeTerminal) return;
    try {
      await api.terminal.write({ threadId, terminalId, data });
    } catch (error) {
      writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallbackError);
    }
  };

  return (event) => {
    if (suppressShiftEnter(event, terminal)) {
      return false;
    }

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
  };
}

export function attachTerminalKeybindings(input: AttachTerminalKeybindingsInput): void {
  input.terminal.attachCustomKeyEventHandler(createTerminalKeyEventHandler(input));
}
