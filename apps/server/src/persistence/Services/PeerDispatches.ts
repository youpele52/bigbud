import { Schema, ServiceMap } from "effect";
import type * as Effect from "effect/Effect";
import type {
  PeerDispatch,
  PeerError,
  PeerResultSummary,
} from "@bigbud/contracts/server/remotePeer.ts";

import type { PeerDispatchEvent } from "../../peer-orchestration/peerDispatch.transition.ts";
import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

/** A different request already owns this dispatch id, command id or request key. */
export class PeerDispatchConflict extends Schema.TaggedErrorClass<PeerDispatchConflict>()(
  "PeerDispatchConflict",
  { detail: Schema.String },
) {}

/** The event is not legal from the dispatch's current state (or the dispatch is unknown). */
export class PeerDispatchIllegalTransition extends Schema.TaggedErrorClass<PeerDispatchIllegalTransition>()(
  "PeerDispatchIllegalTransition",
  { dispatchId: Schema.String, from: Schema.NullOr(Schema.String), event: Schema.String },
) {}

export type PeerDispatchRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError
  | PeerDispatchConflict
  | PeerDispatchIllegalTransition;

type Find = Effect.Effect<PeerDispatch | undefined, PeerDispatchRepositoryError>;

/** Values an event may record alongside its state move. */
export interface PeerDispatchTransitionPatch {
  readonly updatedAt: string;
  /** Required by `worker-accepted`; ignored once set (a dispatch names one child forever). */
  readonly childThreadId?: string;
  /** Required by `child-completed`. */
  readonly result?: PeerResultSummary;
  /** Required by `child-failed` and `rejected`. */
  readonly error?: PeerError;
}

export interface PeerDispatchInsertResult {
  readonly dispatch: PeerDispatch;
  /** True when an earlier request with the same identity already created the row. */
  readonly joined: boolean;
}

/** Coordinator-side durable dispatches (migration 175). */
export interface PeerDispatchRepositoryShape {
  /**
   * Creates a `pending` dispatch, or joins the existing one for the same coordinator thread and
   * request key when it targets the same worker. Any other collision is a conflict, so one
   * dispatch identity never launches a second child.
   */
  readonly insert: (
    dispatch: PeerDispatch,
  ) => Effect.Effect<PeerDispatchInsertResult, PeerDispatchRepositoryError>;
  readonly get: (dispatchId: string) => Find;
  readonly findByRequestKey: (coordinatorThreadId: string, requestKey: string) => Find;
  /** Non-terminal dispatches to resume after a coordinator restart, oldest update first. */
  readonly listUnsettled: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<PeerDispatch>, PeerDispatchRepositoryError>;
  /**
   * Applies one event through the pure transition table with a compare-and-set on the current
   * state. Fails with an illegal transition when the event does not apply; returns undefined when
   * another writer moved the dispatch first.
   */
  readonly transition: (
    dispatchId: string,
    event: PeerDispatchEvent,
    patch: PeerDispatchTransitionPatch,
  ) => Find;
  /** Counts a repeated send of the same identity; only legal while `sent-uncertain`. */
  readonly recordSendRetry: (dispatchId: string, updatedAt: string) => Find;
}

export class PeerDispatchRepository extends ServiceMap.Service<
  PeerDispatchRepository,
  PeerDispatchRepositoryShape
>()("bigbud/persistence/PeerDispatchRepository") {}
