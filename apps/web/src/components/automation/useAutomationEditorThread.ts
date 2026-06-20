import { type ProjectId, type ThreadId } from "@bigbud/contracts";
import { useEffect, useMemo, useState } from "react";

import { AUTOMATION_AUTHORING_RUNTIME_MODE } from "~/lib/automation";
import { newThreadId } from "~/lib/utils";
import { type Thread } from "~/models/types";
import { useComposerDraftStore } from "~/stores/composer";
import { useStore } from "~/stores/main";

export function useAutomationEditorThread(projectId: ProjectId | null, scopeKey: string | null) {
  const threads = useStore((store) => store.threads);
  const [threadId, setThreadId] = useState<ThreadId | null>(null);

  useEffect(() => {
    if (!projectId || !scopeKey) {
      setThreadId(null);
      return;
    }

    const nextThreadId = newThreadId();
    useComposerDraftStore.getState().setDraftThreadContext(nextThreadId, {
      projectId,
      createdAt: new Date().toISOString(),
      interactionMode: "default",
      runtimeMode: AUTOMATION_AUTHORING_RUNTIME_MODE,
    });
    useComposerDraftStore.getState().applyStickyState(nextThreadId);
    setThreadId(nextThreadId);

    return () => {
      useComposerDraftStore.getState().clearDraftThread(nextThreadId);
    };
  }, [projectId, scopeKey]);

  const thread = useMemo<Thread | null>(
    () => (threadId ? (threads.find((entry) => entry.id === threadId) ?? null) : null),
    [threadId, threads],
  );

  return {
    thread,
    threadId,
  };
}
