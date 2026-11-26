/** Thread-level terminal state removal; the store wires these into `set`. */
import type { ThreadId } from "@bigbud/contracts";

import { createDefaultThreadTerminalState, updateTerminalStateByThreadId } from "./helpers.store";
import { removeTerminalTransientState } from "./terminal.store.cleanup";
import {
  removeOrphanedTerminalLabelOverrides,
  removeTerminalLabelOverridesForThread,
} from "./terminal.store.labels";
import { removeTerminalLayouts } from "./terminal.store.layout";
import { removeTerminalProfileLaunches } from "./terminal.store.profileLaunch";
import type { TerminalStateStoreState } from "./terminal.store.types";
import { removeOrphanedWslSelections, terminalWslSelectionPatch } from "./terminal.store.wsl";

export function clearTerminalStateInState(
  state: TerminalStateStoreState,
  threadId: ThreadId,
): Partial<TerminalStateStoreState> {
  const profiles = removeTerminalProfileLaunches(state, (id) => id === threadId);
  const layouts = removeTerminalLayouts(state, (id) => id === threadId);
  const nextTerminalStateByThreadId = updateTerminalStateByThreadId(
    state.terminalStateByThreadId,
    threadId,
    () => createDefaultThreadTerminalState(),
  );
  const nextPanelTerminalStateByThreadId = updateTerminalStateByThreadId(
    state.panelTerminalStateByThreadId,
    threadId,
    () => createDefaultThreadTerminalState(),
  );
  const hadLaunchContext = state.terminalLaunchContextByThreadId[threadId] !== undefined;
  const hadLabelOverrides = state.terminalLabelOverridesByThreadId[threadId] !== undefined;
  const { [threadId]: _removed, ...remainingLaunchContexts } =
    state.terminalLaunchContextByThreadId;
  const remainingLabelOverrides = removeTerminalLabelOverridesForThread(
    state.terminalLabelOverridesByThreadId,
    threadId,
  );
  const transient = removeTerminalTransientState(state, (key) =>
    key.startsWith(`${threadId}\u0000`),
  );
  if (
    nextTerminalStateByThreadId === state.terminalStateByThreadId &&
    nextPanelTerminalStateByThreadId === state.panelTerminalStateByThreadId &&
    !hadLaunchContext &&
    !hadLabelOverrides &&
    !transient.removed &&
    profiles.terminalProfileLaunches === state.terminalProfileLaunches &&
    layouts.terminalLayoutByThreadId === state.terminalLayoutByThreadId
  ) {
    return state;
  }
  return {
    ...layouts,
    ...profiles,
    terminalStateByThreadId: nextTerminalStateByThreadId,
    panelTerminalStateByThreadId: nextPanelTerminalStateByThreadId,
    terminalLabelOverridesByThreadId: remainingLabelOverrides,
    terminalLaunchContextByThreadId: remainingLaunchContexts,
    ...transient.state,
  };
}

