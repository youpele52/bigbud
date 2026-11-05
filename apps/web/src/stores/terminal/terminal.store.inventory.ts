import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { ThreadId } from "@bigbud/contracts";

import { terminalEventBufferKey, type ThreadTerminalState } from "./helpers.store";
import { removeTerminalTransientState } from "./terminal.store.cleanup";
import type { TerminalStateStoreState } from "./terminal.store.types";

/** Absence clears observations, not panes or process lifecycle. No synthetic exit is recorded. */
export function reconcileTerminalInventory(
  state: TerminalStateStoreState,
  inventory: TerminalSessionInventory,
): Partial<TerminalStateStoreState> {
  const present = new Set(
    inventory.sessions.map(({ threadId, terminalId }) =>
      terminalEventBufferKey(ThreadId.makeUnsafe(threadId), terminalId),
    ),
  );
  // A mounted stream/snapshot may already have observed a start after this inventory's boundary.
  for (const [key, version] of Object.entries(state.terminalAgentVersionByKey)) {
    if (version.updatedAt > inventory.createdAt) present.add(key);
  }
  for (const [key, entries] of Object.entries(state.terminalEventEntriesByKey)) {
    if (entries.some(({ event }) => event.createdAt > inventory.createdAt)) present.add(key);
  }
  const reconcileActivity = (byThreadId: Record<ThreadId, ThreadTerminalState>) => {
    let next = byThreadId;
    for (const [id, terminal] of Object.entries(byThreadId)) {
      const threadId = ThreadId.makeUnsafe(id);
      const runningTerminalIds = terminal.runningTerminalIds.filter((terminalId) =>
        present.has(terminalEventBufferKey(threadId, terminalId)),
      );
      if (runningTerminalIds.length === terminal.runningTerminalIds.length) continue;
      if (next === byThreadId) next = { ...byThreadId };
      next[threadId] = { ...terminal, runningTerminalIds };
    }
    return next;
  };
  const terminalStateByThreadId = reconcileActivity(state.terminalStateByThreadId);
  const panelTerminalStateByThreadId = reconcileActivity(state.panelTerminalStateByThreadId);
  const transient = removeTerminalTransientState(state, (key) => !present.has(key));
  if (
    terminalStateByThreadId === state.terminalStateByThreadId &&
    panelTerminalStateByThreadId === state.panelTerminalStateByThreadId &&
    !transient.removed
  )
    return state;
  return { terminalStateByThreadId, panelTerminalStateByThreadId, ...transient.state };
}
