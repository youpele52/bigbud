import { type NativeApi, type ProjectId, type ThreadId } from "@bigbud/contracts";
import { useEffect, useMemo, useState } from "react";

import { AUTOMATION_AUTHORING_RUNTIME_MODE } from "~/lib/automation";
import { newCommandId, newThreadId } from "~/lib/utils";
import { type Thread } from "~/models/types";
import { useComposerDraftStore } from "~/stores/composer";
import { useStore } from "~/stores/main";

export function useAutomationBuilderThread(projectId: ProjectId | null) {
  const threads = useStore((store) => store.threads);
  const [builderThreadId, setBuilderThreadId] = useState<ThreadId | null>(null);

  useEffect(() => {
    if (!projectId) {
      setBuilderThreadId(null);
      return;
    }

    const store = useComposerDraftStore.getState();
    const threadId = newThreadId();
    store.setDraftThreadContext(threadId, {
      projectId,
      createdAt: new Date().toISOString(),
      interactionMode: "default",
      runtimeMode: AUTOMATION_AUTHORING_RUNTIME_MODE,
    });
    store.applyStickyState(threadId);
    setBuilderThreadId(threadId);

    return () => {
      useComposerDraftStore.getState().clearDraftThread(threadId);
    };
  }, [projectId]);

  const builderThread = useMemo<Thread | null>(
    () =>
      builderThreadId ? (threads.find((thread) => thread.id === builderThreadId) ?? null) : null,
    [builderThreadId, threads],
  );

  return {
    builderThread,
    builderThreadId,
  };
}

export async function disposeAutomationBuilderThread(
  api: NativeApi,
  builderThreadId: ThreadId | null,
) {
  if (!builderThreadId) {
    return;
  }

  useComposerDraftStore.getState().clearDraftThread(builderThreadId);

  try {
    await api.orchestration.dispatchCommand({
      type: "thread.delete",
      commandId: newCommandId(),
      threadId: builderThreadId,
    });
  } catch {
    // Best-effort cleanup only.
  }
}
