import type {
  OwnershipDraftRecord,
  OwnershipLedger,
  OwnershipScope,
} from "./ownershipLedger.types";

/** Follow missed replacement revisions, stopping at a live draft or a cycle. */
export function findOwnershipReplacement(
  ledger: OwnershipLedger,
  threadId: string,
  scope: OwnershipScope,
): OwnershipDraftRecord | undefined {
  const visited = new Set<string>([threadId]);
  let currentId = threadId;
  for (;;) {
    const invalidation = ledger.invalidationsByThreadId[currentId];
    if (!invalidation) return undefined;
    const nextId = invalidation.replacementThreadIdByScope
      ? invalidation.replacementThreadIdByScope[scope]
      : scope === "main"
        ? invalidation.replacementThreadId
        : null;
    if (!nextId || visited.has(nextId)) return undefined;
    const replacement = ledger.scopes[scope].draftsByThreadId[nextId];
    if (replacement) return replacement;
    visited.add(nextId);
    currentId = nextId;
  }
}
