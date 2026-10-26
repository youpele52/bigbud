import { useCallback, useState } from "react";
import { BUILT_IN_CHATS_PROJECT_ID, type ThreadSummaryCursor } from "@bigbud/contracts";
import { readNativeApi } from "../../rpc/nativeApi";
import { loadMoreProjectThreadSummaries } from "../../routes/-__root.bounded-bootstrap";
import { toastManager } from "../ui/toast";

export function useSidebarChatPagination(
  chatThreadCount: number | undefined,
  chatThreadCursor: ThreadSummaryCursor | null | undefined,
  recentThreadCount: number,
) {
  const [isLoadingMoreChats, setIsLoadingMoreChats] = useState(false);
  const hasMoreChats =
    chatThreadCursor === undefined
      ? (chatThreadCount ?? 0) > recentThreadCount
      : chatThreadCursor !== null;
  const loadMoreChats = useCallback(() => {
    const api = readNativeApi();
    if (!api || isLoadingMoreChats || !hasMoreChats) return;
    setIsLoadingMoreChats(true);
    void loadMoreProjectThreadSummaries({
      api,
      projectId: BUILT_IN_CHATS_PROJECT_ID,
    })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Failed to load chats",
          description: error instanceof Error ? error.message : "Unable to load more chats.",
        });
      })
      .finally(() => setIsLoadingMoreChats(false));
  }, [hasMoreChats, isLoadingMoreChats]);
  return { isLoadingMoreChats, hasMoreChats, loadMoreChats };
}
