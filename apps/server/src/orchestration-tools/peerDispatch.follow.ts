/**
 * Coordinator dispatch follower (WP-8D). One follower per dispatch drives the durable row from
 * `pending` to a terminal state; it is the only writer of worker-observed outcomes.
 *
 * - `pending`: persist `send-started` (now `sent-uncertain`) before the delegate goes out.
 * - `sent-uncertain`: probe `status` only. A worker reply naming the child accepts it; only an
 *   explicit `dispatch-unknown` re-sends the same stored request under the same identity, and only
 *   while the row is still `sent-uncertain`. Nothing ever creates a second dispatch id.
 * - `accepted` / `following`: long-poll `follow` until the child is terminal.
 * - `cancel-pending`: send `cancel` and keep following; a partition leaves it `cancel-pending`.
 *
 * Results are delivered into the coordinator thread before settling (see `peerDispatch.delivery`).
 * Setup errors (host key pin, key authentication) stop the follower without retrying.
 *
 * @module peerDispatch.follow
 */
import type {
  PeerDispatch,
  PeerError,
  PeerResultSummary,
} from "@bigbud/contracts/server/remotePeer.ts";
import {
  PeerChildStatus,
  type PeerDelegateRequest,
} from "@bigbud/contracts/server/remotePeer.wire.ts";
import type { PeerPairing } from "@bigbud/contracts/server/remotePeer.pairing.ts";
import { PEER_FOLLOW_MAX_WAIT_MS } from "@bigbud/contracts/constants/remotePeer.constant.ts";
import { Data, Effect, Schema } from "effect";

