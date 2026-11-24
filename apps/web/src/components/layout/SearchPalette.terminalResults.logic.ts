import type { ThreadId } from "@bigbud/contracts";
import type { TerminalSearchHit } from "@bigbud/contracts/workspace/terminal.search.ts";

import { useSearchStore } from "../../stores/ui";
import { revealExistingTerminal } from "../terminal/revealTerminal";
import { terminalPaneLabel, type TerminalLabelStoreSnapshot } from "../terminal/terminalPaneLabel";

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

type TerminalStoreSnapshot = TerminalLabelStoreSnapshot;

/** The label the terminal's tab shows ("Terminal 2", or the user's rename). */
export const terminalSearchLabel = terminalPaneLabel;

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
  revealExistingTerminal(result.threadId, result.terminalId);
  useSearchStore.getState().requestTerminalFind({
    threadId: result.threadId,
    terminalId: result.terminalId,
    query,
    lineText: result.lineText,
  });
}
