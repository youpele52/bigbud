import { useComposerDraftStore } from "../composer/composer.store";
import type { DraftThreadState } from "../composer/types.store";
import type { OwnershipLedger, OwnershipScope } from "./ownershipLedger.types";

export function applyOwnershipLedgerToComposer(
  ledger: OwnershipLedger,
  scope: OwnershipScope = "main",
): void {
  const scopedOwnership = ledger.scopes[scope];
  if (!scopedOwnership) return;
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