import type { PeerDispatchEvent } from "../peer-orchestration/peerDispatch.transition.ts";
import { boundPeerSummary } from "../peer-orchestration/peerWorker.status.ts";
import type { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import type {
  PeerDispatchRepositoryError,
  PeerDispatchTransitionPatch,
} from "../persistence/Services/PeerDispatches.ts";
import type { PeerPairingRepositoryError } from "../persistence/Services/PeerPairings.ts";
import { buildPeerResultDelivery } from "./peerDispatch.delivery.ts";
import type { PeerCoordinatorDeps } from "./peerDispatch.deps.ts";
import {
  isFinalDelegateRefusal,
  isFinalFollowRefusal,
  type PeerTransportOutcome,
} from "./peerDispatch.transport.ts";

class PeerTransportFailure extends Data.TaggedError("PeerTransportFailure")<{
  readonly message: string;
}> {}

export type PeerFollowError =
  | PeerDispatchRepositoryError
  | PeerPairingRepositoryError
  | PersistenceSqlError
  | PersistenceDecodeError;

/** `continue` re-reads the row now; `wait` backs off first; `stop` ends this follower. */
export type PeerFollowStep = "continue" | "wait" | "stop";

const decodeStatus = Schema.decodeUnknownOption(PeerChildStatus);
const FOLLOW_DEADLINE_MS = PEER_FOLLOW_MAX_WAIT_MS + 10_000;
const REQUEST_DEADLINE_MS = 35_000;

const peerError = (code: PeerError["code"], message: string): PeerError => ({
  code,
  message: message.slice(0, 1024),
});

const call = (
  deps: PeerCoordinatorDeps,
  pairing: PeerPairing,
  action: "delegate" | "status" | "follow" | "cancel",
  body: unknown,
  deadlineMs = REQUEST_DEADLINE_MS,
) =>
  Effect.tryPromise({
    try: (signal) => deps.transport.request({ pairing, action, body, deadlineMs, signal }),
    catch: (cause) =>
      new PeerTransportFailure({
        message: cause instanceof Error ? cause.message : "The peer request failed.",
      }),
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed<PeerTransportOutcome>({ _tag: "unreachable", message: cause.message }),
    ),
    Effect.tap((outcome) =>
      Effect.sync(() => {
        if (outcome._tag === "setup")
          deps.setupErrors.set(pairing.workerAuthorityId, {
            code: outcome.code,
            message: outcome.message.slice(0, 1024),
            at: deps.now(),
          });
        else if (outcome._tag !== "unreachable") deps.setupErrors.delete(pairing.workerAuthorityId);
      }),
    ),
  );

const childStatus = (dispatch: PeerDispatch, body: unknown) => {
  const status = decodeStatus(body);
  return status._tag === "Some" && status.value.dispatchId === dispatch.dispatchId
    ? status.value
    : undefined;
};

const move = (
  deps: PeerCoordinatorDeps,
  dispatch: PeerDispatch,
  event: PeerDispatchEvent,
  patch: Omit<PeerDispatchTransitionPatch, "updatedAt"> = {},
) =>
  deps.dispatches
    .transition(dispatch.dispatchId, event, { ...patch, updatedAt: deps.now() })
    .pipe(Effect.as<PeerFollowStep>("continue"));

/** Delivers one result into the coordinator thread; idempotent per dispatch identity. */
const deliverResult = (
  deps: PeerCoordinatorDeps,
  dispatch: PeerDispatch,
  pairing: PeerPairing,
  result: PeerResultSummary,
) =>
  deps.deliver(buildPeerResultDelivery(dispatch, pairing.label, result)).pipe(
    Effect.retry({ times: 2 }),
    // The result stays on the row (status tool, settings); settling must not wait forever.
    Effect.catch((error) =>
      Effect.logWarning("peer result delivery failed", {
        dispatchId: dispatch.dispatchId,
        error: error.message,
      }),
    ),
  );

/** Delivers the child's result, then settles the row (delivery is idempotent per identity). */
const settle = Effect.fn("peerDispatch.settle")(function* (
  deps: PeerCoordinatorDeps,
  dispatch: PeerDispatch,
  pairing: PeerPairing,
  status: PeerChildStatus,
) {
  const result =
    status.result ??
    boundPeerSummary(
      status.state === "completed"
        ? "completed"
        : status.state === "failed"
          ? "failed"
          : "cancelled",
      "The worker reported no summary.",
    );
  const accepted = { ...dispatch, childThreadId: dispatch.childThreadId ?? status.childThreadId };
  yield* deliverResult(deps, accepted, pairing, result);
  // The child id is recorded too: a cancel requested before acceptance never saw it.
  const base = { result, childThreadId: status.childThreadId };
  if (result.outcome === "completed") return yield* move(deps, dispatch, "child-completed", base);
  if (result.outcome === "cancelled" && dispatch.state === "cancel-pending")
    return yield* move(deps, dispatch, "cancel-confirmed", base);
  const message =
    result.outcome === "cancelled" ? "The child was cancelled on the worker." : result.summary;
  return yield* move(deps, dispatch, "child-failed", {
    ...base,
    error: peerError("child-failed", message || "The child failed on the worker."),
  });
});

/** Why an accepted child can no longer be observed, for the delivered failure (F-P8-4, O-5). */
export function peerRefusalReason(
  dispatch: PeerDispatch,
  pairing: PeerPairing,
  error: PeerError,
): string {
  if (error.code === "dispatch-unknown" && pairing.grantId !== dispatch.worker.grantId)
    return (
      "The worker grant was re-issued after this task was accepted (grant superseded), and the " +
      "worker no longer reports this child, so its outcome is unknown."
    );
  return `The worker can no longer report this child (${error.code}): ${error.message}`;
}

/** A final refusal after acceptance: deliver a failure once, then settle the row failed. */
const settleRefused = Effect.fn("peerDispatch.settleRefused")(function* (
  deps: PeerCoordinatorDeps,
  dispatch: PeerDispatch,
  pairing: PeerPairing,
  error: PeerError,
) {
  // Re-read the pairing: a re-grant may have landed while this request was in flight.
  const current = (yield* deps.pairings.findByWorker(pairing.workerAuthorityId)) ?? pairing;
  const result = boundPeerSummary("failed", peerRefusalReason(dispatch, current, error));
  yield* deliverResult(deps, dispatch, pairing, result);
  return yield* move(deps, dispatch, "child-failed", {
    result,
    error: peerError(error.code, result.summary),
  });
});

/** Applies a reply that names the child (delegate, status, follow or cancel). */
const observe = Effect.fn("peerDispatch.observe")(function* (
  deps: PeerCoordinatorDeps,
  dispatch: PeerDispatch,
  pairing: PeerPairing,
  status: PeerChildStatus,
) {
  if (dispatch.state === "sent-uncertain")
    return yield* move(deps, dispatch, "worker-accepted", { childThreadId: status.childThreadId });
  const terminal =
    status.state === "completed" || status.state === "failed" || status.state === "cancelled";
  if (terminal) return yield* settle(deps, dispatch, pairing, status);
  return "continue" as PeerFollowStep;
});

/** Sends the stored request for this identity; the caller has already counted the attempt. */
const sendDelegate = Effect.fn("peerDispatch.sendDelegate")(function* (
  deps: PeerCoordinatorDeps,
  dispatch: PeerDispatch,
  pairing: PeerPairing,
  request: PeerDelegateRequest,
) {
  const outcome = yield* call(deps, pairing, "delegate", request);
  return yield* uncertainOutcome(deps, dispatch, pairing, outcome);
});

const uncertainOutcome = (
  deps: PeerCoordinatorDeps,
  dispatch: PeerDispatch,
  pairing: PeerPairing,
  outcome: PeerTransportOutcome,
): Effect.Effect<PeerFollowStep, PeerFollowError> => {
  switch (outcome._tag) {
    case "setup":
      return Effect.succeed("stop");
    case "unreachable":
      return Effect.succeed("wait");
    case "ok": {
      const status = childStatus(dispatch, outcome.body);
      return status ? observe(deps, dispatch, pairing, status) : Effect.succeed("wait");
    }
    case "refused":
      return isFinalDelegateRefusal(outcome.error.code)
        ? move(deps, dispatch, "rejected", { error: outcome.error })
        : Effect.succeed("wait");
  }
};

/** One follower step for the current row; the loop re-reads the row after each step. */
export const peerFollowStep = Effect.fn("peerDispatch.followStep")(function* (
  deps: PeerCoordinatorDeps,
  dispatch: PeerDispatch,
) {
  const pairing = yield* deps.pairings.findByWorker(dispatch.worker.workerAuthorityId);
  if (!pairing) return "stop" as PeerFollowStep;
  if (deps.setupErrors.has(pairing.workerAuthorityId)) return "stop" as PeerFollowStep;
  switch (dispatch.state) {
    case "pending": {
      // Nothing has reached the worker yet; without the stored request it never will.
      const request = yield* deps.requests.get(dispatch.dispatchId);
      if (!request)
        return yield* move(deps, dispatch, "rejected", {
          error: peerError("dispatch-unknown", "The delegate request was not recorded."),
        });
      const sent = yield* deps.dispatches.transition(dispatch.dispatchId, "send-started", {
        updatedAt: deps.now(),
      });
      return sent
        ? yield* sendDelegate(deps, sent, pairing, request)
        : ("continue" as PeerFollowStep);
    }
    case "sent-uncertain": {
      // Status only: an uncertain send is never relaunched as a new dispatch.
      const outcome = yield* call(deps, pairing, "status", { dispatchId: dispatch.dispatchId });
      if (outcome._tag === "refused" && outcome.error.code === "dispatch-unknown") {
        const request = yield* deps.requests.get(dispatch.dispatchId);
        if (!request) return "wait" as PeerFollowStep;
        // Re-send the same identity, and only while the row is still sent-uncertain.
        const retry = yield* deps.dispatches.recordSendRetry(dispatch.dispatchId, deps.now());
        return retry
          ? yield* sendDelegate(deps, retry, pairing, request)
          : ("continue" as PeerFollowStep);
      }
      return yield* uncertainOutcome(deps, dispatch, pairing, outcome);
    }
    case "accepted":
      return yield* move(deps, dispatch, "follow-started");
    case "following":
    case "cancel-pending": {
      if (dispatch.state === "cancel-pending") {
        const cancelled = yield* call(deps, pairing, "cancel", { dispatchId: dispatch.dispatchId });
        const step = yield* followOutcome(deps, dispatch, pairing, cancelled);
        if (step !== "continue" || cancelled._tag !== "ok") return step;
        const status = childStatus(dispatch, cancelled.body);
        if (status && status.state !== "running" && status.state !== "waiting") return step;
      }
      const outcome = yield* call(
        deps,
        pairing,
        "follow",
        { dispatchId: dispatch.dispatchId, waitMs: deps.followWaitMs },
        FOLLOW_DEADLINE_MS,
      );
      return yield* followOutcome(deps, dispatch, pairing, outcome);
    }
    default:
      return "stop" as PeerFollowStep;
  }
});

const followOutcome = (
  deps: PeerCoordinatorDeps,
  dispatch: PeerDispatch,
  pairing: PeerPairing,
  outcome: PeerTransportOutcome,
): Effect.Effect<PeerFollowStep, PeerFollowError> => {
  switch (outcome._tag) {
    case "setup":
      return Effect.succeed("stop");
    case "unreachable":
      return Effect.succeed("wait");
    case "ok": {
      const status = childStatus(dispatch, outcome.body);
      return status ? observe(deps, dispatch, pairing, status) : Effect.succeed("wait");
    }
    case "refused": {
      if (!isFinalFollowRefusal(outcome.error.code)) return Effect.succeed("wait");
      // Cancel of an identity the worker never recorded: nothing started there, nothing will.
      if (
        dispatch.state === "cancel-pending" &&
        dispatch.childThreadId === null &&
        outcome.error.code === "dispatch-unknown"
      )
        return move(deps, dispatch, "cancel-confirmed");
      return settleRefused(deps, dispatch, pairing, outcome.error);
    }
  }
};
