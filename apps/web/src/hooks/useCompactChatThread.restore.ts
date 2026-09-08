import type { ProjectId, ThreadId } from "@bigbud/contracts";
import { useEffect, type Dispatch, type SetStateAction } from "react";

import { readNativeApi } from "~/rpc/nativeApi";
import { runBoundedBootstrap } from "~/routes/-__root.bounded-bootstrap";
import { useComposerDraftStore } from "~/stores/composer";
import {
  applyCanonicalOwnership,
  initializeOwnershipFromComposer,
  replaceCanonicalOwnershipCollision,
} from "~/stores/ownership/ownershipLedger.reconcile";
import { createOwnershipReplacementThreadId } from "./useHandleNewThread.ownership";

interface CompactThreadState {
  readonly projectId: ProjectId;
  readonly restoring: boolean;
  readonly threadId: ThreadId;
  readonly persistedMaterialized: boolean;
}

export function useCompactChatOwnershipRestoration(input: {
  readonly abandonCurrentThread: () => void;
  readonly bootstrapComplete: boolean;
  readonly persistedMaterialized: boolean;
  readonly restoring: boolean;
  readonly setThreadState: Dispatch<SetStateAction<CompactThreadState>>;
  readonly setThreadSyncError: Dispatch<SetStateAction<string | null>>;
  readonly threadId: ThreadId;
}): void {
  const {
    abandonCurrentThread,
    bootstrapComplete,
    persistedMaterialized,
    restoring,
    setThreadState,
    setThreadSyncError,
    threadId,
  } = input;

  useEffect(() => {
    if (!restoring || !bootstrapComplete) return;
    const api = readNativeApi();
    if (!api) {
      setThreadSyncError("bigbud is not connected to the server.");
      return;
    }

    let disposed = false;
    void (async () => {
      try {
        const ownership = await api.orchestration.resolveThreadOwnership({ threadId });
        if (disposed) return;
        if (ownership.status === "unavailable") {
          setThreadSyncError(ownership.reason);
          return;
        }
        if (ownership.status === "absent") {
          const hasLocalDraft = Boolean(useComposerDraftStore.getState().getDraftThread(threadId));
          if (persistedMaterialized && !hasLocalDraft) {
            abandonCurrentThread();
            return;
          }
          setThreadSyncError(null);
          setThreadState((current) =>
            current.threadId === threadId
              ? { ...current, restoring: false, persistedMaterialized: false }
              : current,
          );
          return;
        }
        if (ownership.status === "active") {
          await initializeOwnershipFromComposer({ scope: "compact" });
          await applyCanonicalOwnership(ownership, "compact");
          await runBoundedBootstrap({ api, selectedThreadId: threadId, disposed: () => disposed });
          if (disposed) return;
          setThreadSyncError(null);
          setThreadState((current) =>
            current.threadId === threadId
              ? {
                  ...current,
                  projectId: ownership.projectId,
                  restoring: false,
                  persistedMaterialized: true,
                }
              : current,
          );
          return;
        }

        const draft = useComposerDraftStore.getState().getDraftThread(threadId);
        if (!draft) {
          abandonCurrentThread();
          return;
        }
        await initializeOwnershipFromComposer({ scope: "compact" });
        const nextThreadId = await createOwnershipReplacementThreadId(ownership);
        await replaceCanonicalOwnershipCollision({
          ownership,
          createThreadId: () => nextThreadId,
          scope: "compact",
        });
        if (disposed) return;
        setThreadSyncError(null);
        setThreadState({
          projectId: draft.projectId,
          restoring: false,
          threadId: nextThreadId,
          persistedMaterialized: false,
        });
      } catch (error) {
        if (!disposed) {
          setThreadSyncError(
            error instanceof Error ? error.message : "Canonical ownership could not be checked.",
          );
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [
    abandonCurrentThread,
    bootstrapComplete,
    persistedMaterialized,
    restoring,
    setThreadState,
    setThreadSyncError,
    threadId,
  ]);
}
