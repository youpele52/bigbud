/**
 * Panes whose terminal the host closed (plan §11.1 "Ended terminals"): idle, memory pressure,
 * the live limit, an orphan or a quit close. The pane is removed at once, whether or not a view
 * is mounted, so a parked view that comes back never reopens (and respawns) it. Closing the last
 * pane empties the surface. A host-lost terminal keeps its pane, read-only with its last screen.
 *
 * @module terminal.store.ended
 */
import type { ThreadId, TerminalSessionSnapshot } from "@bigbud/contracts";
import { TERMINAL_HOST_CLOSED_REASONS } from "@bigbud/contracts/workspace/terminal.limit.ts";
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";

import { closeTerminalPaneInState } from "./terminal.store.close";
import type { TerminalStateStoreState } from "./terminal.store.types";
import { TERMINAL_CLOSING_NOTICE_KINDS } from "./terminalLiveness.store";

/** A closing notice after which the pane is gone (every close except a host loss). */
export function terminalNoticeEndsPane(notice: TerminalLifecycleNotice): boolean {
  return (
    notice.kind !== "hostLost" &&
    TERMINAL_CLOSING_NOTICE_KINDS.has(notice.kind) &&
    Boolean(notice.threadId && notice.terminalId)
  );
}

/** An open answered with the ended session of a pane the host closed: the pane is gone. */
export function terminalSnapshotHostClosed(snapshot: TerminalSessionSnapshot): boolean {
  return (
    snapshot.status !== "running" &&
    snapshot.endedReason !== undefined &&
    TERMINAL_HOST_CLOSED_REASONS.includes(snapshot.endedReason)
  );
}

/** Removes the pane from whichever surface holds it (drawer, right panel, or both). */
export function removeEndedTerminalPaneInState(
  state: TerminalStateStoreState,
  threadId: ThreadId,
  terminalId: string,
): TerminalStateStoreState {
  let next = state;
  if (state.terminalStateByThreadId[threadId]?.terminalIds.includes(terminalId))
    next = closeTerminalPaneInState(next, threadId, terminalId, false);
  if (state.panelTerminalStateByThreadId[threadId]?.terminalIds.includes(terminalId))
    next = closeTerminalPaneInState(next, threadId, terminalId, true);
  return next;
}
