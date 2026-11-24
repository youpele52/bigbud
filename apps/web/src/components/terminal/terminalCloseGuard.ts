import type { ThreadId } from "@bigbud/contracts";

import { useTerminalStateStore } from "../../stores/terminal";
import { useTerminalCloseConfirmationStore } from "../../stores/terminal/terminalCloseConfirmation.store";
import { useTerminalLivenessStore } from "../../stores/terminal/terminalLiveness.store";
import { terminalPaneLabel } from "./terminalPaneLabel";

/**
 * Whether the server reports a program in front of this terminal. A terminal without a liveness
 * entry is not running (exits remove the entry), so it counts as not busy.
 */
export function isTerminalBusy(threadId: string, terminalId: string): boolean {
  return useTerminalLivenessStore.getState().byThreadId[threadId]?.[terminalId]?.busy === true;
}

export interface TerminalCloseOptions {
  /** The shell already exited: its pane is removed without asking, whatever liveness says. */
  readonly exited?: boolean;
}

/** A surface's close action; the session-exit path passes `{ exited: true }`. */
export type CloseTerminalHandler = (terminalId: string, options?: TerminalCloseOptions) => void;

/**
 * Every terminal close goes through here: an idle or exited terminal closes at once, a busy one
 * asks first. `close` performs the confirmed server close.
 */
export function requestTerminalClose(input: {
  readonly threadId: ThreadId;
  readonly terminalId: string;
  readonly close: () => void;
  readonly options?: TerminalCloseOptions | undefined;
}): void {
  if (input.options?.exited || !isTerminalBusy(input.threadId, input.terminalId)) {
    input.close();
    return;
  }
  const label = terminalPaneLabel(
    useTerminalStateStore.getState(),
    input.threadId,
    input.terminalId,
  );
  useTerminalCloseConfirmationStore.getState().request({
    title: "Close running terminal?",
    description: `A process is still running in “${label}”. Closing stops it and deletes its history.`,
    confirmLabel: "Close terminal",
    watch: { threadId: input.threadId, terminalId: input.terminalId },
    close: input.close,
  });
}
