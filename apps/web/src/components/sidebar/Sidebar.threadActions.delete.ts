import { type ThreadId } from "@bigbud/contracts";
import { useCallback, useState } from "react";
import type { SidebarThreadSummary } from "../../models/types";

export function useSidebarThreadDeleteActions(input: {
  confirmThreadDelete: boolean;
  sidebarThreadsById: Record<ThreadId, SidebarThreadSummary | undefined>;
  deleteThread: (
    threadId: ThreadId,
    options?: { deletedThreadIds?: Set<ThreadId> },
  ) => Promise<void>;
  removeFromSelection: (threadIds: readonly ThreadId[]) => void;
}) {
  const [pendingDeleteConfirmation, setPendingDeleteConfirmation] = useState<{
    title: string;
    description: string;
    threadIds: readonly ThreadId[];
  } | null>(null);

  const dismissPendingDeleteConfirmation = useCallback(() => {
    setPendingDeleteConfirmation(null);
  }, []);

  const requestThreadDelete = useCallback(
    async (threadId: ThreadId) => {
      const thread = input.sidebarThreadsById[threadId];
      if (!thread) {
        return;
      }

      if (input.confirmThreadDelete) {
        setPendingDeleteConfirmation({
          title: `Delete thread "${thread.title}"?`,
          description: "This permanently clears conversation history for this thread.",
          threadIds: [threadId],
        });
        return;
      }

      await input.deleteThread(threadId);
    },
    [input],
  );

  const confirmPendingDeleteThreads = useCallback(async () => {
    if (!pendingDeleteConfirmation) {
      return;
    }

    const ids = [...pendingDeleteConfirmation.threadIds];
    setPendingDeleteConfirmation(null);

    if (ids.length === 1) {
      await input.deleteThread(ids[0]!);
      return;
    }

    const deletedIds = new Set<ThreadId>(ids);
    for (const id of ids) {
      await input.deleteThread(id, { deletedThreadIds: deletedIds });
    }
    input.removeFromSelection(ids);
  }, [input, pendingDeleteConfirmation]);

  return {
    pendingDeleteConfirmation,
    setPendingDeleteConfirmation,
    dismissPendingDeleteConfirmation,
    requestThreadDelete,
    confirmPendingDeleteThreads,
  };
}
