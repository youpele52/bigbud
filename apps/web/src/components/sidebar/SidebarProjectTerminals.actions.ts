import type { ThreadId } from "@bigbud/contracts";

import { readNativeApi } from "../../rpc/nativeApi";
import { useTerminalStateStore } from "../../stores/terminal";
import { isTerminalBusy, requestTerminalClose } from "../terminal/terminalCloseGuard";
import { closeTerminalConfirmed } from "../terminal/terminalLifecycle.operations";
import { useTerminalCloseConfirmationStore } from "../../stores/terminal/terminalCloseConfirmation.store";
import { useTerminalLivenessStore } from "../../stores/terminal/terminalLiveness.store";
import { toastManager } from "../ui/toast";

interface TerminalTarget {
  readonly threadId: ThreadId;
  readonly terminalId: string;
  /** Fallback only; the pane's own launch target is authoritative. */
  readonly executionTargetId?: string | undefined;
}

/** The confirmed server close, then the pane leaves whichever surface holds it. */
function closeNow(target: TerminalTarget): void {
  const api = readNativeApi();
  if (!api) return;
  void closeTerminalConfirmed({
    api,
    threadId: target.threadId,
    terminalId: target.terminalId,
    executionTargetId: target.executionTargetId,
    onConfirmed: () => {
      const store = useTerminalStateStore.getState();
      store.closeTerminal(target.threadId, target.terminalId);
      store.closePanelTerminal(target.threadId, target.terminalId);
    },
  });
}

/** Close from the project list: asks first when the terminal is busy. */
export function closeProjectTerminal(target: TerminalTarget): void {
  requestTerminalClose({
    threadId: target.threadId,
    terminalId: target.terminalId,
    close: () => closeNow(target),
  });
}

/**
 * "Close idle": closes each at once. A terminal that turned busy since the list rendered is
 * skipped rather than prompted, so one bulk action never stacks several confirmations.
 */
export function closeIdleProjectTerminals(targets: ReadonlyArray<TerminalTarget>): void {
  for (const target of targets)
    if (!isTerminalBusy(target.threadId, target.terminalId)) closeNow(target);
}

/**
 * "Close all": always asks once for the whole batch, naming the terminals still running, then
 * closes each without a per-terminal prompt.
 */
export function closeAllProjectTerminals(
  targets: ReadonlyArray<TerminalTarget>,
  busyLabels: ReadonlyArray<string>,
): void {
  if (targets.length === 0) return;
  const count = targets.length;
  const noun = count === 1 ? "terminal" : "terminals";
  const running =
    busyLabels.length === 0
      ? "None are running a process."
      : `${busyLabels.length} ${busyLabels.length === 1 ? "is" : "are"} still running (${busyLabels.join(", ")}).`;
  useTerminalCloseConfirmationStore.getState().request({
    title: `Close all ${count} ${noun}?`,
    description: `${running} Closing stops them and deletes their history.`,
    confirmLabel: "Close all",
    watch: null,
    close: () => {
      // Skip terminals that ended while the dialog was open; there is nothing left to close.
      const live = useTerminalLivenessStore.getState().byThreadId;
      for (const target of targets)
        if (live[target.threadId]?.[target.terminalId] !== undefined) closeNow(target);
    },
  });
}

/** Cancel a pending idle close, as the idle-warning toast's "Keep open" does. */
export async function keepProjectTerminalOpen(target: TerminalTarget): Promise<void> {
  const keepOpen = readNativeApi()?.terminal.keepOpen;
  if (!keepOpen) return;
  try {
    await keepOpen({ threadId: target.threadId, terminalId: target.terminalId });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Could not keep the terminal open",
      description: error instanceof Error ? error.message : "Try again.",
    });
  }
}
