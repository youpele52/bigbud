/**
 * Worker-side `status`, `follow` and `cancel` (WP-8B). Each reaches only children recorded for the
 * caller's coordinator authority; an unknown or foreign dispatch reads as `dispatch-unknown`.
 * The command id embeds the coordinator authority, so a child created under an earlier grant of
 * the same coordinator stays readable (and cancellable) after a re-grant, and its real outcome is
 * reported instead of being lost (O-5).
 *
 * @module peerWorker.follow
 */
import { CommandId, ThreadId } from "@bigbud/contracts";
import type { PeerGrant } from "@bigbud/contracts/server/remotePeer.ts";
import type { PeerChildStatus } from "@bigbud/contracts/server/remotePeer.wire.ts";
import { Effect } from "effect";

import type { PeerChild } from "../persistence/Services/PeerChildren.ts";
import { readPeerChildStatus, type PeerWorkerDeps } from "./peerWorker.read.ts";
import { isTerminalPeerChildState, peerCommandId, PeerWorkerRefusal } from "./peerWorker.status.ts";

const FOLLOW_POLL_MS = 250;
const unknown = () =>
  PeerWorkerRefusal.of("dispatch-unknown", "No child exists for this dispatch under the grant.");
const internal = () => PeerWorkerRefusal.of("child-failed", "The worker could not read the child.");

const statusOf = Effect.fn("peerWorkerStatusOf")(function* (
  deps: PeerWorkerDeps,
  child: PeerChild,
) {
  // A pre-179 record without its thread means the delegate never finished; the coordinator
  // re-sends the same identity, which completes it without a second child.
  const status = yield* readPeerChildStatus(deps, child).pipe(Effect.mapError(internal));
  if (!status) return yield* unknown();
  return status;
});

const findChild = (deps: PeerWorkerDeps, grant: PeerGrant, dispatchId: string) =>
  deps.children.findByCommand(peerCommandId(grant.coordinatorAuthorityId, dispatchId)).pipe(
    Effect.mapError(internal),
    Effect.flatMap((child) =>
      child && child.coordinatorAuthorityId === grant.coordinatorAuthorityId
        ? Effect.succeed(child)
        : Effect.fail(unknown()),
    ),
  );

export const peerWorkerStatus = Effect.fn("peerWorkerStatus")(function* (
  deps: PeerWorkerDeps,
  grant: PeerGrant,
  dispatchId: string,
) {
  return yield* statusOf(deps, yield* findChild(deps, grant, dispatchId));
});

/** What the coordinator shows of a live child: its state and why it waits. */
const progressKey = (status: PeerChildStatus) =>
  `${status.state}:${status.waiting?.reason ?? ""}:${status.waiting?.approvalKind ?? ""}`;

/**
 * Bounded long poll: replies once the child is terminal, its live progress changed since the poll
 * began (for example it started waiting for an approval), or `waitMs` has elapsed.
 */
export const peerWorkerFollow = Effect.fn("peerWorkerFollow")(function* (
  deps: PeerWorkerDeps,
  grant: PeerGrant,
  dispatchId: string,
  waitMs: number,
) {
  const deadline = Date.now() + waitMs;
  let initial: string | undefined;
  for (;;) {
    // Re-read the record each round so a cancel recorded meanwhile is reported.
    const status: PeerChildStatus = yield* statusOf(
      deps,
      yield* findChild(deps, grant, dispatchId),
    );
    const key = progressKey(status);
    initial ??= key;
    if (isTerminalPeerChildState(status.state) || key !== initial || Date.now() >= deadline)
      return status;
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
  const recorded = yield* findChild(deps, grant, dispatchId);
  const child = yield* deps.children
    .markCancelRequested(recorded.grantId, commandId, new Date().toISOString())
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
