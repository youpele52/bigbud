import { BUILT_IN_CHATS_PROJECT_ID, type ModelSelection, type ProjectId } from "@bigbud/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useMobileSessionState } from "../context/MobileSessionContext";
import {
  createMobileDraftThread,
  makeMobileComposerDraftIdentity,
  setMobileDraftThread,
} from "../lib/mobileDraftThread";

export function useMobileNewThread() {
  const navigate = useNavigate();
  const { session } = useMobileSessionState();

  const startNewThread = useCallback(
    (projectId: ProjectId, modelSelection: ModelSelection | null = null) => {
      const draft = createMobileDraftThread(projectId, modelSelection);
      if (session) {
        setMobileDraftThread(
          makeMobileComposerDraftIdentity({
            backendBaseUrl: session.backendBaseUrl,
            sessionId: session.sessionId,
            threadId: draft.threadId,
          }),
          draft,
        );
      }
      void navigate({
        to: "/mobile/thread/$threadId",
        params: { threadId: draft.threadId },
      });
    },
    [navigate, session],
  );

  const startNewChat = useCallback(
    (modelSelection: ModelSelection | null = null) => {
      startNewThread(BUILT_IN_CHATS_PROJECT_ID, modelSelection);
    },
    [startNewThread],
  );

  return { startNewThread, startNewChat };
}
