import { ThreadId, type TerminalEvent } from "@bigbud/contracts";
import { terminalRunningSubprocessFromEvent } from "../../utils/terminal";
import {
  appendTerminalEventEntry,
  createSingleThreadTerminalState,
  launchContextFromStartEvent,
  newThreadTerminal,
  normalizeThreadTerminalState,
  selectThreadTerminalState,
  setThreadActiveTerminal,
  setThreadTerminalActivity,
  setThreadTerminalOpen,
  updateTerminalStateByThreadId,
  type TerminalEventEntry,
  type ThreadTerminalLaunchContext,
  type ThreadTerminalState,
} from "./helpers.store";

interface PanelTerminalStateSlice {
  panelTerminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
}

export function ensurePanelTerminalInState(
  state: PanelTerminalStateSlice,
  threadId: ThreadId,
  terminalId: string,
  options: { open?: boolean; active?: boolean } | undefined,
): PanelTerminalStateSlice {
  if (threadId.length === 0) return state;
  const currentPanelState = state.panelTerminalStateByThreadId[threadId];
  if (!currentPanelState) {
    const nextState = createSingleThreadTerminalState(terminalId);
    return {
      panelTerminalStateByThreadId: {
        ...state.panelTerminalStateByThreadId,
        [threadId]: options?.open === false ? { ...nextState, terminalOpen: false } : nextState,
      },
    };
  }

  const nextPanelTerminalStateByThreadId = updateTerminalStateByThreadId(
    state.panelTerminalStateByThreadId,
    threadId,
    (panelState) => {
      let nextState = panelState;
      const previousTerminalOpen = panelState.terminalOpen;
      if (!panelState.terminalIds.includes(terminalId)) {
        nextState = newThreadTerminal(nextState, terminalId);
        if (!options?.open) {
          nextState = { ...nextState, terminalOpen: previousTerminalOpen };
        }
      }
      if (options?.active === false) {
        nextState = {
          ...nextState,
          activeTerminalId: panelState.activeTerminalId,
          activeTerminalGroupId: panelState.activeTerminalGroupId,
        };
      }
      if (options?.active ?? true) {
        nextState = setThreadActiveTerminal(nextState, terminalId);
      }
      if (options?.open) {
        nextState = setThreadTerminalOpen(nextState, true);
      }
      return normalizeThreadTerminalState(nextState);
    },
  );
  if (nextPanelTerminalStateByThreadId === state.panelTerminalStateByThreadId) {
    return state;
  }
  return {
    panelTerminalStateByThreadId: nextPanelTerminalStateByThreadId,
  };
}

interface TerminalEventStateSlice extends PanelTerminalStateSlice {
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
  terminalLaunchContextByThreadId: Record<ThreadId, ThreadTerminalLaunchContext>;
  terminalEventEntriesByKey: Record<string, ReadonlyArray<TerminalEventEntry>>;
  terminalEventLastIdsByKey: Record<string, number>;
  nextTerminalEventId: number;
}

export function applyTerminalEventToState(
  state: TerminalEventStateSlice,
  event: TerminalEvent,
): TerminalEventStateSlice {
  const threadId = ThreadId.makeUnsafe(event.threadId);
  let nextTerminalStateByThreadId = state.terminalStateByThreadId;
  let nextPanelTerminalStateByThreadId = state.panelTerminalStateByThreadId;
  let nextTerminalLaunchContextByThreadId = state.terminalLaunchContextByThreadId;
  const drawerTerminalState = selectThreadTerminalState(state.terminalStateByThreadId, threadId);
  const panelTerminalState = state.panelTerminalStateByThreadId[threadId];
  const eventTargetsPanel =
    panelTerminalState?.terminalIds.includes(event.terminalId) === true &&
    !drawerTerminalState.terminalIds.includes(event.terminalId);

  const updateTargetTerminalState = (
    updater: (current: ThreadTerminalState) => ThreadTerminalState,
  ) => {
    if (eventTargetsPanel) {
      nextPanelTerminalStateByThreadId = updateTerminalStateByThreadId(
        nextPanelTerminalStateByThreadId,
        threadId,
        updater,
      );
      return;
    }
    nextTerminalStateByThreadId = updateTerminalStateByThreadId(
      nextTerminalStateByThreadId,
      threadId,
      updater,
    );
  };

  if (event.type === "started" || event.type === "restarted") {
    updateTargetTerminalState((current) => {
      let nextState = current;
      if (!current.terminalIds.includes(event.terminalId)) {
        nextState = newThreadTerminal(nextState, event.terminalId);
      }
      nextState = setThreadActiveTerminal(nextState, event.terminalId);
      nextState = setThreadTerminalOpen(nextState, true);
      return normalizeThreadTerminalState(nextState);
    });
    nextTerminalLaunchContextByThreadId = {
      ...nextTerminalLaunchContextByThreadId,
      [threadId]: launchContextFromStartEvent(event),
    };
  }

  const hasRunningSubprocess = terminalRunningSubprocessFromEvent(event);
  if (hasRunningSubprocess !== null) {
    updateTargetTerminalState((current) =>
      setThreadTerminalActivity(current, event.terminalId, hasRunningSubprocess),
    );
  }

  const nextEventState = appendTerminalEventEntry(
    state.terminalEventEntriesByKey,
    state.terminalEventLastIdsByKey,
    state.nextTerminalEventId,
    event,
  );

  return {
    terminalStateByThreadId: nextTerminalStateByThreadId,
    panelTerminalStateByThreadId: nextPanelTerminalStateByThreadId,
    terminalLaunchContextByThreadId: nextTerminalLaunchContextByThreadId,
    ...nextEventState,
  };
}

export function applyTerminalEventsToState(
  state: TerminalEventStateSlice,
  events: ReadonlyArray<TerminalEvent>,
): TerminalEventStateSlice {
  if (events.length === 0) {
    return state;
  }
  return events.reduce((nextState, event) => applyTerminalEventToState(nextState, event), state);
}
