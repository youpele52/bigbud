import type { ThreadId } from "@bigbud/contracts";

import { useTerminalStateStore } from "../../stores/terminal";
import { openTerminalPanel } from "../../stores/terminal/terminalPanel.coordinator";

/**
 * Show an existing terminal wherever it lives (side panel or thread drawer) and make it active.
 * It is never respawned: a drawer pane the store lacks is added as a restored, attach-only pane.
 * `fullscreen` switches a drawer terminal to terminal-only layout; a side-panel terminal opens
 * the panel. The caller navigates to the thread.
 */
export function revealExistingTerminal(
  threadId: ThreadId,
  terminalId: string,
  options?: { readonly fullscreen?: boolean },
): void {
  const store = useTerminalStateStore.getState();
  if (store.panelTerminalStateByThreadId[threadId]?.terminalIds.includes(terminalId)) {
    store.setPanelActiveTerminal(threadId, terminalId);
    openTerminalPanel();
    return;
  }
  store.ensureTerminal(threadId, terminalId, { open: true, active: true, restored: true });
  // Visiting a terminal: show it full size, even if the drawer was hidden or chat-only.
  if (options?.fullscreen) store.setTerminalLayout(threadId, "terminal-only");
}
