import { useComposerDraftStore } from "../composer/composer.store";
import type { DraftThreadState } from "../composer/types.store";
import type { OwnershipLedger, OwnershipScope } from "./ownershipLedger.types";
import { findOwnershipReplacement } from "./ownershipLedger.replacements";

export function applyOwnershipLedgerToComposer(
  ledger: OwnershipLedger,
  scope: OwnershipScope = "main",
): void {
  const scopedOwnership = ledger.scopes[scope];
  if (!scopedOwnership) return;
  // Ledger listeners run before the replacing caller resumes. Move the composer
  // while its original draft metadata still exists, before exposing the new ID.
  for (const threadId of Object.keys(useComposerDraftStore.getState().draftThreadsByThreadId)) {
    const invalidation = ledger.invalidationsByThreadId[threadId];
    if (!invalidation) continue;
    const replacement = findOwnershipReplacement(ledger, threadId, scope);
    if (!replacement) continue;
    useComposerDraftStore.getState().replaceCollidingDraftThread({
      threadId: invalidation.threadId,
      nextThreadId: replacement.threadId,
      projectId: replacement.projectId,
      createdAt: replacement.createdAt,
    });
  }
  const draftThreadsByThreadId = Object.fromEntries(
    Object.entries(scopedOwnership.draftsByThreadId).map(([threadId, draft]) => {
      const { generation: _generation, threadId: _threadId, ...state } = draft;
      return [threadId, state satisfies DraftThreadState];
    }),
  );
  const projectDraftThreadIdByProjectId = Object.fromEntries(
    Object.entries(scopedOwnership.projectBindingsByProjectId).flatMap(([projectId, binding]) => {
      const draft = scopedOwnership.draftsByThreadId[binding.threadId];
      return draft?.generation === binding.generation ? [[projectId, binding.threadId]] : [];
    }),
  );
  useComposerDraftStore.setState({
    draftThreadsByThreadId,
    projectDraftThreadIdByProjectId,
  });
}
