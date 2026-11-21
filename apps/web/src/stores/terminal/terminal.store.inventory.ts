import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { ThreadId } from "@bigbud/contracts";

import {
  closeThreadTerminal,
  terminalEventBufferKey,
  updateTerminalStateByThreadId,
  type ThreadTerminalState,
} from "./helpers.store";
import { removeTerminalTransientState } from "./terminal.store.cleanup";
import { removeTerminalLayouts } from "./terminal.store.layout";
import { removeTerminalProfileLaunches } from "./terminal.store.profileLaunch";
import type { TerminalStateStoreState } from "./terminal.store.types";

type SurfaceStates = Record<ThreadId, ThreadTerminalState>;

/** Latest authoritative inventory, so a later rehydrate can drop dead restored panes at once. */
let latestTerminalInventory: TerminalSessionInventory | null = null;

export function rememberTerminalInventory(inventory: TerminalSessionInventory | null): void {
  latestTerminalInventory = inventory;
}

export function readLatestTerminalInventory(): TerminalSessionInventory | null {
  return latestTerminalInventory;
}

/** Live keys in the inventory plus panes already observed after its boundary. */
function presentTerminalKeys(
  state: Pick<TerminalStateStoreState, "terminalAgentVersionByKey" | "terminalEventEntriesByKey">,
  inventory: TerminalSessionInventory,
): Set<string> {
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
  return present;
}

/** Restored panes are never respawned: drop those the host no longer has. */
function pruneAbsentRestoredPanes(
  byThreadId: SurfaceStates,
  present: Set<string>,
  removed: Set<string>,
): SurfaceStates {
  let next = byThreadId;
  for (const [id, terminal] of Object.entries(byThreadId)) {
    const threadId = ThreadId.makeUnsafe(id);
    const absent = (terminal.restoredTerminalIds ?? []).filter(
      (terminalId) => !present.has(terminalEventBufferKey(threadId, terminalId)),
    );
    if (absent.length === 0) continue;
    for (const terminalId of absent) removed.add(terminalEventBufferKey(threadId, terminalId));
    next = updateTerminalStateByThreadId(next, threadId, (current) =>
      absent.reduce(closeThreadTerminal, current),
    );
  }
  return next;
}

/**
 * Drops restored panes absent from `inventory`. Used for the first authoritative inventory after
 * hydration, and by a rehydrate that follows an inventory.
 */
export function pruneRestoredPanesForInventory(
  state: TerminalStateStoreState,
  inventory: TerminalSessionInventory,
): Partial<TerminalStateStoreState> {
  const present = presentTerminalKeys(state, inventory);
  const removed = new Set<string>();
  const terminalStateByThreadId = pruneAbsentRestoredPanes(
    state.terminalStateByThreadId,
    present,
    removed,
  );
  const panelTerminalStateByThreadId = pruneAbsentRestoredPanes(
    state.panelTerminalStateByThreadId,
    present,
    removed,
  );
  if (removed.size === 0) return { restoredPanesAwaitingInventory: false };
  return {
    restoredPanesAwaitingInventory: false,
    terminalStateByThreadId,
    panelTerminalStateByThreadId,
    ...removeTerminalProfileLaunches(state, (threadId, terminalId) =>
      removed.has(terminalEventBufferKey(ThreadId.makeUnsafe(threadId), terminalId)),
    ),
    ...removeTerminalLayouts(
      state,
      (id) =>
        state.terminalStateByThreadId[id as ThreadId]?.terminalOpen === true &&
        terminalStateByThreadId[id as ThreadId]?.terminalOpen !== true,
    ),
  };
}

/**
 * Absence clears observations, not user-created panes or process lifecycle. No synthetic exit is
 * recorded. The first inventory after hydration also drops absent restored panes.
 */
export function reconcileTerminalInventory(
  state: TerminalStateStoreState,
  inventory: TerminalSessionInventory,
): Partial<TerminalStateStoreState> {
  const pruned = state.restoredPanesAwaitingInventory
    ? { ...state, ...pruneRestoredPanesForInventory(state, inventory) }
    : state;
  const present = presentTerminalKeys(pruned, inventory);
  const reconcileActivity = (byThreadId: SurfaceStates) => {
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
  const terminalStateByThreadId = reconcileActivity(pruned.terminalStateByThreadId);
  const panelTerminalStateByThreadId = reconcileActivity(pruned.panelTerminalStateByThreadId);
  const transient = removeTerminalTransientState(pruned, (key) => !present.has(key));
  if (
    pruned === state &&
    terminalStateByThreadId === state.terminalStateByThreadId &&
    panelTerminalStateByThreadId === state.panelTerminalStateByThreadId &&
    !transient.removed
  )
    return state;
  return {
    ...(pruned === state
      ? {}
      : {
          restoredPanesAwaitingInventory: false,
          terminalProfileLaunches: pruned.terminalProfileLaunches,
          terminalLayoutByThreadId: pruned.terminalLayoutByThreadId,
        }),
    terminalStateByThreadId,
    panelTerminalStateByThreadId,
    ...transient.state,
  };
}
