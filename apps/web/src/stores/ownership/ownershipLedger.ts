import { ProjectId, ThreadId } from "@bigbud/contracts";

import type { DraftThreadState } from "../composer/types.store";
import {
  mutateRevisionedLedger,
  resolveLedgerStorage,
  subscribeToLedgerChanges,
  type LedgerStorage,
  type LockManagerLike,
} from "../ledger/revisionedLedger";
import {
  OWNERSHIP_LEDGER_CHANNEL,
  OWNERSHIP_LEDGER_KEY,
  OWNERSHIP_LEDGER_MAX_DRAFTS,
  OWNERSHIP_LEDGER_MAX_INVALIDATIONS,
  emptyOwnershipScopeState,
  readOwnershipLedger as readStoredLedger,
} from "./ownershipLedger.storage";
import {
  OwnershipLedgerOverloadedError,
  OwnershipLedgerUnavailableError,
  type OwnershipDraftRecord,
  type OwnershipInvalidation,
  type OwnershipLedger,
  type OwnershipLedgerReadResult,
  type OwnershipScope,
  type OwnershipScopeState,
} from "./ownershipLedger.types";

export * from "./ownershipLedger.storage";
export * from "./ownershipLedger.types";

interface MutationOptions {
  readonly storage?: LedgerStorage | null;
  readonly lockManager?: LockManagerLike | null;
}

function storageFrom(options?: MutationOptions): LedgerStorage | null {
  return options?.storage === undefined ? resolveLedgerStorage() : options.storage;
}

export function readOwnershipLedger(
  storage: LedgerStorage | null = resolveLedgerStorage(),
): OwnershipLedgerReadResult {
  return readStoredLedger(storage);
}

async function mutate<TResult>(
  options: MutationOptions | undefined,
  operation: (
    ledger: OwnershipLedger,
    mutationId: string,
  ) => { readonly ledger: OwnershipLedger; readonly result: TResult },
): Promise<TResult> {
  try {
    return await mutateRevisionedLedger({
      key: OWNERSHIP_LEDGER_KEY,
      channelName: OWNERSHIP_LEDGER_CHANNEL,
      storage: storageFrom(options),
      ...(options?.lockManager !== undefined ? { lockManager: options.lockManager } : {}),
      read: readStoredLedger,
      mutate: operation,
    });
  } catch (error) {
    if (error instanceof OwnershipLedgerOverloadedError) throw error;
    throw new OwnershipLedgerUnavailableError(
      error instanceof Error ? error.message : "Ownership ledger is unavailable.",
    );
  }
}

function toRecord(
  threadId: ThreadId,
  draft: DraftThreadState,
  generation: number,
): OwnershipDraftRecord {
  return { threadId, generation, ...draft };
}

function getScopeState(ledger: OwnershipLedger, scope: OwnershipScope): OwnershipScopeState {
  return ledger.scopes[scope] ?? emptyOwnershipScopeState();
}

function replaceScope(
  ledger: OwnershipLedger,
  scope: OwnershipScope,
  scopeState: OwnershipScopeState,
): OwnershipLedger["scopes"] {
  return { ...ledger.scopes, [scope]: scopeState };
}

function replacementIdsForScope(
  invalidation: OwnershipInvalidation | undefined,
  scope: OwnershipScope,
): Readonly<Partial<Record<OwnershipScope, ThreadId>>> {
  return (
    invalidation?.replacementThreadIdByScope ??
    (scope === "main" && invalidation?.replacementThreadId
      ? { main: invalidation.replacementThreadId }
      : {})
  );
}

function keepRecentInvalidations(
  invalidations: Readonly<Record<string, OwnershipInvalidation>>,
): Readonly<Record<string, OwnershipInvalidation>> {
  return Object.fromEntries(
    Object.values(invalidations)
      .toSorted((left, right) => right.invalidatedAt.localeCompare(left.invalidatedAt))
      .slice(0, OWNERSHIP_LEDGER_MAX_INVALIDATIONS)
      .map((item) => [item.threadId, item]),
  );
}

