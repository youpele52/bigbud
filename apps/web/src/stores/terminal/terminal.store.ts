/**
 * Single Zustand store for terminal UI state keyed by threadId.
 *
 * State helpers (pure functions) live in terminalStateStore.helpers.ts.
 * This file contains only the store creation and action wiring.
 */

import { ThreadId } from "@bigbud/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "../../lib/storage";
import {
  appendTerminalEventEntry,
  selectTerminalEventLastId,
  createDefaultThreadTerminalState,
  newThreadTerminal,
  normalizeThreadTerminalState,
  selectThreadTerminalState,
  setThreadActiveTerminal,
  setThreadTerminalActivity,
  setThreadTerminalHeight,
  setThreadTerminalOpen,
  closeThreadTerminal,
  splitThreadTerminal,
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
import {
  clearTerminalLabelOverrideByThreadId,
  removeOrphanedTerminalLabelOverrides,
  removeTerminalLabelOverridesForThread,
  setTerminalLabelOverrideByThreadId,
} from "./terminal.store.labels";
import { type TerminalStateStoreState } from "./terminal.store.types";

export type { TerminalEventEntry, ThreadTerminalLaunchContext, ThreadTerminalState };
export {
  selectTerminalEventEntries,
  selectTerminalEventLastId,
  selectThreadTerminalState,
} from "./helpers.store";

const TERMINAL_STATE_STORAGE_KEY = "bigbud:terminal-state:v1";
const LEGACY_TERMINAL_STATE_STORAGE_KEYS = ["t3code:terminal-state:v1"] as const;

function createTerminalStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined, {
    legacyKeysByName: {
      [TERMINAL_STATE_STORAGE_KEY]: LEGACY_TERMINAL_STATE_STORAGE_KEYS,
    },
  });
}

