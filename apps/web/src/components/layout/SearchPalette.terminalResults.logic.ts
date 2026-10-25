import type { ThreadId } from "@bigbud/contracts";
import type { TerminalSearchHit } from "@bigbud/contracts/workspace/terminal.search.ts";

import { useTerminalStateStore } from "../../stores/terminal";
import { openTerminalPanel } from "../../stores/terminal/terminalPanel.coordinator";
import { useSearchStore } from "../../stores/ui";
import { buildTerminalLabelMap } from "../terminal/terminalDisplay";

export interface TerminalSearchResult {
  id: string;
  threadId: ThreadId;
  terminalId: string;
  threadTitle: string;
  terminalLabel: string;
  lineText: string;
  matchStart: number;
  running: boolean;
  type: "terminal";
}

type TerminalStoreSnapshot = Pick<
  ReturnType<typeof useTerminalStateStore.getState>,
  "terminalStateByThreadId" | "panelTerminalStateByThreadId" | "terminalLabelOverridesByThreadId"
>;

/** The label the terminal's tab shows ("Terminal 2", or the user's rename). */
export function terminalSearchLabel(
  store: TerminalStoreSnapshot,
  threadId: ThreadId,
  terminalId: string,
): string {
  const overrides = store.terminalLabelOverridesByThreadId[threadId] ?? {};
  for (const surface of [store.terminalStateByThreadId, store.panelTerminalStateByThreadId]) {
    const ids = surface[threadId]?.terminalIds ?? [];
    if (ids.includes(terminalId))
      return buildTerminalLabelMap(ids, "Terminal", overrides).get(terminalId) ?? "Terminal";
  }
  return overrides[terminalId]?.trim() || "Terminal";
}

/** Hits of threads the user can see (not archived, deleted or hidden), labelled for display. */
export function toTerminalSearchResults(
  hits: readonly TerminalSearchHit[],
  input: {
    readonly threadTitle: (threadId: ThreadId) => string | null;
    readonly store: TerminalStoreSnapshot;
  },
): TerminalSearchResult[] {
  return hits.flatMap((hit) => {
    const threadTitle = input.threadTitle(hit.threadId);
    if (threadTitle === null) return [];
    return [
      {
        id: `terminal:${hit.threadId}:${hit.terminalId}:${hit.linesFromEnd}`,
        threadId: hit.threadId,
        terminalId: hit.terminalId,
        threadTitle,
        terminalLabel: terminalSearchLabel(input.store, hit.threadId, hit.terminalId),
        lineText: hit.lineText,
        matchStart: hit.matchStart,
        running: hit.running,
        type: "terminal" as const,
      },
    ];
  });
}

/**
 * Show the hit's terminal (side panel or thread drawer, wherever it lives) and ask its view to
 * open find on the query at the hit's line. The caller navigates to the thread.
 */
export function revealTerminalSearchResult(result: TerminalSearchResult, query: string): void {
  const store = useTerminalStateStore.getState();
  if (
    store.panelTerminalStateByThreadId[result.threadId]?.terminalIds.includes(result.terminalId)
  ) {
    store.setPanelActiveTerminal(result.threadId, result.terminalId);
    openTerminalPanel();
  } else {
    store.ensureTerminal(result.threadId, result.terminalId, { open: true, active: true });
  }
  useSearchStore.getState().requestTerminalFind({
    threadId: result.threadId,
    terminalId: result.terminalId,
    query,
    lineText: result.lineText,
  });
}
