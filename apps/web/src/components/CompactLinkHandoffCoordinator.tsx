import type { CompactChatLinkHandoff, DesktopMenuAction } from "@bigbud/contracts/server/ipc.ts";
import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";

import { openBrowserPanel } from "~/stores/browser/browserPanel.actions";
import { useStore } from "~/stores/main";
import { openChatFileTarget } from "./chat/common/chatFileTargets";
import {
  handleCompactLinkHandoff,
  resolveCompactLinkWorkspaceRoot,
} from "./CompactLinkHandoffCoordinator.logic";

function isCompactChatLinkAction(action: DesktopMenuAction): action is CompactChatLinkHandoff {
  return typeof action !== "string" && action.type === "compact-chat-link";
}

function resolveFallbackWorkspaceRoot(handoff: CompactChatLinkHandoff): string | undefined {
  const thread = useStore.getState().threads.find((entry) => entry.id === handoff.threadId);
  const project = thread
    ? useStore.getState().projects.find((entry) => entry.id === thread.projectId)
    : undefined;
  return thread?.worktreePath ?? project?.cwd ?? undefined;
}

export function CompactLinkHandoffCoordinator() {
  const navigate = useNavigate();
  const latestRequestRef = useRef(0);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;

    const unsubscribe = onMenuAction((action) => {
      if (!isCompactChatLinkAction(action)) return;

      const requestId = latestRequestRef.current + 1;
      latestRequestRef.current = requestId;
      void handleCompactLinkHandoff({
        action,
        navigateToThread: (threadId) =>
          navigate({ to: "/$threadId", params: { threadId } }).then(() => undefined),
        workspaceRoot: () =>
          resolveCompactLinkWorkspaceRoot(action, resolveFallbackWorkspaceRoot(action)),
        isCurrent: () => latestRequestRef.current === requestId,
        openFile: (targetPath, workspaceRoot) => openChatFileTarget(targetPath, workspaceRoot),
        openBrowser: (url) => openBrowserPanel({ url }),
      }).catch((error) => {
        if (latestRequestRef.current === requestId) {
          console.error("Failed to open compact chat markdown link:", error);
        }
      });
    });

    return () => {
      latestRequestRef.current += 1;
      unsubscribe?.();
    };
  }, [navigate]);

  return null;
}
