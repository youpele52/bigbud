import { ServiceMap } from "effect";
import type * as Effect from "effect/Effect";
import type { PeerDelegateRequest } from "@bigbud/contracts/server/remotePeer.wire.ts";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

/**
 * The exact delegate request of each coordinator dispatch (migration 178). A re-send of an
 * uncertain dispatch reads it back so the worker sees a byte-identical request for the identity.
 */
export interface PeerDispatchRequestRepositoryShape {
  /** Stores the request once; a second save for the same dispatch keeps the first. */
  readonly save: (
    request: PeerDelegateRequest,
    createdAt: string,
  ) => Effect.Effect<PeerDelegateRequest, PersistenceSqlError | PersistenceDecodeError>;
  readonly get: (
    dispatchId: string,
  ) => Effect.Effect<PeerDelegateRequest | undefined, PersistenceSqlError | PersistenceDecodeError>;
}

export class PeerDispatchRequestRepository extends ServiceMap.Service<
  PeerDispatchRequestRepository,
  PeerDispatchRequestRepositoryShape
>()("bigbud/persistence/PeerDispatchRequestRepository") {}
