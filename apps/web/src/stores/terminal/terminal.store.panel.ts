import { dismissedPaneKey } from "./terminal.store.dismiss";
import { ThreadId, type TerminalEvent } from "@bigbud/contracts";
import { terminalRunningSubprocessFromEvent } from "../../utils/terminal";
import { recordTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { reconcileTerminalProfileLaunches } from "./terminal.store.snapshot";
import type { TerminalStateStoreState } from "./terminal.store.types";
import {
  appendTerminalEventEntry,
  createSingleThreadTerminalState,
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
import {
  applyTerminalAgentEvent,
  type TerminalAgentIdentityState,
} from "./terminal.store.identity";

/** Project setup scripts run in `setup-<script id>` terminals the server opens (§8.8). */
export function isSetupTerminalId(terminalId: string): boolean {
  return terminalId.startsWith("setup-");
}

/**
 * A start this client did not initiate (another window or client, a server restart of a known
 * pane) adds its pane but never opens the surface or takes the active tab. Only a setup script's
 * terminal opens it; a local launch already has its pane on an open surface.
 */
function startedTerminalState(current: ThreadTerminalState, terminalId: string) {
  if (isSetupTerminalId(terminalId)) {
    let nextState = current.terminalIds.includes(terminalId)
      ? current
      : newThreadTerminal(current, terminalId);
    nextState = setThreadActiveTerminal(nextState, terminalId);
    return normalizeThreadTerminalState(setThreadTerminalOpen(nextState, true));
  }
  if (current.terminalIds.includes(terminalId)) return current;
  const added = newThreadTerminal(current, terminalId);
  return normalizeThreadTerminalState(
    current.terminalIds.length === 0
      ? { ...added, terminalOpen: current.terminalOpen }
      : {
          ...added,
          terminalOpen: current.terminalOpen,
          activeTerminalId: current.activeTerminalId,
          activeTerminalGroupId: current.activeTerminalGroupId,
        },
  );
}

interface PanelTerminalStateSlice {
  dismissedTerminalPanes?: TerminalStateStoreState["dismissedTerminalPanes"];
  panelTerminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
}

export function ensurePanelTerminalInState(
  state: PanelTerminalStateSlice,
  threadId: ThreadId,
  terminalId: string,
  options: { open?: boolean; active?: boolean } | undefined,
): PanelTerminalStateSlice {
  if (
    threadId.length === 0 ||
    state.dismissedTerminalPanes?.[dismissedPaneKey(threadId, terminalId)]
  )
    return state;
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

interface TerminalEventStateSlice extends PanelTerminalStateSlice, TerminalAgentIdentityState {
  terminalProfileLaunches: TerminalStateStoreState["terminalProfileLaunches"];
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
  if (state.dismissedTerminalPanes?.[dismissedPaneKey(event.threadId, event.terminalId)])
    return state;
  if (
    (event.type === "started" || event.type === "restarted") &&
    !recordTerminalLaunch(event.snapshot)
  )
    return state;
  const threadId = ThreadId.makeUnsafe(event.threadId);
  let nextTerminalStateByThreadId = state.terminalStateByThreadId;
  let nextPanelTerminalStateByThreadId = state.panelTerminalStateByThreadId;
  const identity = applyTerminalAgentEvent(state, event);
  if (identity.blocked) return state;
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
    recordTerminalLaunch(event.snapshot);
    updateTargetTerminalState((current) => startedTerminalState(current, event.terminalId));
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
    dismissedTerminalPanes: state.dismissedTerminalPanes,
    terminalProfileLaunches:
      event.type === "started" || event.type === "restarted"
        ? reconcileTerminalProfileLaunches(state, event.snapshot).terminalProfileLaunches
        : state.terminalProfileLaunches,
    terminalStateByThreadId: nextTerminalStateByThreadId,
    panelTerminalStateByThreadId: nextPanelTerminalStateByThreadId,
    terminalLaunchContextByThreadId: state.terminalLaunchContextByThreadId,
    ...identity.state,
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
