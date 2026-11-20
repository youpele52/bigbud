import type { TerminalSplitDirection } from "../../lib/terminalSplitLayout";
import type { ThreadId } from "@bigbud/contracts";
import {
  captureTerminalProfileLaunch,
  terminalProfileKey,
  type TerminalProfileLaunch,
} from "../../lib/terminalProfileLaunch";
import { newThreadTerminal, selectThreadTerminalState, splitThreadTerminal } from "./helpers.store";
import type { TerminalStateStoreState } from "./terminal.store.types";

export function removeTerminalProfileLaunches(
  state: Pick<TerminalStateStoreState, "terminalProfileLaunches">,
  remove: (threadId: string, terminalId: string) => boolean,
) {
  const entries = Object.entries(state.terminalProfileLaunches).filter(([key]) => {
    try {
      const ids: unknown = JSON.parse(key);
      return (
        Array.isArray(ids) &&
        ids.length === 2 &&
        typeof ids[0] === "string" &&
        typeof ids[1] === "string" &&
        !remove(ids[0], ids[1])
      );
    } catch {
      return false;
    }
  });
  return {
    terminalProfileLaunches:
      entries.length === Object.keys(state.terminalProfileLaunches).length
        ? state.terminalProfileLaunches
        : Object.fromEntries(entries),
  };
}

/** Capture before changing active pane. Applies equally to shortcuts and both surfaces. */
export function createProfileTerminal(
  state: TerminalStateStoreState,
  threadId: ThreadId,
  terminalId: string,
  panel: boolean,
  split: boolean,
  explicit?: TerminalProfileLaunch,
  direction?: TerminalSplitDirection,
): Partial<TerminalStateStoreState> {
  const field = panel ? "panelTerminalStateByThreadId" : "terminalStateByThreadId";
  const current = selectThreadTerminalState(state[field], threadId);
  const next = split
    ? splitThreadTerminal(current, terminalId, direction)
    : newThreadTerminal(current, terminalId);
  if (next === current) return {};
  const profile = captureTerminalProfileLaunch(
    threadId,
    current.activeTerminalId,
    explicit,
    state.terminalProfileLaunches[terminalProfileKey(threadId, current.activeTerminalId)],
  );
  return {
    [field]: { ...state[field], [threadId]: next },
    terminalProfileLaunches: {
      ...state.terminalProfileLaunches,
      [terminalProfileKey(threadId, terminalId)]: profile,
    },
  };
}
