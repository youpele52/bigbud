import { Schema, ServiceMap } from "effect";
import type * as Effect from "effect/Effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

/**
 * The durable start intent (migration 179): everything the worker needs to dispatch the child's
 * `thread.create` and first `thread.turn.start` again, byte-identically, without the request.
 */
export const PeerChildStart = Schema.Struct({
  projectId: Schema.String,
  title: Schema.String,
  task: Schema.String,
  modelSelection: Schema.Struct({ provider: Schema.String, model: Schema.String }),
  runtimeMode: Schema.String,
});
export type PeerChildStart = typeof PeerChildStart.Type;

/** Worker-side record of one delegated child (migration 176 `peer_children`). */
export interface PeerChild {
  readonly commandId: string;
  readonly dispatchId: string;
  readonly coordinatorAuthorityId: string;
  readonly grantId: string;
  readonly childThreadId: string;
  /** sha256 hex of the canonical delegate request; a reused identity must match it. */
  readonly requestDigest: string;
  readonly workspaceRoot: string;
  readonly provider: string;
  readonly createdAt: string;
  readonly cancelRequestedAt: string | null;
  /** Null only for rows recorded before migration 179 (no reconciliation for those). */
  readonly start: PeerChildStart | null;
  /** Both start commands were accepted. */
  readonly startCompletedAt: string | null;
  /** The worker definitively could not start the child; the child is reported failed. */
  readonly startFailure: string | null;
}

/** The dispatch identity already belongs to a different request or grant. */
export class PeerChildConflict extends Schema.TaggedErrorClass<PeerChildConflict>()(
  "PeerChildConflict",
  { commandId: Schema.String, detail: Schema.String },
) {}

export type PeerChildRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface PeerChildRepositoryShape {
  /**
   * Records the child for a dispatch identity, or joins the existing record. A repeated identity
   * joins only when the request digest and grant match; anything else is `PeerChildConflict`.
   */
  readonly claim: (
    child: Omit<PeerChild, "cancelRequestedAt" | "startCompletedAt" | "startFailure">,
  ) => Effect.Effect<
    { readonly child: PeerChild; readonly joined: boolean },
    PeerChildRepositoryError | PeerChildConflict
  >;
  /** The child for a command id, only when it was created under `grantId`. */
  readonly findForGrant: (
    grantId: string,
    commandId: string,
  ) => Effect.Effect<PeerChild | undefined, PeerChildRepositoryError>;
  /** Records cancel intent once; the first time is kept. Undefined for another grant's child. */
  readonly markCancelRequested: (
    grantId: string,
    commandId: string,
    at: string,
  ) => Effect.Effect<PeerChild | undefined, PeerChildRepositoryError>;
  /** The child for a command id, whatever grant created it. */
  readonly findByCommand: (
    commandId: string,
  ) => Effect.Effect<PeerChild | undefined, PeerChildRepositoryError>;
  /** Children whose start intent is neither completed nor failed, oldest first. */
  readonly listIncompleteStarts: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<PeerChild>, PeerChildRepositoryError>;
  /** Settles the start intent once: completed, or failed with a bounded reason. */
  readonly settleStart: (
    commandId: string,
    outcome: { readonly completedAt: string } | { readonly failure: string },
  ) => Effect.Effect<void, PeerChildRepositoryError>;
}

export class PeerChildRepository extends ServiceMap.Service<
  PeerChildRepository,
  PeerChildRepositoryShape
>()("bigbud/persistence/PeerChildRepository") {}
