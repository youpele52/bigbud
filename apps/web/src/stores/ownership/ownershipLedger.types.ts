import type { ProjectId, ProviderInteractionMode, RuntimeMode, ThreadId } from "@bigbud/contracts";
import type { DraftThreadEnvMode } from "../composer/types.store";

export const OWNERSHIP_SCOPES = ["main", "compact"] as const;
export type OwnershipScope = (typeof OWNERSHIP_SCOPES)[number];

export interface OwnershipDraftRecord {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly generation: number;
  readonly createdAt: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly envMode: DraftThreadEnvMode;
}

export interface OwnershipProjectBinding {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly generation: number;
}

export interface OwnershipScopeState {
  readonly draftsByThreadId: Readonly<Record<string, OwnershipDraftRecord>>;
  readonly projectBindingsByProjectId: Readonly<Record<string, OwnershipProjectBinding>>;
}

export interface OwnershipInvalidation {
  readonly threadId: ThreadId;
  readonly invalidatedGeneration: number;
  readonly status: "active" | "archived" | "deleting" | "deleted";
  readonly serverEpoch: string;
  readonly canonicalRevision: number;
  readonly invalidatedAt: string;
  readonly replacementThreadId: ThreadId | null;
  readonly replacementThreadIdByScope: Readonly<Partial<Record<OwnershipScope, ThreadId>>>;
}

export interface OwnershipLedger {
  readonly version: 1;
  readonly revision: number;
  readonly lastMutationId: string;
  readonly nextGeneration: number;
  readonly invalidatedThroughGeneration: number;
  readonly initializedScopes: Readonly<Record<OwnershipScope, boolean>>;
  readonly scopes: Readonly<Record<OwnershipScope, OwnershipScopeState>>;
  readonly invalidationsByThreadId: Readonly<Record<string, OwnershipInvalidation>>;
}

export type OwnershipLedgerReadResult =
  | { readonly status: "ready"; readonly value: OwnershipLedger }
  | { readonly status: "unavailable"; readonly reason: "corrupt" | "storage" };

export class OwnershipLedgerUnavailableError extends Error {
  readonly code = "ownership_ledger_unavailable";
}

export class OwnershipLedgerOverloadedError extends Error {
  readonly code = "ownership_ledger_overloaded";
}
