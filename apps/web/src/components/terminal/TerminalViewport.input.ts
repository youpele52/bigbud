import type { Terminal } from "@xterm/xterm";
import type { MutableRefObject } from "react";
import type { NativeApi, ResolvedKeybindingsConfig } from "@bigbud/contracts";
import { useTerminalStateStore } from "../../stores/terminal/terminal.store";
import { TerminalInputQueue } from "./TerminalInputQueue";
import { attachTerminalKeybindings } from "./TerminalViewport.keybindings";
import { attachTerminalMouseWheelMultiplier } from "./TerminalViewport.wheel";

export interface AttachTerminalViewportInputOptions {
  readonly terminal: Terminal;
  readonly terminalRef: MutableRefObject<Terminal | null>;
  readonly threadId: string;
  readonly terminalId: string;
  readonly keybindingsRef: MutableRefObject<ResolvedKeybindingsConfig>;
  readonly api: NativeApi;
  readonly acceptsInput: () => boolean;
  readonly markInput: () => void;
  readonly writeNotice: (terminal: Terminal, message: string) => void;
  /** Mouse reports per resolved wheel row while a full-screen TUI tracks the mouse. */
  readonly tuiWheelMultiplier: () => number;
  readonly onFind: () => void;
}

/**
 * Every byte the view sends to the PTY (typing, paste, TUI wheel reports, shortcut sequences)
 * flows through one ordered queue: one write in flight, the rest coalesced (Orca's input path).
 */
export function attachTerminalViewportInput(options: AttachTerminalViewportInputOptions) {
  const { terminal, api, threadId, terminalId } = options;
  const queue = new TerminalInputQueue(
    (data) => api.terminal.write({ threadId, terminalId, data }),
    (error) => {
      if (options.acceptsInput())
        options.writeNotice(
          terminal,
          error instanceof Error ? error.message : "Terminal write failed",
        );
    },
  );
  const send = (data: string) => {
    if (!options.acceptsInput()) return;
    if (data.length > 0)
      useTerminalStateStore.getState().markTerminalAgentActive(threadId, terminalId);
    options.markInput();
    queue.enqueue(data);
  };
  const dataDisposable = terminal.onData(send);
  attachTerminalMouseWheelMultiplier(terminal, {
    getTuiMouseWheelMultiplier: options.tuiWheelMultiplier,
  });
  attachTerminalKeybindings({
    terminal,
    terminalRef: options.terminalRef,
    threadId,
    terminalId,
    keybindingsRef: options.keybindingsRef,
    api,
    acceptsInput: options.acceptsInput,
    writeNotice: options.writeNotice,
    sendInput: send,
    onFind: options.onFind,
  });
  return {
    dispose: () => {
      dataDisposable.dispose();
      queue.dispose();
    },
  };
}
