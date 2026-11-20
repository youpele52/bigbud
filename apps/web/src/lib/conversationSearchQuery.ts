import type { ProjectId, ThreadId } from "@bigbud/contracts";
import {
  CONVERSATION_SEARCH_MIN_QUERY_LENGTH,
  CONVERSATION_SEARCH_MAX_QUERY_LENGTH,
  CONVERSATION_SEARCH_SCOPED_MIN_QUERY_LENGTH,
  type SearchConversationMessagesResult,
} from "@bigbud/contracts/orchestration/orchestration.search";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { countUnicodeCodePoints } from "@bigbud/shared/String";

import { ensureNativeApi } from "~/rpc/nativeApi";

export function isConversationSearchQueryValid(query: string): boolean {
  const queryLength = countUnicodeCodePoints(query.trim());
  return (
    queryLength >= CONVERSATION_SEARCH_MIN_QUERY_LENGTH &&
    queryLength <= CONVERSATION_SEARCH_MAX_QUERY_LENGTH
  );
}

/** With a current thread, 1–2 code point queries still search that thread's messages. */
function isScopedConversationSearchQueryValid(query: string): boolean {
  const queryLength = countUnicodeCodePoints(query.trim());
  return (
    queryLength >= CONVERSATION_SEARCH_SCOPED_MIN_QUERY_LENGTH &&
    queryLength <= CONVERSATION_SEARCH_MAX_QUERY_LENGTH
  );
}

export function conversationSearchQueryOptions(input: {
  query: string;
  enabled: boolean;
  currentThreadId?: ThreadId | null;
  currentProjectId?: ProjectId | null;
}) {
  const currentThreadId = input.currentThreadId ?? undefined;
  const currentProjectId = input.currentProjectId ?? undefined;
  return infiniteQueryOptions({
    queryKey: [
      "conversation-message-search",
      input.query,
      currentThreadId ?? null,
      currentProjectId ?? null,
    ] as const,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }): Promise<SearchConversationMessagesResult> =>
      ensureNativeApi().orchestration.searchConversationMessages({
        query: input.query,
        limit: 30,
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
        ...(currentThreadId === undefined ? {} : { currentThreadId }),
        ...(currentProjectId === undefined ? {} : { currentProjectId }),
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled:
      input.enabled &&
      (isConversationSearchQueryValid(input.query) ||
        (currentThreadId !== undefined && isScopedConversationSearchQueryValid(input.query))),
    staleTime: 0,
  });
}
