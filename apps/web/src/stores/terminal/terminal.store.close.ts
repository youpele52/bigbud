import type { ThreadId } from "@bigbud/contracts";

import { closeThreadTerminal, updateTerminalStateByThreadId } from "./helpers.store";
import { removeTerminalTransientState } from "./terminal.store.cleanup";
import { closeTerminalAgentIdentity } from "./terminal.store.identity";
import type { TerminalStateStoreState } from "./terminal.store.types";

export function closeTerminalPaneInState(
  state: TerminalStateStoreState,
  threadId: ThreadId,
  terminalId: string,
  panel: boolean,
): TerminalStateStoreState {
  const key = `${threadId}\u0000${terminalId}`;
  const transient = removeTerminalTransientState(state, (candidate) => candidate === key);
  const tombstone = closeTerminalAgentIdentity(state, key);
  const field = panel ? "panelTerminalStateByThreadId" : "terminalStateByThreadId";
  const nextTerminalState = updateTerminalStateByThreadId(state[field], threadId, (current) =>
    closeThreadTerminal(current, terminalId),
  );
  return { ...state, [field]: nextTerminalState, ...transient.state, ...tombstone };
}
