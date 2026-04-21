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
import { terminalRunningSubprocessFromEvent } from "../../utils/terminal";
import {
  appendTerminalEventEntry,
  createDefaultThreadTerminalState,
  launchContextFromStartEvent,
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

export type { TerminalEventEntry, ThreadTerminalLaunchContext, ThreadTerminalState };
export { selectTerminalEventEntries, selectThreadTerminalState } from "./helpers.store";

const TERMINAL_STATE_STORAGE_KEY = "bigbud:terminal-state:v1";
const LEGACY_TERMINAL_STATE_STORAGE_KEYS = ["t3code:terminal-state:v1"] as const;

function createTerminalStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined, {
    legacyKeysByName: {
      [TERMINAL_STATE_STORAGE_KEY]: LEGACY_TERMINAL_STATE_STORAGE_KEYS,
    },
  });
}

interface TerminalStateStoreState {
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
  terminalLaunchContextByThreadId: Record<ThreadId, ThreadTerminalLaunchContext>;
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>;
  nextTerminalEventId: number;
  setTerminalOpen: (threadId: ThreadId, open: boolean) => void;
  setTerminalHeight: (threadId: ThreadId, height: number) => void;
  splitTerminal: (threadId: ThreadId, terminalId: string) => void;
  newTerminal: (threadId: ThreadId, terminalId: string) => void;
  ensureTerminal: (
    threadId: ThreadId,
    terminalId: string,
    options?: { open?: boolean; active?: boolean },
  ) => void;
  setActiveTerminal: (threadId: ThreadId, terminalId: string) => void;
  closeTerminal: (threadId: ThreadId, terminalId: string) => void;
  setTerminalLaunchContext: (threadId: ThreadId, context: ThreadTerminalLaunchContext) => void;
  clearTerminalLaunchContext: (threadId: ThreadId) => void;
  setTerminalActivity: (
    threadId: ThreadId,
    terminalId: string,
    hasRunningSubprocess: boolean,
  ) => void;
  recordTerminalEvent: (event: import("@bigbud/contracts").TerminalEvent) => void;
  applyTerminalEvent: (event: import("@bigbud/contracts").TerminalEvent) => void;
  clearTerminalState: (threadId: ThreadId) => void;
  removeTerminalState: (threadId: ThreadId) => void;
  removeOrphanedTerminalStates: (activeThreadIds: Set<ThreadId>) => void;
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

