import { Schema, ServiceMap } from "effect";
import type * as Effect from "effect/Effect";
import type { PeerGrant } from "@bigbud/contracts/server/remotePeer.ts";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

/** The grant would exceed the worker's local permission ceiling. */
export class PeerGrantExceedsCeiling extends Schema.TaggedErrorClass<PeerGrantExceedsCeiling>()(
  "PeerGrantExceedsCeiling",
  { detail: Schema.String },
) {}

export type PeerGrantRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | PeerGrantExceedsCeiling;

type Find = Effect.Effect<PeerGrant | undefined, PeerGrantRepositoryError>;

/**
 * Worker-side peer grants (migration 175). Stores authority ids and key fingerprints only; never
 * private keys, tokens or credentials.
 */
export interface PeerGrantRepositoryShape {
  /**
   * Issues a new unrevoked grant, atomically revoking any other unrevoked grant for the same
   * coordinator authority. Refuses a ceiling wider than `localCeiling` (the worker's own policy).
   */
  readonly issue: (input: {
    readonly grant: PeerGrant;
    readonly localCeiling: PeerGrant["ceiling"];
  }) => Effect.Effect<PeerGrant, PeerGrantRepositoryError>;
  readonly get: (grantId: string) => Find;
  /** The coordinator's unrevoked grant, if any; expiry is evaluated by the caller. */
  readonly findActiveForCoordinator: (coordinatorAuthorityId: string) => Find;
  /** Every stored grant, newest first, bounded for owner listing. */
  readonly list: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<PeerGrant>, PeerGrantRepositoryError>;
  /** Revokes a grant once; undefined when it is unknown. Revoking twice keeps the first time. */
  readonly revoke: (grantId: string, revokedAt: string) => Find;
}

export class PeerGrantRepository extends ServiceMap.Service<
  PeerGrantRepository,
  PeerGrantRepositoryShape
>()("bigbud/persistence/PeerGrantRepository") {}
