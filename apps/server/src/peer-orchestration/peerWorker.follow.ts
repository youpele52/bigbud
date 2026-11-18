/**
 * Worker-side `status`, `follow` and `cancel` (WP-8B). Each reaches only children recorded under
 * the caller's grant; an unknown or foreign dispatch reads as `dispatch-unknown`.
 *
 * @module peerWorker.follow
 */
import { CommandId, ThreadId } from "@bigbud/contracts";
import type { PeerGrant } from "@bigbud/contracts/server/remotePeer.ts";
import type { PeerChildStatus } from "@bigbud/contracts/server/remotePeer.wire.ts";
import { Effect } from "effect";

import type { PeerChild } from "../persistence/Services/PeerChildren.ts";
import { loadPeerChildThread, type PeerWorkerDeps } from "./peerWorker.delegate.ts";
import {
  isTerminalPeerChildState,
  peerChildStatus,
  peerCommandId,
  PeerWorkerRefusal,
} from "./peerWorker.status.ts";

const FOLLOW_POLL_MS = 250;
const unknown = () =>
  PeerWorkerRefusal.of("dispatch-unknown", "No child exists for this dispatch under the grant.");
const internal = () => PeerWorkerRefusal.of("child-failed", "The worker could not read the child.");

const statusOf = Effect.fn("peerWorkerStatusOf")(function* (
  deps: PeerWorkerDeps,
  child: PeerChild,
) {
  // A record without its thread means the delegate never finished; the coordinator re-sends the
  // same identity, which completes it without a second child.
  const thread = yield* loadPeerChildThread(deps.engine, child.childThreadId);
  if (!thread) return yield* unknown();
  return peerChildStatus(child, thread);
});

const findChild = (deps: PeerWorkerDeps, grant: PeerGrant, dispatchId: string) =>
  deps.children
    .findForGrant(grant.grantId, peerCommandId(grant.coordinatorAuthorityId, dispatchId))
    .pipe(
      Effect.mapError(internal),
      Effect.flatMap((child) => (child ? Effect.succeed(child) : Effect.fail(unknown()))),
    );

export const peerWorkerStatus = Effect.fn("peerWorkerStatus")(function* (
  deps: PeerWorkerDeps,
  grant: PeerGrant,
  dispatchId: string,
) {
  return yield* statusOf(deps, yield* findChild(deps, grant, dispatchId));
});

/** Bounded long poll: replies once the child is terminal or `waitMs` has elapsed. */
export const peerWorkerFollow = Effect.fn("peerWorkerFollow")(function* (
  deps: PeerWorkerDeps,
  grant: PeerGrant,
  dispatchId: string,
  waitMs: number,
) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    // Re-read the record each round so a cancel recorded meanwhile is reported.
    const status: PeerChildStatus = yield* statusOf(
      deps,
      yield* findChild(deps, grant, dispatchId),
    );
    if (isTerminalPeerChildState(status.state) || Date.now() >= deadline) return status;
    yield* Effect.sleep(Math.min(FOLLOW_POLL_MS, Math.max(0, deadline - Date.now())));
  }
});

/**
 * Records cancel intent durably first, then interrupts the running turn with a stable command id
 * so a repeated cancel is deduplicated. A child that already finished keeps its real outcome.
 */
export const peerWorkerCancel = Effect.fn("peerWorkerCancel")(function* (
  deps: PeerWorkerDeps,
  grant: PeerGrant,
  dispatchId: string,
) {
  const commandId = peerCommandId(grant.coordinatorAuthorityId, dispatchId);
  const child = yield* deps.children
    .markCancelRequested(grant.grantId, commandId, new Date().toISOString())
    .pipe(Effect.mapError(internal));
  if (!child || child.cancelRequestedAt === null) return yield* unknown();
  const before = yield* statusOf(deps, child);
  if (isTerminalPeerChildState(before.state)) return before;
  yield* deps.engine
    .dispatch({
      type: "thread.turn.interrupt",
      commandId: CommandId.makeUnsafe(`${commandId}:cancel`),
      threadId: ThreadId.makeUnsafe(child.childThreadId),
      createdAt: child.cancelRequestedAt,
    })
    // An idle child has no turn to interrupt; the durable intent and the status reply remain.
    .pipe(Effect.ignore);
  return yield* statusOf(deps, child);
});
