import type { LedgerStorage } from "../ledger/revisionedLedger";
import {
  OWNERSHIP_SCOPES,
  type OwnershipDraftRecord,
  type OwnershipInvalidation,
  type OwnershipLedger,
  type OwnershipLedgerReadResult,
  type OwnershipProjectBinding,
  type OwnershipScopeState,
} from "./ownershipLedger.types";

export const OWNERSHIP_LEDGER_KEY = "bigbud:draft-ownership-ledger:v1";
export const OWNERSHIP_LEDGER_CHANNEL = "bigbud:draft-ownership-ledger:v1";
export const OWNERSHIP_LEDGER_MAX_DRAFTS = 256;
export const OWNERSHIP_LEDGER_MAX_INVALIDATIONS = 2_048;

export const emptyOwnershipScopeState = (): OwnershipScopeState => ({
  draftsByThreadId: {},
  projectBindingsByProjectId: {},
});

export const emptyOwnershipLedger = (): OwnershipLedger => ({
  version: 1,
  revision: 0,
  lastMutationId: "initial",
  nextGeneration: 1,
  invalidatedThroughGeneration: 0,
  initializedScopes: { main: false, compact: false },
  scopes: { main: emptyOwnershipScopeState(), compact: emptyOwnershipScopeState() },
  invalidationsByThreadId: {},
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDraft(value: unknown): value is OwnershipDraftRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.threadId === "string" &&
    typeof value.projectId === "string" &&
    Number.isSafeInteger(value.generation) &&
    typeof value.createdAt === "string" &&
    typeof value.runtimeMode === "string" &&
    typeof value.interactionMode === "string" &&
    (value.branch === null || typeof value.branch === "string") &&
    (value.worktreePath === null || typeof value.worktreePath === "string") &&
    (value.envMode === "local" || value.envMode === "worktree")
  );
}

function isBinding(value: unknown): value is OwnershipProjectBinding {
  if (!isRecord(value)) return false;
  return (
    typeof value.projectId === "string" &&
    typeof value.threadId === "string" &&
    Number.isSafeInteger(value.generation)
  );
}

function isScopeState(value: unknown): value is OwnershipScopeState {
  if (!isRecord(value) || !isRecord(value.draftsByThreadId)) return false;
  if (!isRecord(value.projectBindingsByProjectId)) return false;
  return (
    Object.values(value.draftsByThreadId).every((draft) => isDraft(draft)) &&
    Object.values(value.projectBindingsByProjectId).every((binding) => isBinding(binding))
  );
}

function isInvalidation(value: unknown): value is OwnershipInvalidation {
  if (!isRecord(value)) return false;
  return (
    typeof value.threadId === "string" &&
    Number.isSafeInteger(value.invalidatedGeneration) &&
    (value.status === "active" ||
      value.status === "archived" ||
      value.status === "deleting" ||
      value.status === "deleted") &&
    typeof value.serverEpoch === "string" &&
    Number.isSafeInteger(value.canonicalRevision) &&
    typeof value.invalidatedAt === "string" &&
    (value.replacementThreadId === null || typeof value.replacementThreadId === "string") &&
    (value.replacementThreadIdByScope === undefined ||
      (isRecord(value.replacementThreadIdByScope) &&
        Object.entries(value.replacementThreadIdByScope).every(
          ([scope, threadId]) =>
            (scope === "main" || scope === "compact") && typeof threadId === "string",
        )))
  );
}

function isInvalidationsRecord(value: unknown): value is Record<string, OwnershipInvalidation> {
  return isRecord(value) && Object.values(value).every((item) => isInvalidation(item));
}

function isScopedLedger(
  value: Record<string, unknown>,
): value is Record<string, unknown> & OwnershipLedger {
  const initializedScopes = value.initializedScopes;
  const scopes = value.scopes;
  return (
    value.version === 1 &&
    Number.isSafeInteger(value.revision) &&
    typeof value.lastMutationId === "string" &&
    Number.isSafeInteger(value.nextGeneration) &&
    Number.isSafeInteger(value.invalidatedThroughGeneration) &&
    isRecord(initializedScopes) &&
    OWNERSHIP_SCOPES.every((scope) => typeof initializedScopes[scope] === "boolean") &&
    isRecord(scopes) &&
    OWNERSHIP_SCOPES.every((scope) => isScopeState(scopes[scope])) &&
    isInvalidationsRecord(value.invalidationsByThreadId)
  );
}

function migrateLegacyOwnershipLedger(value: Record<string, unknown>): OwnershipLedger | null {
  if (
    value.version !== 1 ||
    !isRecord(value.draftsByThreadId) ||
    !isRecord(value.projectBindingsByProjectId) ||
    Object.values(value.draftsByThreadId).some((item) => !isDraft(item)) ||
    Object.values(value.projectBindingsByProjectId).some((item) => !isBinding(item))
  ) {
    return null;
  }
  const revision = Number.isSafeInteger(value.revision) ? (value.revision as number) : 0;
  return {
    version: 1,
    revision,
    lastMutationId: typeof value.lastMutationId === "string" ? value.lastMutationId : "legacy",
    nextGeneration: Number.isSafeInteger(value.nextGeneration)
      ? (value.nextGeneration as number)
      : 1,
    invalidatedThroughGeneration: Number.isSafeInteger(value.invalidatedThroughGeneration)
      ? (value.invalidatedThroughGeneration as number)
      : 0,
    initializedScopes: {
      main: revision > 0 || Object.keys(value.draftsByThreadId).length > 0,
      compact: false,
    },
    scopes: {
      main: {
        draftsByThreadId: value.draftsByThreadId as Record<string, OwnershipDraftRecord>,
        projectBindingsByProjectId: value.projectBindingsByProjectId as Record<
          string,
          OwnershipProjectBinding
        >,
      },
      compact: emptyOwnershipScopeState(),
    },
    invalidationsByThreadId: isInvalidationsRecord(value.invalidationsByThreadId)
      ? value.invalidationsByThreadId
      : {},
  };
}

export function readOwnershipLedger(storage: LedgerStorage | null): OwnershipLedgerReadResult {
  if (!storage) return { status: "unavailable", reason: "storage" };
  let raw: string | null;
  try {
    raw = storage.getItem(OWNERSHIP_LEDGER_KEY);
  } catch {
    return { status: "unavailable", reason: "storage" };
  }
  if (raw === null) return { status: "ready", value: emptyOwnershipLedger() };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (isScopedLedger(value)) {
      return { status: "ready", value: value as unknown as OwnershipLedger };
    }
    const migrated = migrateLegacyOwnershipLedger(value);
    return migrated
      ? { status: "ready", value: migrated }
      : { status: "unavailable", reason: "corrupt" };
  } catch {
    return { status: "unavailable", reason: "corrupt" };
  }
}