export function removeTerminalStateInState(
  state: TerminalStateStoreState,
  threadId: ThreadId,
): Partial<TerminalStateStoreState> {
  const profiles = removeTerminalProfileLaunches(state, (id) => id === threadId);
  const layouts = removeTerminalLayouts(state, (id) => id === threadId);
  const hadTerminalState = state.terminalStateByThreadId[threadId] !== undefined;
  const hadPanelTerminalState = state.panelTerminalStateByThreadId[threadId] !== undefined;
  const hadLabelOverrides = state.terminalLabelOverridesByThreadId[threadId] !== undefined;
  const hadLaunchContext = state.terminalLaunchContextByThreadId[threadId] !== undefined;
  const transient = removeTerminalTransientState(state, (key) =>
    key.startsWith(`${threadId}\u0000`),
  );
  if (
    !hadTerminalState &&
    !hadPanelTerminalState &&
    !hadLabelOverrides &&
    !hadLaunchContext &&
    state.terminalWslDistributionByThreadId[threadId] === undefined &&
    !transient.removed &&
    profiles.terminalProfileLaunches === state.terminalProfileLaunches &&
    layouts.terminalLayoutByThreadId === state.terminalLayoutByThreadId
  ) {
    return state;
  }
  const nextTerminalStateByThreadId = { ...state.terminalStateByThreadId };
  delete nextTerminalStateByThreadId[threadId];
  const nextPanelTerminalStateByThreadId = { ...state.panelTerminalStateByThreadId };
  delete nextPanelTerminalStateByThreadId[threadId];
  const nextLabelOverridesByThreadId = removeTerminalLabelOverridesForThread(
    state.terminalLabelOverridesByThreadId,
    threadId,
  );
  const nextLaunchContexts = { ...state.terminalLaunchContextByThreadId };
  delete nextLaunchContexts[threadId];
  return {
    ...layouts,
    ...profiles,
    ...terminalWslSelectionPatch(state, threadId, null),
    terminalStateByThreadId: nextTerminalStateByThreadId,
    panelTerminalStateByThreadId: nextPanelTerminalStateByThreadId,
    terminalLabelOverridesByThreadId: nextLabelOverridesByThreadId,
    terminalLaunchContextByThreadId: nextLaunchContexts,
    ...transient.state,
  };
}

export function removeOrphanedTerminalStatesInState(
  state: TerminalStateStoreState,
  activeThreadIds: Set<ThreadId>,
): Partial<TerminalStateStoreState> {
  const layouts = removeTerminalLayouts(state, (id) => !activeThreadIds.has(id as ThreadId));
  const profiles = removeTerminalProfileLaunches(
    state,
    (id) => !activeThreadIds.has(id as ThreadId),
  );
  const wslSelections = removeOrphanedWslSelections(state, activeThreadIds);
  const orphanedIds = Object.keys(state.terminalStateByThreadId).filter(
    (id) => !activeThreadIds.has(id as ThreadId),
  );
  const orphanedPanelIds = Object.keys(state.panelTerminalStateByThreadId).filter(
    (id) => !activeThreadIds.has(id as ThreadId),
  );
  const orphanedLaunchContextIds = Object.keys(state.terminalLaunchContextByThreadId).filter(
    (id) => !activeThreadIds.has(id as ThreadId),
  );
  const { orphanedThreadIds: orphanedLabelOverrideIds, nextOverridesByThreadId } =
    removeOrphanedTerminalLabelOverrides(state.terminalLabelOverridesByThreadId, activeThreadIds);
  const transient = removeTerminalTransientState(state, (key) => {
    const [threadId] = key.split("\u0000");
    return Boolean(threadId && !activeThreadIds.has(threadId as ThreadId));
  });
  if (
    orphanedIds.length === 0 &&
    orphanedPanelIds.length === 0 &&
    orphanedLabelOverrideIds.length === 0 &&
    orphanedLaunchContextIds.length === 0 &&
    wslSelections.terminalWslDistributionByThreadId === state.terminalWslDistributionByThreadId &&
    !transient.removed &&
    profiles.terminalProfileLaunches === state.terminalProfileLaunches &&
    layouts.terminalLayoutByThreadId === state.terminalLayoutByThreadId
  ) {
    return state;
  }
  const next = { ...state.terminalStateByThreadId };
  for (const id of orphanedIds) {
    delete next[id as ThreadId];
  }
  const nextPanel = { ...state.panelTerminalStateByThreadId };
  for (const id of orphanedPanelIds) {
    delete nextPanel[id as ThreadId];
  }
  const nextLaunchContexts = { ...state.terminalLaunchContextByThreadId };
  for (const id of orphanedLaunchContextIds) {
    delete nextLaunchContexts[id as ThreadId];
  }
  return {
    ...layouts,
    ...profiles,
    ...wslSelections,
    terminalStateByThreadId: next,
    panelTerminalStateByThreadId: nextPanel,
    terminalLabelOverridesByThreadId: nextOverridesByThreadId,
    terminalLaunchContextByThreadId: nextLaunchContexts,
    ...transient.state,
  };
}
