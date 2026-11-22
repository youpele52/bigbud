/**
 * Opening a pane whose terminal may be gone (plan D1, §11.1). A restored pane (loaded from storage,
 * a search hit, a remote attach, or any pane after the server restarted) only reattaches; when
 * nothing runs to attach, or its retained session ended, the pane is dropped instead of showing
 * an error. Any pane the host closed (idle, memory, limit, orphan) is dropped the same way. A
 * host-lost pane stays, read-only.
 *
 * @module TerminalViewport.session.restored
 */
import type { TerminalSessionSnapshot } from "@bigbud/contracts";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";

import { useTerminalStateStore } from "../../stores/terminal";
import {
  isTerminalNotRunningError,
  restoredPaneEnded,
  terminalSnapshotHostClosed,
} from "../../stores/terminal/terminal.store.ended";
import { terminalPaneOpenOptions } from "../../stores/terminal/terminal.store.paneOrigin";
import { awaitTerminalServerRun } from "../../stores/terminal/terminal.store.serverRun";

/** Waits until the server run is known after a reconnect, then reads the pane's open options. */
export async function terminalPaneOpen(threadId: string, terminalId: string) {
  await awaitTerminalServerRun();
  const options = terminalPaneOpenOptions(threadId, terminalId);
  return {
    /** Spread into `terminal.open`: `attachOnly` for a restored pane. */
    options,
    /** The open's snapshot, or null when a restored pane has nothing to attach. */
    settle: <T>(request: Promise<T>): Promise<T | null> =>
      request.catch((error: unknown) => {
        if (options.attachOnly && isTerminalNotRunningError(error)) return null;
        throw error;
      }),
    /** The terminal is gone for good: its pane must go too. */
    ended: (snapshot: TerminalSessionSnapshot) =>
      terminalSnapshotHostClosed(snapshot) ||
      (options.attachOnly === true && restoredPaneEnded(snapshot)),
    drop: () =>
      useTerminalStateStore
        .getState()
        .removeEndedTerminal(ThreadId.makeUnsafe(threadId), terminalId),
  };
}
