import {
  TERMINAL_SEARCH_DEFAULT_LIMIT,
  type TerminalSearchResult,
} from "@bigbud/contracts/workspace/terminal.search.ts";
import { queryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "~/rpc/nativeApi";
import { isConversationSearchQueryValid } from "./conversationSearchQuery";

const NO_HITS: TerminalSearchResult = { hits: [], truncated: false };

/** Retained terminal output; terminal search shares the saved-message query bounds. */
export function terminalSearchQueryOptions(input: { query: string; enabled: boolean }) {
  return queryOptions({
    queryKey: ["terminal-output-search", input.query] as const,
    queryFn: async (): Promise<TerminalSearchResult> => {
      const search = ensureNativeApi().terminal.search;
      return search
        ? search({ query: input.query, limit: TERMINAL_SEARCH_DEFAULT_LIMIT })
        : NO_HITS;
    },
    enabled: input.enabled && isConversationSearchQueryValid(input.query),
    staleTime: 0,
  });
}