      return {
        terminalStateByThreadId: {},
        terminalLaunchContextByThreadId: {},
        terminalEventEntriesByKey: {},
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
            if (!state.terminalIds.includes(terminalId)) {
              nextState = newThreadTerminal(nextState, terminalId);
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
              state.nextTerminalEventId,
              event,
            ),
          ),
        applyTerminalEvent: (event) =>
          set((state) => {
            const threadId = ThreadId.makeUnsafe(event.threadId);
            let nextTerminalStateByThreadId = state.terminalStateByThreadId;
            let nextTerminalLaunchContextByThreadId = state.terminalLaunchContextByThreadId;

            if (event.type === "started" || event.type === "restarted") {
              nextTerminalStateByThreadId = updateTerminalStateByThreadId(
                nextTerminalStateByThreadId,
                threadId,
                (current) => {
                  let nextState = current;
                  if (!current.terminalIds.includes(event.terminalId)) {
                    nextState = newThreadTerminal(nextState, event.terminalId);
                  }
                  nextState = setThreadActiveTerminal(nextState, event.terminalId);
                  nextState = setThreadTerminalOpen(nextState, true);
                  return normalizeThreadTerminalState(nextState);
                },
              );
              nextTerminalLaunchContextByThreadId = {
                ...nextTerminalLaunchContextByThreadId,
                [threadId]: launchContextFromStartEvent(event),
              };
            }

            const hasRunningSubprocess = terminalRunningSubprocessFromEvent(event);
            if (hasRunningSubprocess !== null) {
              nextTerminalStateByThreadId = updateTerminalStateByThreadId(
                nextTerminalStateByThreadId,
                threadId,
                (current) =>
                  setThreadTerminalActivity(current, event.terminalId, hasRunningSubprocess),
              );
            }

            const nextEventState = appendTerminalEventEntry(
              state.terminalEventEntriesByKey,
              state.nextTerminalEventId,
              event,
            );

            return {
              terminalStateByThreadId: nextTerminalStateByThreadId,
              terminalLaunchContextByThreadId: nextTerminalLaunchContextByThreadId,
              ...nextEventState,
            };
          }),
        clearTerminalState: (threadId) =>
          set((state) => {
            const nextTerminalStateByThreadId = updateTerminalStateByThreadId(
              state.terminalStateByThreadId,
              threadId,
              () => createDefaultThreadTerminalState(),
            );
            const hadLaunchContext = state.terminalLaunchContextByThreadId[threadId] !== undefined;
            const { [threadId]: _removed, ...remainingLaunchContexts } =
              state.terminalLaunchContextByThreadId;
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              if (key.startsWith(`${threadId}\u0000`)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            if (
              nextTerminalStateByThreadId === state.terminalStateByThreadId &&
              !hadLaunchContext &&
              !removedEventEntries
            ) {
              return state;
            }
            return {
              terminalStateByThreadId: nextTerminalStateByThreadId,
              terminalLaunchContextByThreadId: remainingLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
            };
          }),
        removeTerminalState: (threadId) =>
          set((state) => {
            const hadTerminalState = state.terminalStateByThreadId[threadId] !== undefined;
            const hadLaunchContext = state.terminalLaunchContextByThreadId[threadId] !== undefined;
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              if (key.startsWith(`${threadId}\u0000`)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            if (!hadTerminalState && !hadLaunchContext && !removedEventEntries) {
              return state;
            }
            const nextTerminalStateByThreadId = { ...state.terminalStateByThreadId };
            delete nextTerminalStateByThreadId[threadId];
            const nextLaunchContexts = { ...state.terminalLaunchContextByThreadId };
            delete nextLaunchContexts[threadId];
            return {
              terminalStateByThreadId: nextTerminalStateByThreadId,
              terminalLaunchContextByThreadId: nextLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
            };
          }),
        removeOrphanedTerminalStates: (activeThreadIds) =>
          set((state) => {
            const orphanedIds = Object.keys(state.terminalStateByThreadId).filter(
              (id) => !activeThreadIds.has(id as ThreadId),
            );
            const orphanedLaunchContextIds = Object.keys(
              state.terminalLaunchContextByThreadId,
            ).filter((id) => !activeThreadIds.has(id as ThreadId));
            const nextTerminalEventEntriesByKey = { ...state.terminalEventEntriesByKey };
            let removedEventEntries = false;
            for (const key of Object.keys(nextTerminalEventEntriesByKey)) {
              const [threadId] = key.split("\u0000");
              if (threadId && !activeThreadIds.has(threadId as ThreadId)) {
                delete nextTerminalEventEntriesByKey[key];
                removedEventEntries = true;
              }
            }
            if (
              orphanedIds.length === 0 &&
              orphanedLaunchContextIds.length === 0 &&
              !removedEventEntries
            ) {
              return state;
            }
            const next = { ...state.terminalStateByThreadId };
            for (const id of orphanedIds) {
              delete next[id as ThreadId];
            }
            const nextLaunchContexts = { ...state.terminalLaunchContextByThreadId };
            for (const id of orphanedLaunchContextIds) {
              delete nextLaunchContexts[id as ThreadId];
            }
            return {
              terminalStateByThreadId: next,
              terminalLaunchContextByThreadId: nextLaunchContexts,
              terminalEventEntriesByKey: nextTerminalEventEntriesByKey,
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
      }),
    },
  ),
);
