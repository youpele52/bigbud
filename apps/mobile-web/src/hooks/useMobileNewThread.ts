import { BUILT_IN_CHATS_PROJECT_ID, type ModelSelection, type ProjectId } from "@bigbud/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { createMobileDraftThread, setMobileDraftThread } from "../lib/mobileDraftThread";

export function useMobileNewThread() {
  const navigate = useNavigate();

  const startNewThread = useCallback(
    (projectId: ProjectId, modelSelection: ModelSelection | null = null) => {
      const draft = createMobileDraftThread(projectId, modelSelection);
      setMobileDraftThread(draft);
      void navigate({
        to: "/mobile/thread/$threadId",
        params: { threadId: draft.threadId },
      });
    },
    [navigate],
  );

  const startNewChat = useCallback(
    (modelSelection: ModelSelection | null = null) => {
      startNewThread(BUILT_IN_CHATS_PROJECT_ID, modelSelection);
    },
    [startNewThread],
  );

  return { startNewThread, startNewChat };
}
