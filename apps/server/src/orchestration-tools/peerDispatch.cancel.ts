/**
 * Coordinator cancel intent (WP-8D). Intent is persisted before the worker is contacted:
 * `pending` becomes `cancelled` (nothing was sent), and every later non-terminal state becomes
 * `cancel-pending`. The follower then sends the worker `cancel` and keeps following; only a worker
 * reply settles it (`cancelled`, or `completed` / `failed` when the child finished first). A
 * partition therefore shows `cancel-pending` until the worker confirms: silence is never
 * cancellation.
 *
 * @module peerDispatch.cancel
 */
import type { PeerDispatch } from "@bigbud/contracts/server/remotePeer.ts";
import { Effect } from "effect";

import { isTerminalPeerDispatchState } from "../peer-orchestration/peerDispatch.transition.ts";
import type { PeerCoordinatorDeps } from "./peerDispatch.deps.ts";

export type PeerCancelOutcome =
  | { readonly _tag: "unknown" }
  | { readonly _tag: "unchanged"; readonly dispatch: PeerDispatch }
  | { readonly _tag: "requested"; readonly dispatch: PeerDispatch };

/** Persists cancel intent for a dispatch owned by `callerThreadId`. */
export const requestPeerCancel = Effect.fn("peerDispatch.requestCancel")(function* (
  deps: PeerCoordinatorDeps,
  input: { readonly dispatchId: string; readonly callerThreadId: string },
) {
  // A compare-and-set race with the follower is retried against the fresh state.
  for (let attempt = 0; attempt < 5; attempt++) {
    const dispatch = yield* deps.dispatches.get(input.dispatchId);
    // Dispatches are scoped to the coordinator thread that created them.
    if (!dispatch || dispatch.coordinatorThreadId !== input.callerThreadId)
      return { _tag: "unknown" } as PeerCancelOutcome;
    if (isTerminalPeerDispatchState(dispatch.state) || dispatch.state === "cancel-pending")
      return { _tag: "unchanged", dispatch } as PeerCancelOutcome;
    const moved = yield* deps.dispatches.transition(dispatch.dispatchId, "cancel-requested", {
      updatedAt: deps.now(),
    });
    if (moved) return { _tag: "requested", dispatch: moved } as PeerCancelOutcome;
  }
  const latest = yield* deps.dispatches.get(input.dispatchId);
  return latest
    ? ({ _tag: "unchanged", dispatch: latest } as PeerCancelOutcome)
    : ({ _tag: "unknown" } as PeerCancelOutcome);
});