export async function registerDraftOwnership(input: {
  readonly scope?: OwnershipScope | undefined;
  readonly threadId: ThreadId;
  readonly draft: DraftThreadState;
  readonly bindProject: boolean;
  readonly expectedGeneration?: number | undefined;
  readonly options?: MutationOptions | undefined;
}): Promise<OwnershipDraftRecord> {
  return mutate(input.options, (ledger, mutationId) => {
    const scope = input.scope ?? "main";
    const currentScope = getScopeState(ledger, scope);
    const existing = currentScope.draftsByThreadId[input.threadId];
    if (
      input.expectedGeneration !== undefined &&
      existing?.generation !== input.expectedGeneration
    ) {
      throw new OwnershipLedgerUnavailableError("Draft ownership generation is stale.");
    }
    if (!existing && ledger.invalidationsByThreadId[input.threadId]) {
      throw new OwnershipLedgerUnavailableError("Canonical invalidation rejects this draft ID.");
    }
    if (
      !existing &&
      Object.keys(currentScope.draftsByThreadId).length >= OWNERSHIP_LEDGER_MAX_DRAFTS
    ) {
      throw new OwnershipLedgerOverloadedError("Draft ownership capacity is full.");
    }
    const generation = existing?.generation ?? ledger.nextGeneration;
    const record = toRecord(input.threadId, input.draft, generation);
    const bindings = { ...currentScope.projectBindingsByProjectId };
    if (input.bindProject) {
      bindings[input.draft.projectId] = {
        projectId: input.draft.projectId,
        threadId: input.threadId,
        generation,
      };
    }
    return {
      ledger: {
        ...ledger,
        revision: ledger.revision + 1,
        lastMutationId: mutationId,
        nextGeneration: existing ? ledger.nextGeneration : ledger.nextGeneration + 1,
        initializedScopes: { ...ledger.initializedScopes, [scope]: true },
        scopes: replaceScope(ledger, scope, {
          draftsByThreadId: { ...currentScope.draftsByThreadId, [input.threadId]: record },
          projectBindingsByProjectId: bindings,
        }),
      },
      result: record,
    };
  });
}

export async function initializeOwnershipLedger(input: {
  readonly scope?: OwnershipScope | undefined;
  readonly draftsByThreadId: Readonly<Record<string, DraftThreadState>>;
  readonly projectDraftThreadIdByProjectId: Readonly<Record<string, ThreadId>>;
  readonly options?: MutationOptions | undefined;
}): Promise<OwnershipLedger> {
  return mutate(input.options, (ledger, mutationId) => {
    const scope = input.scope ?? "main";
    if (ledger.initializedScopes[scope]) return { ledger, result: ledger };
    let nextGeneration = ledger.nextGeneration;
    const draftsByThreadId: Record<string, OwnershipDraftRecord> = {};
    for (const [threadId, draft] of Object.entries(input.draftsByThreadId)) {
      if (ledger.invalidationsByThreadId[threadId]) continue;
      if (Object.keys(draftsByThreadId).length >= OWNERSHIP_LEDGER_MAX_DRAFTS) {
        throw new OwnershipLedgerOverloadedError("Draft ownership capacity is full.");
      }
      draftsByThreadId[threadId] = toRecord(ThreadId.makeUnsafe(threadId), draft, nextGeneration);
      nextGeneration += 1;
    }
    const projectBindingsByProjectId = Object.fromEntries(
      Object.entries(input.projectDraftThreadIdByProjectId).flatMap(([projectId, threadId]) => {
        const draft = draftsByThreadId[threadId];
        return draft
          ? [
              [
                projectId,
                {
                  projectId: ProjectId.makeUnsafe(projectId),
                  threadId,
                  generation: draft.generation,
                },
              ],
            ]
          : [];
      }),
    );
    const next: OwnershipLedger = {
      ...ledger,
      revision: ledger.revision + 1,
      lastMutationId: mutationId,
      nextGeneration,
      initializedScopes: { ...ledger.initializedScopes, [scope]: true },
      scopes: replaceScope(ledger, scope, { draftsByThreadId, projectBindingsByProjectId }),
    };
    return { ledger: next, result: next };
  });
}

