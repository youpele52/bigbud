import { type ThreadId } from "@bigbud/contracts";
import { useCallback, useRef, useState } from "react";
import { newCommandId } from "../../lib/utils";
import { readNativeApi } from "../../rpc/nativeApi";
import { toastManager } from "../ui/toast";

export function useSidebarThreadRenameActions() {
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);

  const cancelRename = useCallback(() => {
    setRenamingThreadId(null);
    renamingInputRef.current = null;
  }, []);

  const onRenamingInputMount = useCallback((element: HTMLInputElement | null) => {
    if (element && renamingInputRef.current !== element) {
      renamingInputRef.current = element;
      element.focus();
      element.select();
      return;
    }
    if (element === null && renamingInputRef.current !== null) {
      renamingInputRef.current = null;
    }
  }, []);

  const hasRenameCommitted = useCallback(() => renamingCommittedRef.current, []);

  const markRenameCommitted = useCallback(() => {
    renamingCommittedRef.current = true;
  }, []);

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingThreadId((current) => {
          if (current !== threadId) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: "Thread title cannot be empty",
        });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

  return {
    renamingThreadId,
    setRenamingThreadId,
    renamingTitle,
    setRenamingTitle,
    renamingCommittedRef,
    cancelRename,
    onRenamingInputMount,
    hasRenameCommitted,
    markRenameCommitted,
    commitRename,
  };
}
