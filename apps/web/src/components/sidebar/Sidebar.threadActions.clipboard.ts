import { type ThreadId } from "@bigbud/contracts";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { toastManager } from "../ui/toast";

export interface SidebarThreadClipboardActions {
  copyThreadIdToClipboard: (value: string, context: { threadId: ThreadId }) => void;
  copyPathToClipboard: (value: string, context: { path: string }) => void;
}

export function useSidebarThreadClipboardActions(): SidebarThreadClipboardActions {
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy thread ID",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });

  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    },
  });

  return {
    copyThreadIdToClipboard,
    copyPathToClipboard,
  };
}