export const useTerminalStateStore = create<TerminalStateStoreState>()(
  persist(
    (set) => {
      const updateTerminal = (
        threadId: ThreadId,
        updater: (state: ThreadTerminalState) => ThreadTerminalState,
      ) => {
        set((state) => {
          const nextTerminalStateByThreadId = updateTerminalStateByThreadId(
            state.terminalStateByThreadId,
            threadId,
            updater,
          );
          if (nextTerminalStateByThreadId === state.terminalStateByThreadId) {
            return state;
          }
          return {
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
            updater,
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
        terminalStateByThreadId: {},
        panelTerminalStateByThreadId: {},
        terminalLabelOverridesByThreadId: {},
        terminalLaunchContextByThreadId: {},
        terminalEventEntriesByKey: {},
        terminalEventLastIdsByKey: {},
        nextTerminalEventId: 1,
        setTerminalOpen: (threadId, open) =>
          updateTerminal(threadId, (state) => setThreadTerminalOpen(state, open)),
        setTerminalHeight: (threadId, height) =>
          updateTerminal(threadId, (state) => setThreadTerminalHeight(state, height)),
        splitTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => splitThreadTerminal(state, terminalId)),
        newTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => newThreadTerminal(state, terminalId)),
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
          updateTerminal(threadId, (state) => closeThreadTerminal(state, terminalId)),
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
        splitPanelTerminal: (threadId, terminalId) =>
          updatePanelTerminal(threadId, (state) => splitThreadTerminal(state, terminalId)),
        newPanelTerminal: (threadId, terminalId) =>
          updatePanelTerminal(threadId, (state) => newThreadTerminal(state, terminalId)),
        ensurePanelTerminal: (threadId, terminalId, options) =>
          set((state) => ensurePanelTerminalInState(state, threadId, terminalId, options)),
        setPanelActiveTerminal: (threadId, terminalId) =>
          updatePanelTerminal(threadId, (state) => setThreadActiveTerminal(state, terminalId)),
        closePanelTerminal: (threadId, terminalId) =>
          updatePanelTerminal(threadId, (state) => closeThreadTerminal(state, terminalId)),
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
        clearTerminalState: (threadId) =>
          set((state) => {
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
            const hadLabelOverrides =
              state.terminalLabelOverridesByThreadId[threadId] !== undefined;
            const { [threadId]: _removed, ...remainingLaunchContexts } =
              state.terminalLaunchContextByThreadId;
            const remainingLabelOverrides = removeTerminalLabelOverridesForThread(
              state.terminalLabelOverridesByThreadId,
              threadId,
            );
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            const nextTerminalEventLastIdsByKey = { ...state.terminalEventLastIdsByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              if (key.startsWith(`${threadId}\u0000`)) {
                delete nextTerminalEventEntriesByKey[key];
                delete nextTerminalEventLastIdsByKey[key];
                removedEventEntries = true;
              }
            }
            if (
              nextTerminalStateByThreadId === state.terminalStateByThreadId &&
              nextPanelTerminalStateByThreadId === state.panelTerminalStateByThreadId &&
              !hadLaunchContext &&
              !hadLabelOverrides &&
              !removedEventEntries
            ) {
              return state;
            }
            return {
              terminalStateByThreadId: nextTerminalStateByThreadId,
              panelTerminalStateByThreadId: nextPanelTerminalStateByThreadId,
              terminalLabelOverridesByThreadId: remainingLabelOverrides,
              terminalLaunchContextByThreadId: remainingLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
              terminalEventLastIdsByKey: nextTerminalEventLastIdsByKey,
            };
          }),
        removeTerminalState: (threadId) =>
          set((state) => {
            const hadTerminalState = state.terminalStateByThreadId[threadId] !== undefined;
            const hadPanelTerminalState =
              state.panelTerminalStateByThreadId[threadId] !== undefined;
            const hadLabelOverrides =
              state.terminalLabelOverridesByThreadId[threadId] !== undefined;
            const hadLaunchContext = state.terminalLaunchContextByThreadId[threadId] !== undefined;
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            const nextTerminalEventLastIdsByKey = { ...state.terminalEventLastIdsByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              if (key.startsWith(`${threadId}\u0000`)) {
                delete nextTerminalEventEntriesByKey[key];
                delete nextTerminalEventLastIdsByKey[key];
                removedEventEntries = true;
              }
            }
            if (
              !hadTerminalState &&
              !hadPanelTerminalState &&
              !hadLabelOverrides &&
              !hadLaunchContext &&
              !removedEventEntries
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
              terminalStateByThreadId: nextTerminalStateByThreadId,
              panelTerminalStateByThreadId: nextPanelTerminalStateByThreadId,
              terminalLabelOverridesByThreadId: nextLabelOverridesByThreadId,
              terminalLaunchContextByThreadId: nextLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
              terminalEventLastIdsByKey: nextTerminalEventLastIdsByKey,
            };
          }),
        removeOrphanedTerminalStates: (activeThreadIds) =>
          set((state) => {
            const orphanedIds = Object.keys(state.terminalStateByThreadId).filter(
              (id) => !activeThreadIds.has(id as ThreadId),
            );
            const orphanedPanelIds = Object.keys(state.panelTerminalStateByThreadId).filter(
              (id) => !activeThreadIds.has(id as ThreadId),
            );
            const orphanedLaunchContextIds = Object.keys(
              state.terminalLaunchContextByThreadId,
            ).filter((id) => !activeThreadIds.has(id as ThreadId));
            const { orphanedThreadIds: orphanedLabelOverrideIds, nextOverridesByThreadId } =
              removeOrphanedTerminalLabelOverrides(
                state.terminalLabelOverridesByThreadId,
                activeThreadIds,
              );
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            const nextTerminalEventLastIdsByKey = { ...state.terminalEventLastIdsByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              const [threadId] = key.split("\u0000");
              if (threadId && !activeThreadIds.has(threadId as ThreadId)) {
                delete nextTerminalEventEntriesByKey[key];
                delete nextTerminalEventLastIdsByKey[key];
                removedEventEntries = true;
              }
            }
            if (
              orphanedIds.length === 0 &&
              orphanedPanelIds.length === 0 &&
              orphanedLabelOverrideIds.length === 0 &&
              orphanedLaunchContextIds.length === 0 &&
              !removedEventEntries
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
              terminalStateByThreadId: next,
              panelTerminalStateByThreadId: nextPanel,
              terminalLabelOverridesByThreadId: nextOverridesByThreadId,
              terminalLaunchContextByThreadId: nextLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
              terminalEventLastIdsByKey: nextTerminalEventLastIdsByKey,
            };
          }),
      };
    },
    {
      name: TERMINAL_STATE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(createTerminalStateStorage),
      partialize: (state) => ({
        terminalStateByThreadId: state.terminalStateByThreadId,
        terminalLabelOverridesByThreadId: state.terminalLabelOverridesByThreadId,
      }),
    },
  ),
);
