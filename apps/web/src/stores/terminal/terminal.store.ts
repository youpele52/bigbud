import { excludeDismissedPanes } from "./terminal.store.dismiss";
/** Terminal UI state and action wiring; pure transitions live in helpers.store.ts. */

import { ThreadId } from "@bigbud/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  appendTerminalEventEntry,
  newThreadTerminal,
  normalizeThreadTerminalState,
  selectThreadTerminalState,
  setThreadActiveTerminal,
  setThreadTerminalActivity,
  setThreadTerminalHeight,
  setThreadTerminalOpen,
  updateTerminalStateByThreadId,
  type TerminalEventEntry,
  type ThreadTerminalLaunchContext,
  type ThreadTerminalState,
} from "./helpers.store";
import {
  applyTerminalEventToState,
  applyTerminalEventsToState,
  ensurePanelTerminalInState,
} from "./terminal.store.panel";
import { closeTerminalPaneInState } from "./terminal.store.close";
import { hydrateTerminalAgentFromSnapshot } from "./terminal.store.snapshot";
import { markTerminalAgentActive } from "./terminal.store.recentAgent";
import {
  clearTerminalLabelOverrideByThreadId,
  setTerminalLabelOverrideByThreadId,
} from "./terminal.store.labels";
import { type TerminalStateStoreState } from "./terminal.store.types";
import { resetClosedTerminalLayout } from "./terminal.store.layout";
import { terminalWslSelectionPatch } from "./terminal.store.wsl";
import { terminalPersistenceOptions } from "./terminal.store.persistence";
import { rehydrateOnBackendStorageReady } from "../../lib/backendScopedStorage";
import { reconcileTerminalInventory, rememberTerminalInventory } from "./terminal.store.inventory";
import {
  createTerminalPaneId,
  createUserTerminalPane,
  surfaceHasPanes,
} from "./terminal.store.create";
import {
  clearTerminalStateInState,
  removeOrphanedTerminalStatesInState,
  removeTerminalStateInState,
} from "./terminal.store.removal";

export type { TerminalEventEntry, ThreadTerminalLaunchContext, ThreadTerminalState };
export type { TerminalPaneOrigin } from "./helpers.store";
export {
  selectTerminalEventEntries,
  selectTerminalEventLastId,
  selectTerminalPaneOrigin,
  selectThreadSurfacePanes,
  selectThreadTerminalState,
} from "./helpers.store";

