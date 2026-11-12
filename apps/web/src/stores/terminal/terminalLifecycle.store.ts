import { create } from "zustand";
import type { TerminalRestartInput } from "@bigbud/contracts/workspace/terminal.ts";
import { randomUUID } from "../../lib/utils";

export type TerminalLifecycleOperation = {
  id: string;
  kind: "close" | "restart";
  phase: "closing" | "stopping" | "starting" | "error";
  error?: string | undefined;
  canDismiss?: boolean;
  expectedGeneration?: string | undefined;
  restartRequest?: TerminalRestartInput;
};
const key = (threadId: string, terminalId: string) => JSON.stringify([threadId, terminalId]);

/** App-session state, not persisted: remounting a view cannot start a competing operation. */
export const useTerminalLifecycleStore = create<{
  operations: Record<string, TerminalLifecycleOperation>;
}>(() => ({ operations: {} }));

export function readTerminalLifecycle(threadId: string, terminalId: string) {
  return useTerminalLifecycleStore.getState().operations[key(threadId, terminalId)];
}

export function beginTerminalLifecycle(
  threadId: string,
  terminalId: string,
  kind: "close" | "restart",
) {
  const previous = readTerminalLifecycle(threadId, terminalId);
  if (previous && (previous.phase !== "error" || previous.kind !== kind)) return null;
  const operation: TerminalLifecycleOperation = {
    ...previous,
    id: previous?.id ?? randomUUID(),
    kind,
    phase: kind === "close" ? "closing" : "stopping",
    error: undefined,
    canDismiss: false,
  };
  useTerminalLifecycleStore.setState((state) => ({
    operations: { ...state.operations, [key(threadId, terminalId)]: operation },
  }));
  return operation;
}

export function updateTerminalLifecycle(
  threadId: string,
  terminalId: string,
  operation: TerminalLifecycleOperation,
  patch: Partial<TerminalLifecycleOperation>,
) {
  if (readTerminalLifecycle(threadId, terminalId)?.id !== operation.id) return;
  Object.assign(operation, patch);
  useTerminalLifecycleStore.setState((state) => ({
    operations: { ...state.operations, [key(threadId, terminalId)]: { ...operation } },
  }));
}

export function finishTerminalLifecycle(
  threadId: string,
  terminalId: string,
  operation: TerminalLifecycleOperation,
) {
  if (readTerminalLifecycle(threadId, terminalId)?.id !== operation.id) return;
  useTerminalLifecycleStore.setState((state) => {
    const operations = { ...state.operations };
    delete operations[key(threadId, terminalId)];
    return { operations };
  });
}

export function useTerminalLifecycle(threadId: string, terminalId: string) {
  return useTerminalLifecycleStore((state) => state.operations[key(threadId, terminalId)]);
}
