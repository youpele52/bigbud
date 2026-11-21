/**
 * Open options derived from a pane's origin (plan D1): restored panes only reattach.
 *
 * @module terminal.store.paneOrigin
 */
import { selectTerminalPaneOrigin } from "./helpers.store";
import { useTerminalStateStore } from "./terminal.store";

/** Spread into `terminal.open`: a restored pane sends `attachOnly` so it is never respawned. */
export function terminalPaneOpenOptions(
  threadId: string,
  terminalId: string,
): { readonly attachOnly?: true } {
  return selectTerminalPaneOrigin(useTerminalStateStore.getState(), threadId, terminalId) ===
    "restored"
    ? { attachOnly: true }
    : {};
}
