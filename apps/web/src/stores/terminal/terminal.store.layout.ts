import type { ThreadTerminalState } from "./helpers.store";

export type TerminalLayoutMode = "split" | "terminal-only" | "chat-only";

export interface TerminalLayoutState {
  terminalLayoutByThreadId: Record<string, TerminalLayoutMode>;
}

/** Remove saved presentation when its thread is cleared, removed, or closed. */
export function removeTerminalLayouts(
  state: TerminalLayoutState,
  shouldRemove: (threadId: string) => boolean,
): TerminalLayoutState {
  const ids = Object.keys(state.terminalLayoutByThreadId).filter(shouldRemove);
  if (ids.length === 0) return { terminalLayoutByThreadId: state.terminalLayoutByThreadId };
  const next = { ...state.terminalLayoutByThreadId };
  for (const id of ids) delete next[id];
  return { terminalLayoutByThreadId: next };
}

/** Closing the logical drawer resets presentation even while its view is unmounted. */
export function resetClosedTerminalLayout(
  state: TerminalLayoutState,
  threadId: string,
  previous: ThreadTerminalState | undefined,
  next: ThreadTerminalState | undefined,
): TerminalLayoutState {
  return previous?.terminalOpen && !next?.terminalOpen
    ? removeTerminalLayouts(state, (id) => id === threadId)
    : { terminalLayoutByThreadId: state.terminalLayoutByThreadId };
}
