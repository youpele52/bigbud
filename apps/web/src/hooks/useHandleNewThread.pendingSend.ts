import type { ThreadId } from "@bigbud/contracts";
import type { ProjectDraftThread } from "../stores/composer/types.store";
import { useComposerDraftStore } from "../stores/composer/composer.store";
import { readMaterializationLedger } from "../stores/materialization/materializationLedger";
import { registerDraftOwnership } from "../stores/ownership/ownershipLedger";
import { reconcileComposerFromOwnershipLedger } from "../stores/ownership/ownershipLedger.reconcile";
import { newThreadId } from "../lib/utils";

const pendingCreations = new Map<ThreadId, Promise<ThreadId | null>>();

// New Thread must not reuse a draft whose command may already be executing.
// Register a separate draft through ownership so rebinding preserves the old content.
export async function preservePendingSendForNewThread(
  draft: ProjectDraftThread,
): Promise<ThreadId | null> {
  const pending = pendingCreations.get(draft.threadId);
  if (pending) return pending;
  const creation = createIndependentDraft(draft).finally(() => {
    pendingCreations.delete(draft.threadId);
  });
  pendingCreations.set(draft.threadId, creation);
  return creation;
}

async function createIndependentDraft(draft: ProjectDraftThread): Promise<ThreadId | null> {
  const ledger = readMaterializationLedger();
  if (ledger.status === "unavailable") {
    throw new Error("bigbud cannot safely read saved send state.");
  }
  if (!ledger.value.attemptsByThreadId[draft.threadId]) return null;

  const boundDraft = useComposerDraftStore.getState().getDraftThreadByProjectId(draft.projectId);
  if (
    boundDraft &&
    boundDraft.threadId !== draft.threadId &&
    !ledger.value.attemptsByThreadId[boundDraft.threadId]
  ) {
    return boundDraft.threadId;
  }

  const threadId = newThreadId();
  await registerDraftOwnership({
    threadId,
    scope: "main",
    bindProject: true,
    draft: {
      projectId: draft.projectId,
      createdAt: new Date().toISOString(),
      branch: draft.branch,
      worktreePath: draft.worktreePath,
      envMode: draft.envMode,
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
    },
  });
  reconcileComposerFromOwnershipLedger();
  useComposerDraftStore.getState().applyStickyState(threadId);
  return threadId;
}
