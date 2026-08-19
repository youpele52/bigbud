import { type AutomationId, type ThreadId } from "@bigbud/contracts";
import { useCallback, useState } from "react";
import type { SidebarThreadSummary } from "../../models/types";

function ownedThreadAutomationId(error: unknown): AutomationId | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "automation_owned_thread" &&
    "automationId" in error &&
    typeof error.automationId === "string"
  ) {
    return error.automationId as AutomationId;
  }
  return null;
}

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
    automationId?: AutomationId;
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
          description:
            "This deletes this thread and any child threads from bigbud's local views and cleans up associated bigbud-managed local resources.",
          threadIds: [threadId],
        });
        return;
      }

      try {
        await input.deleteThread(threadId);
      } catch (error) {
        const automationId = ownedThreadAutomationId(error);
        if (!automationId) throw error;
        setPendingDeleteConfirmation({
          title: "Thread owned by an automation",
          description:
            "Deletion requires deleting the automation first. This thread deletes automatically after its final owner is deleted.",
          threadIds: [],
          automationId,
        });
      }
    },
    [input],
  );

  const confirmPendingDeleteThreads = useCallback(async () => {
    if (!pendingDeleteConfirmation) {
      return;
    }

    const ids = [...pendingDeleteConfirmation.threadIds];
    setPendingDeleteConfirmation(null);

    if (pendingDeleteConfirmation.automationId) {
      window.location.assign(`/automations/${pendingDeleteConfirmation.automationId}`);
      return;
    }
    if (ids.length === 1) {
      try {
        await input.deleteThread(ids[0]!);
      } catch (error) {
        const automationId = ownedThreadAutomationId(error);
        if (!automationId) throw error;
        setPendingDeleteConfirmation({
          title: "Thread owned by an automation",
          description:
            "Deletion requires deleting the automation first. This thread deletes automatically after its final owner is deleted.",
          threadIds: [],
          automationId,
        });
      }
      return;
    }

    const deletedIds = new Set<ThreadId>();
    for (const id of ids) {
      try {
        await input.deleteThread(id, { deletedThreadIds: new Set(ids) });
        deletedIds.add(id);
      } catch (error) {
        const automationId = ownedThreadAutomationId(error);
        if (!automationId) throw error;
        setPendingDeleteConfirmation({
          title: "Thread owned by an automation",
          description:
            "Deletion requires deleting the automation first. This thread deletes automatically after its final owner is deleted.",
          threadIds: [],
          automationId,
        });
        break;
      }
    }
    input.removeFromSelection([...deletedIds]);
  }, [input, pendingDeleteConfirmation]);

  return {
    pendingDeleteConfirmation,
    setPendingDeleteConfirmation,
    dismissPendingDeleteConfirmation,
    requestThreadDelete,
    confirmPendingDeleteThreads,
  };
}
