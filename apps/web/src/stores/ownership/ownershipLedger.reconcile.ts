import type { GetThreadOwnershipResult, ThreadId } from "@bigbud/contracts";

import { flushComposerDraftPersistence, useComposerDraftStore } from "../composer/composer.store";
import { applyOwnershipLedgerToComposer } from "./ownershipLedger.composer";
import {
  initializeOwnershipLedger,
  invalidateCanonicalOwnership,
  readOwnershipLedger,
  replaceCollidingDraftOwnership,
} from "./ownershipLedger";
import type { OwnershipScope } from "./ownershipLedger.types";

type CanonicalOwnership = Exclude<
  GetThreadOwnershipResult,
  { readonly status: "absent" | "unavailable" }
>;

function requireReadyLedger() {
  const result = readOwnershipLedger();
  if (result.status === "unavailable") {
    throw new Error(`Ownership ledger unavailable: ${result.reason}`);
  }
  if (result.value.revision === 0) throw new Error("Ownership ledger is not initialized.");
  return result.value;
}

export async function initializeOwnershipFromComposer(
  input: { readonly scope?: OwnershipScope } = {},
): Promise<void> {
  const scope = input.scope ?? "main";
  const state = useComposerDraftStore.getState();
  const ledger = await initializeOwnershipLedger({
    scope,
    draftsByThreadId: state.draftThreadsByThreadId,
    projectDraftThreadIdByProjectId: state.projectDraftThreadIdByProjectId,
  });
  applyOwnershipLedgerToComposer(ledger, scope);
  flushComposerDraftPersistence();
}

export function reconcileComposerFromOwnershipLedger(scope: OwnershipScope = "main"): void {
  const ledger = requireReadyLedger();
  if (!ledger.initializedScopes[scope]) return;
  applyOwnershipLedgerToComposer(ledger, scope);
  flushComposerDraftPersistence();
}

export async function applyCanonicalOwnership(
  ownership: CanonicalOwnership,
  scope: OwnershipScope = "main",
): Promise<void> {
  await invalidateCanonicalOwnership({
    threadId: ownership.threadId,
    status: ownership.status,
    serverEpoch: ownership.serverEpoch,
    canonicalRevision: ownership.canonicalRevision,
    invalidatedAt: new Date().toISOString(),
  });
  reconcileComposerFromOwnershipLedger(scope);
}

export async function replaceCanonicalOwnershipCollision(input: {
  readonly ownership: CanonicalOwnership;
  readonly createThreadId: () => ThreadId;
  readonly scope?: OwnershipScope | undefined;
}): Promise<ThreadId> {
  const scope = input.scope ?? "main";
  const result = await replaceCollidingDraftOwnership({
    scope,
    threadId: input.ownership.threadId,
    status: input.ownership.status,
    serverEpoch: input.ownership.serverEpoch,
    canonicalRevision: input.ownership.canonicalRevision,
    invalidatedAt: new Date().toISOString(),
    createThreadId: input.createThreadId,
  });
  useComposerDraftStore.getState().replaceCollidingDraftThread({
    threadId: input.ownership.threadId,
    nextThreadId: result.replacement.threadId,
    projectId: result.replacement.projectId,
    createdAt: result.replacement.createdAt,
  });
  reconcileComposerFromOwnershipLedger(scope);
  return result.replacement.threadId;
}