export async function invalidateCanonicalOwnership(input: {
  readonly threadId: ThreadId;
  readonly status: OwnershipInvalidation["status"];
  readonly serverEpoch: string;
  readonly canonicalRevision: number;
  readonly invalidatedAt: string;
  readonly options?: MutationOptions | undefined;
}): Promise<void> {
  await mutate(input.options, (ledger, mutationId) => {
    let invalidatedGeneration = ledger.invalidatedThroughGeneration;
    const scopes = Object.fromEntries(
      Object.entries(ledger.scopes).map(([scope, currentScope]) => {
        const existing = currentScope.draftsByThreadId[input.threadId];
        invalidatedGeneration = Math.max(invalidatedGeneration, existing?.generation ?? 0);
        const drafts = { ...currentScope.draftsByThreadId };
        delete drafts[input.threadId];
        const projectBindingsByProjectId = Object.fromEntries(
          Object.entries(currentScope.projectBindingsByProjectId).filter(
            ([, binding]) => binding.threadId !== input.threadId,
          ),
        );
        return [scope, { draftsByThreadId: drafts, projectBindingsByProjectId }];
      }),
    ) as OwnershipLedger["scopes"];
    const invalidations = {
      ...ledger.invalidationsByThreadId,
      [input.threadId]: {
        threadId: input.threadId,
        invalidatedGeneration,
        status: input.status,
        serverEpoch: input.serverEpoch,
        canonicalRevision: input.canonicalRevision,
        invalidatedAt: input.invalidatedAt,
        replacementThreadId: null,
        replacementThreadIdByScope: {},
      },
    };
    return {
      ledger: {
        ...ledger,
        revision: ledger.revision + 1,
        lastMutationId: mutationId,
        invalidatedThroughGeneration: invalidatedGeneration,
        scopes,
        invalidationsByThreadId: keepRecentInvalidations(invalidations),
      },
      result: undefined,
    };
  });
}

export async function replaceCollidingDraftOwnership(input: {
  readonly scope?: OwnershipScope | undefined;
  readonly threadId: ThreadId;
  readonly status: OwnershipInvalidation["status"];
  readonly serverEpoch: string;
  readonly canonicalRevision: number;
  readonly invalidatedAt: string;
  readonly createThreadId: () => ThreadId;
  readonly options?: MutationOptions | undefined;
}): Promise<{
  readonly previous: OwnershipDraftRecord;
  readonly replacement: OwnershipDraftRecord;
}> {
  return mutate(input.options, (ledger, mutationId) => {
    const scope = input.scope ?? "main";
    const currentScope = getScopeState(ledger, scope);
    const previous = currentScope.draftsByThreadId[input.threadId];
    if (!previous) {
      const invalidation = ledger.invalidationsByThreadId[input.threadId];
      const priorReplacement = replacementIdsForScope(invalidation, scope)[scope];
      const replacement = priorReplacement
        ? currentScope.draftsByThreadId[priorReplacement]
        : undefined;
      if (replacement) return { ledger, result: { previous: replacement, replacement } };
      throw new OwnershipLedgerUnavailableError("Colliding draft ownership is unavailable.");
    }
    const replacementThreadId = input.createThreadId();
    const replacement = toRecord(replacementThreadId, previous, ledger.nextGeneration);
    const drafts = { ...currentScope.draftsByThreadId };
    delete drafts[input.threadId];
    drafts[replacementThreadId] = replacement;
    const projectBindingsByProjectId = Object.fromEntries(
      Object.entries(currentScope.projectBindingsByProjectId).map(([projectId, binding]) => [
        projectId,
        binding.threadId === input.threadId
          ? { ...binding, threadId: replacementThreadId, generation: replacement.generation }
          : binding,
      ]),
    );
    const previousInvalidation = ledger.invalidationsByThreadId[input.threadId];
    const replacementThreadIdByScope = {
      ...replacementIdsForScope(previousInvalidation, scope),
      [scope]: replacementThreadId,
    };
    const invalidations = {
      ...ledger.invalidationsByThreadId,
      [input.threadId]: {
        threadId: input.threadId,
        invalidatedGeneration: previous.generation,
        status: input.status,
        serverEpoch: input.serverEpoch,
        canonicalRevision: input.canonicalRevision,
        invalidatedAt: input.invalidatedAt,
        replacementThreadId,
        replacementThreadIdByScope,
      },
    };
    return {
      ledger: {
        ...ledger,
        revision: ledger.revision + 1,
        lastMutationId: mutationId,
        nextGeneration: ledger.nextGeneration + 1,
        initializedScopes: { ...ledger.initializedScopes, [scope]: true },
        invalidatedThroughGeneration: Math.max(
          ledger.invalidatedThroughGeneration,
          previous.generation,
        ),
        scopes: replaceScope(ledger, scope, {
          draftsByThreadId: drafts,
          projectBindingsByProjectId,
        }),
        invalidationsByThreadId: keepRecentInvalidations(invalidations),
      },
      result: { previous, replacement },
    };
  });
}

export function subscribeToOwnershipLedger(listener: (revision: number) => void): () => void {
  return subscribeToLedgerChanges({
    key: OWNERSHIP_LEDGER_KEY,
    channelName: OWNERSHIP_LEDGER_CHANNEL,
    listener,
  });
}
