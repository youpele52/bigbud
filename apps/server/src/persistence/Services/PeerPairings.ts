import { Schema, ServiceMap } from "effect";
import type * as Effect from "effect/Effect";
import type { PeerPairing } from "@bigbud/contracts/server/remotePeer.pairing.ts";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

/** The change would silently invalidate an active grant (different ceiling or key). */
export class PeerPairingConflict extends Schema.TaggedErrorClass<PeerPairingConflict>()(
  "PeerPairingConflict",
  { detail: Schema.String },
) {}

export type PeerPairingRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | PeerPairingConflict;

type Find = Effect.Effect<PeerPairing | undefined, PeerPairingRepositoryError>;

/** The saved connection part of a pairing; the grant fields are managed separately. */
export type PeerPairingConnection = Omit<
  PeerPairing,
  "grantId" | "grantRecordedAt" | "grantRevokedAt" | "createdAt" | "updatedAt"
>;

/**
 * Coordinator-side pairings (migration 178): one saved connection per worker authority plus the
 * grant id that worker issued. Stores public material only (host key pin, key fingerprint).
 */
export interface PeerPairingRepositoryShape {
  /**
   * Creates the saved connection, or updates it for the same worker authority. Changing the
   * ceiling or coordinator key while a grant is active is a conflict: revoke first.
   */
  readonly save: (input: {
    readonly connection: PeerPairingConnection;
    readonly at: string;
  }) => Effect.Effect<PeerPairing, PeerPairingRepositoryError>;
  readonly get: (pairingId: string) => Find;
  readonly findByWorker: (workerAuthorityId: string) => Find;
  readonly list: () => Effect.Effect<ReadonlyArray<PeerPairing>, PeerPairingRepositoryError>;
  /** Records the grant the worker issued (replacing an earlier one); undefined when unknown. */
  readonly recordGrant: (pairingId: string, grantId: string, at: string) => Find;
  /** Marks the recorded grant revoked once, keeping the saved connection. */
  readonly revoke: (pairingId: string, at: string) => Find;
  /** Deletes the saved connection only; true when a row was removed. */
  readonly remove: (pairingId: string) => Effect.Effect<boolean, PeerPairingRepositoryError>;
}

export class PeerPairingRepository extends ServiceMap.Service<
  PeerPairingRepository,
  PeerPairingRepositoryShape
>()("bigbud/persistence/PeerPairingRepository") {}
