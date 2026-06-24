import { BUILT_IN_CHATS_PROJECT_ID, type ProjectId } from "@bigbud/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { createMobileDraftThread, setMobileDraftThread } from "../mobileDraftThread";

export function useMobileNewThread() {
  const navigate = useNavigate();

  const startNewThread = useCallback(
    (projectId: ProjectId) => {
      const draft = createMobileDraftThread(projectId);
      setMobileDraftThread(draft);
      void navigate({
        to: "/mobile/thread/$threadId",
        params: { threadId: draft.threadId },
      });
    },
    [navigate],
  );

  const startNewChat = useCallback(() => {
    startNewThread(BUILT_IN_CHATS_PROJECT_ID);
  }, [startNewThread]);

  return { startNewThread, startNewChat };
}
