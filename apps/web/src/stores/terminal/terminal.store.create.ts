/**
 * User-created panes (plan D1): a thread has a terminal only after the user opens one.
 *
 * @module terminal.store.create
 */
import type { ThreadId } from "@bigbud/contracts";

import type { TerminalProfileLaunch } from "../../lib/terminalProfileLaunch";
import type { TerminalSplitDirection } from "../../lib/terminalSplitLayout";
import { randomUUID } from "../../lib/utils";
import {
  newThreadTerminal,
  selectThreadTerminalState,
  updateTerminalStateByThreadId,
} from "./helpers.store";
import { createProfileTerminal } from "./terminal.store.profileLaunch";
import type { TerminalStateStoreState } from "./terminal.store.types";

export function createTerminalPaneId(): string {
  return `terminal-${randomUUID()}`;
}

/** A target-only request names the thread's own target, which a first pane uses anyway. */
export function inheritsNothing(profile: TerminalProfileLaunch | undefined): boolean {
  return (
    profile === undefined || Object.keys(profile).every((key) => key === "newExecutionTargetId")
  );
}

export function surfaceHasPanes(
  state: Pick<TerminalStateStoreState, "terminalStateByThreadId" | "panelTerminalStateByThreadId">,
  threadId: ThreadId,
  panel: boolean,
): boolean {
  const field = panel ? "panelTerminalStateByThreadId" : "terminalStateByThreadId";
  return selectThreadTerminalState(state[field], threadId).terminalIds.length > 0;
}

/**
 * Adds a user-created pane and opens its surface. A first pane has no source pane, so it records
 * no inherited profile (which would demand a choice) and starts the default shell.
 */
export function createUserTerminalPane(
  state: TerminalStateStoreState,
  threadId: ThreadId,
  terminalId: string,
  panel: boolean,
  split: boolean,
  profile?: TerminalProfileLaunch,
  direction?: TerminalSplitDirection,
): Partial<TerminalStateStoreState> {
  if (surfaceHasPanes(state, threadId, panel) || !inheritsNothing(profile)) {
    return createProfileTerminal(state, threadId, terminalId, panel, split, profile, direction);
  }
  const field = panel ? "panelTerminalStateByThreadId" : "terminalStateByThreadId";
  const next = updateTerminalStateByThreadId(state[field], threadId, (current) =>
    newThreadTerminal(current, terminalId),
  );
  return next === state[field] ? {} : { [field]: next };
}
