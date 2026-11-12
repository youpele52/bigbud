import type { ModelSelection, ProjectId, ThreadId } from "@bigbud/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { useComposerDraftStore } from "~/stores/composer";
import type { DraftThreadState } from "~/stores/composer/types.store";
import { useStore } from "~/stores/main";
import { readOwnershipLedger, registerDraftOwnership } from "~/stores/ownership/ownershipLedger";
import {
  initializeOwnershipFromComposer,
  reconcileComposerFromOwnershipLedger,
} from "~/stores/ownership/ownershipLedger.reconcile";

function metadataKey(draft: DraftThreadState | null): string {
  if (!draft) return "absent";
  return JSON.stringify([
    draft.projectId,
    draft.createdAt,
    draft.runtimeMode,
    draft.interactionMode,
    draft.branch,
    draft.worktreePath,
    draft.envMode,
    draft.worktreeBinding ?? null,
  ]);
}

/** Publish fresh compact drafts through the same durable authority as the coordinator. */
export function useCompactChatDraftOwnership(input: {
  readonly enabled: boolean;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly initialSelection: ModelSelection | null;
  readonly captureSurface: () => () => boolean;
  readonly setThreadSyncError: (error: string | null) => void;
}) {
  const { enabled, threadId, projectId, initialSelection, captureSurface, setThreadSyncError } =
    input;
  const [attempt, setAttempt] = useState(0);
  const seed = useRef({ threadId, createdAt: new Date().toISOString() });
  if (seed.current.threadId !== threadId)
    seed.current = { threadId, createdAt: new Date().toISOString() };
  useEffect(() => {
    if (!enabled) return;
    const createdAt = seed.current.createdAt;
    let disposed = false;
    const isCurrent = captureSurface();
    const assertCurrent = () => {
      const current = useComposerDraftStore.getState().getDraftThread(threadId);
      if (
        disposed ||
        !isCurrent() ||
        (current && current.projectId !== projectId) ||
        useStore.getState().threads.some((t) => t.id === threadId)
      ) {
        throw new Error("Compact draft creation was superseded.");
      }
    };
    const create = async () => {
      const initialized = readOwnershipLedger();
      if (initialized.status !== "ready") throw new Error("Compact ownership is unavailable.");
      if (!initialized.value.initializedScopes.compact) {
        await initializeOwnershipFromComposer({ scope: "compact" });
      }
      assertCurrent();
      const existing = useComposerDraftStore.getState().getDraftThread(threadId);
      if (existing && existing.projectId !== projectId) {
        throw new Error("Compact draft project changed.");
      }
      const draft: DraftThreadState = existing ?? {
        projectId,
        createdAt,
        branch: null,
        worktreePath: null,
        envMode: "local",
        interactionMode: "default",
        runtimeMode: "approval-required",
      };
      const before = readOwnershipLedger();
      if (before.status !== "ready") throw new Error("Compact ownership is unavailable.");
      const generation = before.value.scopes.compact.draftsByThreadId[threadId]?.generation;
      const expectedMetadata = metadataKey(existing);
      const expectedOwnerMetadata = metadataKey(
        before.value.scopes.compact.draftsByThreadId[threadId] ?? null,
      );
      await registerDraftOwnership({
        scope: "compact",
        threadId,
        draft,
        bindProject: true,
        expectedGeneration: generation,
        assertCurrent: () => {
          assertCurrent();
          const latest = readOwnershipLedger();
          if (
            latest.status !== "ready" ||
            latest.value.scopes.compact.draftsByThreadId[threadId]?.generation !== generation ||
            metadataKey(latest.value.scopes.compact.draftsByThreadId[threadId] ?? null) !==
              expectedOwnerMetadata ||
            metadataKey(useComposerDraftStore.getState().getDraftThread(threadId)) !==
              expectedMetadata
          ) {
            throw new Error(
              "Compact draft changed while it was being saved. Retry to keep the latest draft.",
            );
          }
        },
      });
      assertCurrent();
      reconcileComposerFromOwnershipLedger("compact");
      const composer = useComposerDraftStore.getState();
      const content = composer.draftsByThreadId[threadId];
      if (
        initialSelection &&
        !content?.activeProvider &&
        Object.keys(content?.modelSelectionByProvider ?? {}).length === 0
      ) {
        composer.setModelSelection(threadId, initialSelection);
      }
      setThreadSyncError(null);
    };
    void create().catch((error) => {
      if (!disposed && isCurrent() && !useStore.getState().threads.some((t) => t.id === threadId)) {
        setThreadSyncError(
          error instanceof Error ? error.message : "Compact draft could not be saved.",
        );
      }
    });
    return () => {
      disposed = true;
    };
  }, [enabled, threadId, projectId, initialSelection, captureSurface, setThreadSyncError, attempt]);
  return useCallback(() => setAttempt((value) => value + 1), []);
}
