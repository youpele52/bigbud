import { Schema, ServiceMap } from "effect";
import type * as Effect from "effect/Effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

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
    child: Omit<PeerChild, "cancelRequestedAt">,
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
}

export class PeerChildRepository extends ServiceMap.Service<
  PeerChildRepository,
  PeerChildRepositoryShape
>()("bigbud/persistence/PeerChildRepository") {}