export const useTerminalStateStore = create<TerminalStateStoreState>()(
  persist((set, get) => {
    const updateTerminal = (
      threadId: ThreadId,
      updater: (state: ThreadTerminalState) => ThreadTerminalState,
    ) => {
      set((state) => {
        const nextTerminalStateByThreadId = updateTerminalStateByThreadId(
          state.terminalStateByThreadId,
          threadId,
          (pane) => excludeDismissedPanes(state, threadId, updater(pane)),
        );
        if (nextTerminalStateByThreadId === state.terminalStateByThreadId) {
          return state;
        }
        return {
          ...resetClosedTerminalLayout(
            state,
            threadId,
            state.terminalStateByThreadId[threadId],
            nextTerminalStateByThreadId[threadId],
          ),
          terminalStateByThreadId: nextTerminalStateByThreadId,
        };
      });
    };

    const updatePanelTerminal = (
      threadId: ThreadId,
      updater: (state: ThreadTerminalState) => ThreadTerminalState,
    ) => {
      set((state) => {
        const nextPanelTerminalStateByThreadId = updateTerminalStateByThreadId(
          state.panelTerminalStateByThreadId,
          threadId,
          (pane) => excludeDismissedPanes(state, threadId, updater(pane)),
        );
        if (nextPanelTerminalStateByThreadId === state.panelTerminalStateByThreadId) {
          return state;
        }
        return {
          panelTerminalStateByThreadId: nextPanelTerminalStateByThreadId,
        };
      });
    };

    return {
      terminalProfileLaunches: {},
      terminalLayoutByThreadId: {},
      setTerminalLayout: (threadId, mode) => {
        // persist writes even when set returns unchanged state: skip set entirely on warm selection.
        if (get().terminalLayoutByThreadId[threadId] === mode) return;
        set((state) => ({
          terminalLayoutByThreadId: { ...state.terminalLayoutByThreadId, [threadId]: mode },
        }));
      },
      terminalWslDistributionByThreadId: {},
      setTerminalWslDistribution: (threadId, distribution) =>
        set((state) => terminalWslSelectionPatch(state, threadId, distribution)),
      terminalStateByThreadId: {},
      panelTerminalStateByThreadId: {},
      terminalLabelOverridesByThreadId: {},
      terminalLaunchContextByThreadId: {},
      terminalEventEntriesByKey: {},
      terminalAgentProviderByKey: {},
      terminalAgentVersionByKey: {},
      terminalEventLastIdsByKey: {},
      nextTerminalEventId: 1,
      restoredPanesAwaitingInventory: false,
      setTerminalOpen: (threadId, open) => {
        // Opening an empty drawer creates one user-created pane; nothing else ever does.
        if (open && !surfaceHasPanes(get(), threadId, false)) {
          set((state) =>
            createUserTerminalPane(state, threadId, createTerminalPaneId(), false, false),
          );
          return;
        }
        updateTerminal(threadId, (state) => setThreadTerminalOpen(state, open));
      },
      setTerminalHeight: (threadId, height) =>
        updateTerminal(threadId, (state) => setThreadTerminalHeight(state, height)),
      splitTerminal: (threadId, terminalId, profile, direction) =>
        set((state) =>
          createUserTerminalPane(state, threadId, terminalId, false, true, profile, direction),
        ),
      newTerminal: (threadId, terminalId, profile) =>
        set((state) => createUserTerminalPane(state, threadId, terminalId, false, false, profile)),
      ensureTerminal: (threadId, terminalId, options) =>
        updateTerminal(threadId, (state) => {
          let nextState = state;
          const previousTerminalOpen = state.terminalOpen;
          if (!state.terminalIds.includes(terminalId)) {
            nextState = newThreadTerminal(nextState, terminalId);
            if (!options?.open) {
              nextState = { ...nextState, terminalOpen: previousTerminalOpen };
            }
          }
          if (options?.active === false) {
            nextState = {
              ...nextState,
              activeTerminalId: state.activeTerminalId,
              activeTerminalGroupId: state.activeTerminalGroupId,
            };
          }
          if (options?.active ?? true) {
            nextState = setThreadActiveTerminal(nextState, terminalId);
          }
          if (options?.open) {
            nextState = setThreadTerminalOpen(nextState, true);
          }
          return normalizeThreadTerminalState(nextState);
        }),
      setActiveTerminal: (threadId, terminalId) =>
        updateTerminal(threadId, (state) => setThreadActiveTerminal(state, terminalId)),
      closeTerminal: (threadId, terminalId) =>
        set((state) => closeTerminalPaneInState(state, threadId, terminalId, false)),
      setTerminalLabelOverride: (threadId, terminalId, label) =>
        set((state) => {
          const nextOverrides = setTerminalLabelOverrideByThreadId(
            state.terminalLabelOverridesByThreadId,
            threadId,
            terminalId,
            label,
          );
          if (!nextOverrides) {
            return state;
          }
          return { terminalLabelOverridesByThreadId: nextOverrides };
        }),
      clearTerminalLabelOverride: (threadId, terminalId) =>
        set((state) => {
          const nextOverrides = clearTerminalLabelOverrideByThreadId(
            state.terminalLabelOverridesByThreadId,
            threadId,
            terminalId,
          );
          if (!nextOverrides) {
            return state;
          }
          return { terminalLabelOverridesByThreadId: nextOverrides };
        }),
      setPanelTerminalOpen: (threadId, open) =>
        updatePanelTerminal(threadId, (state) => setThreadTerminalOpen(state, open)),
      setPanelTerminalHeight: (threadId, height) =>
        updatePanelTerminal(threadId, (state) => setThreadTerminalHeight(state, height)),
      splitPanelTerminal: (threadId, terminalId, profile, direction) =>
        set((state) =>
          createUserTerminalPane(state, threadId, terminalId, true, true, profile, direction),
        ),
      newPanelTerminal: (threadId, terminalId, profile) =>
        set((state) => createUserTerminalPane(state, threadId, terminalId, true, false, profile)),
      ensurePanelTerminal: (threadId, terminalId, options) =>
        set((state) => ensurePanelTerminalInState(state, threadId, terminalId, options)),
      setPanelActiveTerminal: (threadId, terminalId) =>
        updatePanelTerminal(threadId, (state) => setThreadActiveTerminal(state, terminalId)),
      closePanelTerminal: (threadId, terminalId) =>
        set((state) => closeTerminalPaneInState(state, threadId, terminalId, true)),
      setTerminalLaunchContext: (threadId, context) =>
        set((state) => ({
          terminalLaunchContextByThreadId: {
            ...state.terminalLaunchContextByThreadId,
            [threadId]: context,
          },
        })),
      clearTerminalLaunchContext: (threadId) =>
        set((state) => {
          if (!state.terminalLaunchContextByThreadId[threadId]) {
            return state;
          }
          const { [threadId]: _removed, ...rest } = state.terminalLaunchContextByThreadId;
          return { terminalLaunchContextByThreadId: rest };
        }),
      setTerminalActivity: (threadId, terminalId, hasRunningSubprocess) =>
        updateTerminal(threadId, (state) =>
          setThreadTerminalActivity(state, terminalId, hasRunningSubprocess),
        ),
      markTerminalAgentActive: (threadId, terminalId) => {
        const patch = markTerminalAgentActive(get(), threadId, terminalId);
        if (patch) set(patch);
      },
      recordTerminalEvent: (event) =>
        set((state) =>
          appendTerminalEventEntry(
            state.terminalEventEntriesByKey,
            state.terminalEventLastIdsByKey,
            state.nextTerminalEventId,
            event,
          ),
        ),
      applyTerminalEvent: (event) => set((state) => applyTerminalEventToState(state, event)),
      applyTerminalEvents: (events) => set((state) => applyTerminalEventsToState(state, events)),
      reconcileTerminalInventory: (inventory) => {
        rememberTerminalInventory(inventory);
        set((state) => reconcileTerminalInventory(state, inventory));
      },
      hydrateTerminalAgentFromSnapshot: (snapshot) =>
        set((state) => hydrateTerminalAgentFromSnapshot(state, snapshot)),
      clearTerminalState: (threadId) => set((state) => clearTerminalStateInState(state, threadId)),
      removeTerminalState: (threadId) =>
        set((state) => removeTerminalStateInState(state, threadId)),
      removeOrphanedTerminalStates: (activeThreadIds) =>
        set((state) => removeOrphanedTerminalStatesInState(state, activeThreadIds)),
    };
  }, terminalPersistenceOptions),
);
rehydrateOnBackendStorageReady(useTerminalStateStore);
