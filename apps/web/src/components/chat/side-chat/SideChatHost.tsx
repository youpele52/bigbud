import { type ThreadId } from "@bigbud/contracts";
import { useEffect } from "react";

import { useStore } from "~/stores/main";
import { useSideChatStore } from "~/stores/sideChat";

import { FloatingSideChat } from "./FloatingSideChat";

export function SideChatHost({
  mainThreadId,
  onFocusMainComposer,
}: {
  mainThreadId: ThreadId;
  onFocusMainComposer: () => void;
}) {
  const threadId = useSideChatStore((state) => state.threadId);
  const presentation = useSideChatStore((state) => state.presentation);
  const closedThreadId = useSideChatStore((state) => state.closedThreadId);
  const show = useSideChatStore((state) => state.show);
  const clearMissing = useSideChatStore((state) => state.clearMissing);
  const completeCreate = useSideChatStore((state) => state.completeCreate);
  const thread = useStore((state) =>
    threadId ? state.threads.find((entry) => entry.id === threadId) : undefined,
  );
  const recoverableThreadId = useStore(
    (state) =>
      state.threads.find(
        (entry) =>
          entry.purpose === "side-chat" && entry.deletingAt === null && entry.id !== closedThreadId,
      )?.id,
  );
  const project = useStore((state) =>
    thread ? state.projects.find((entry) => entry.id === thread.projectId) : undefined,
  );

  useEffect(() => {
    if (!threadId && recoverableThreadId) {
      show(recoverableThreadId);
    }
  }, [recoverableThreadId, show, threadId]);

  useEffect(() => {
    if (!threadId) {
      return;
    }
    if (!thread) {
      if (presentation !== "creating" && presentation !== "closing") {
        clearMissing(threadId);
      }
      return;
    }
    if (presentation === "creating" && thread.purpose === "side-chat") {
      completeCreate(threadId);
    }
  }, [clearMissing, completeCreate, presentation, thread, threadId]);

  if (!threadId || presentation !== "open" || !thread) {
    return null;
  }

  return (
    <FloatingSideChat
      mainThreadId={mainThreadId}
      messageCount={thread.messages.length}
      onFocusMainComposer={onFocusMainComposer}
      threadId={thread.id}
      workspaceRoot={thread.worktreePath ?? project?.cwd ?? undefined}
    />
  );
}
