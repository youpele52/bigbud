import { ThreadId } from "@bigbud/contracts";
import {
  closeThreadTerminal,
  createDefaultThreadTerminalState,
  type ThreadTerminalState,
} from "./helpers.store";
import type { TerminalStateStoreState } from "./terminal.store.types";
import { resetClosedTerminalLayout } from "./terminal.store.layout";

/** Older saved entries also carry a `replacementId`; it is ignored (no replacement pane). */
export type DismissedTerminalPanes = Record<string, { threadId: string; terminalId: string }>;
export const dismissedPaneKey = (threadId: string, terminalId: string) =>
  JSON.stringify([threadId, terminalId]);

/** Presentation only: do not retire identity, forget launch bindings, release leases or close RPC. */
export function excludeDismissedPanes(
  state: Pick<TerminalStateStoreState, "dismissedTerminalPanes">,
  threadId: string,
  pane: ThreadTerminalState,
): ThreadTerminalState {
  let next = pane;
  for (const entry of Object.values(state.dismissedTerminalPanes ?? {})) {
    if (entry.threadId !== threadId || !next.terminalIds.includes(entry.terminalId)) continue;
    // Dismissing the last pane leaves the surface empty: no replacement terminal is created.
    next =
      next.terminalIds.length === 1
        ? { ...createDefaultThreadTerminalState(), terminalHeight: next.terminalHeight }
        : closeThreadTerminal(next, entry.terminalId);
  }
  return next;
}

export function dismissTerminalPaneInState(
  state: TerminalStateStoreState,
  threadId: ThreadId,
  terminalId: string,
): Partial<TerminalStateStoreState> {
  const dismissedTerminalPanes = {
    ...state.dismissedTerminalPanes,
    [dismissedPaneKey(threadId, terminalId)]: { threadId, terminalId },
  };
  const next = { ...state, dismissedTerminalPanes };
  const drawer = state.terminalStateByThreadId[threadId];
  const panel = state.panelTerminalStateByThreadId[threadId];
  const terminalStateByThreadId: TerminalStateStoreState["terminalStateByThreadId"] = {
    ...state.terminalStateByThreadId,
    ...(drawer ? { [threadId]: excludeDismissedPanes(next, threadId, drawer) } : {}),
  };
  const panelTerminalStateByThreadId: TerminalStateStoreState["panelTerminalStateByThreadId"] = {
    ...state.panelTerminalStateByThreadId,
    ...(panel ? { [threadId]: excludeDismissedPanes(next, threadId, panel) } : {}),
  };
  return {
    dismissedTerminalPanes,
    terminalStateByThreadId,
    panelTerminalStateByThreadId,
    ...resetClosedTerminalLayout(state, threadId, drawer, terminalStateByThreadId[threadId]),
  };
}
