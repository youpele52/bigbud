/**
 * Coordinator dispatcher (M6 WP-8D): `delegate_to_host`, status and cancel over durable
 * `peer_dispatches` rows, with one follower fiber per unsettled dispatch. Followers resume from
 * the unsettled-rows index on backend start, so a restart never loses or relaunches a child.
 *
 * @module peerDispatch.service
 */
import type { PeerDispatch } from "@bigbud/contracts/server/remotePeer.ts";
import { Duration, Effect, Fiber, ServiceMap } from "effect";

import { isTerminalPeerDispatchState } from "../peer-orchestration/peerDispatch.transition.ts";
import { requestPeerCancel } from "./peerDispatch.cancel.ts";
import { preparePeerDelegate, type PeerDelegateInput } from "./peerDispatch.delegate.ts";
import type { PeerCoordinatorDeps } from "./peerDispatch.deps.ts";
import type { PeerPairingRepositoryError } from "../persistence/Services/PeerPairings.ts";
import {
  peerFollowStep,
  type PeerFollowError,
  type PeerFollowStep,
} from "./peerDispatch.follow.ts";

export type PeerToolResult = Record<string, unknown>;

export interface PeerDispatchServiceShape {
  readonly delegate: (input: PeerDelegateInput) => Effect.Effect<PeerToolResult, Error>;
  readonly status: (input: {
    readonly callerThreadId: string;
    readonly dispatchId: string;
  }) => Effect.Effect<PeerToolResult, Error>;
  readonly cancel: (input: {
    readonly callerThreadId: string;
    readonly dispatchId: string;
  }) => Effect.Effect<PeerToolResult, Error>;
  /** Starts followers for every unsettled dispatch; returns how many. */
  readonly resume: () => Effect.Effect<number, Error>;
  /** After the user fixed a pin or grant: clear the setup error and resume that worker. */
  readonly kick: (workerAuthorityId: string) => Effect.Effect<void, Error>;
  readonly deps: PeerCoordinatorDeps;
}

export class PeerDispatchService extends ServiceMap.Service<
  PeerDispatchService,
  PeerDispatchServiceShape
>()("bigbud/orchestration-tools/PeerDispatchService") {}

const UNSETTLED_LIMIT = 1_000;
/** Bounded in-call wait; under the shortest provider tool-call limit (OpenCode aborts at 10 s). */
const TOOL_WAIT_MS = 5_000;
const asError = (error: unknown) =>
  error instanceof Error ? error : new Error(String((error as { message?: unknown }).message));

export function peerDispatchView(deps: PeerCoordinatorDeps, dispatch: PeerDispatch) {
  const setupError = deps.setupErrors.get(dispatch.worker.workerAuthorityId) ?? null;
  return {
    ok: dispatch.state !== "failed" && setupError === null,
    dispatchId: dispatch.dispatchId,
    state: dispatch.state,
    workerAuthorityId: dispatch.worker.workerAuthorityId,
    childThreadId: dispatch.childThreadId,
    sendAttempts: dispatch.sendAttempts,
    cancelRequestedAt: dispatch.cancelRequestedAt,
    result: dispatch.result,
    error: dispatch.error,
    ...(setupError && !isTerminalPeerDispatchState(dispatch.state) ? { setupError } : {}),
  } satisfies PeerToolResult;
}

export const makePeerDispatchService = Effect.fn("makePeerDispatchService")(function* (
  deps: PeerCoordinatorDeps,
  options: { readonly toolWaitMs?: number } = {},
) {
  const scope = yield* Effect.scope;
  const followers = new Map<string, Fiber.Fiber<void, never>>();
  const tokens = new Map<string, object>();

  const runFollower = Effect.fn("peerDispatch.follower")(function* (dispatchId: string) {
    let attempt = 0;
    let streak = 0;
    for (;;) {
      const dispatch = yield* deps.dispatches.get(dispatchId);
      if (!dispatch || isTerminalPeerDispatchState(dispatch.state)) return;
      const step: PeerFollowStep = yield* peerFollowStep(deps, dispatch).pipe(
        Effect.catch((error: PeerFollowError | PeerPairingRepositoryError) => {
          // A concurrent writer (cancel) moved the row: re-read it.
          if (error._tag === "PeerDispatchIllegalTransition")
            return Effect.succeed("continue" as const);
          return Effect.logWarning("peer follower step failed", {
            dispatchId,
            error: asError(error).message,
          }).pipe(Effect.as("wait" as const));
        }),
      );
      if (step === "stop") return;
      streak = step === "continue" ? streak + 1 : 0;
      if (step === "wait" || streak > 50) {
        attempt++;
        streak = 0;
        yield* Effect.sleep(Duration.millis(deps.retryDelayMs(attempt)));
      } else attempt = 0;
    }
  });

  const ensureFollower = (dispatchId: string, restart = false) =>
    Effect.gen(function* () {
      const current = followers.get(dispatchId);
      if (current && !restart) return;
      if (current) {
        followers.delete(dispatchId);
        tokens.delete(dispatchId);
        yield* Fiber.interrupt(current);
      }
      const token = {};
      tokens.set(dispatchId, token);
      const fiber = yield* runFollower(dispatchId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("peer follower stopped", { dispatchId, error: asError(error).message }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (tokens.get(dispatchId) === token) {
              tokens.delete(dispatchId);
              followers.delete(dispatchId);
            }
          }),
        ),
        Effect.forkIn(scope),
      );
      // A follower that already finished has cleared its token; never record it as running.
      if (tokens.get(dispatchId) === token) followers.set(dispatchId, fiber);
    });

  /** Waits briefly for the follower to leave the uncertain states, then reports the row. */
  const settleView = Effect.fn("peerDispatch.settleView")(function* (dispatchId: string) {
    const deadline = Date.now() + (options.toolWaitMs ?? TOOL_WAIT_MS);
    let dispatch = yield* deps.dispatches.get(dispatchId);
    while (
      dispatch &&
      (dispatch.state === "pending" || dispatch.state === "sent-uncertain") &&
      !deps.setupErrors.has(dispatch.worker.workerAuthorityId) &&
      followers.has(dispatchId) &&
      Date.now() < deadline
    ) {
      yield* Effect.sleep(Duration.millis(50));
      dispatch = yield* deps.dispatches.get(dispatchId);
    }
    return dispatch;
  });

  const delegate: PeerDispatchServiceShape["delegate"] = (input) =>
    Effect.gen(function* () {
      const prepared = yield* preparePeerDelegate(deps, input);
      if (prepared._tag === "refused")
        return {
          ok: false,
          ...(prepared.unavailable ? { unavailable: true } : {}),
          error: prepared.error,
        };
      yield* ensureFollower(prepared.dispatch.dispatchId);
      const dispatch = (yield* settleView(prepared.dispatch.dispatchId)) ?? prepared.dispatch;
      return {
        ...peerDispatchView(deps, dispatch),
        worker: prepared.pairing.label,
        replayed: prepared.joined,
        guidance:
          "The result is delivered into this thread once the worker child finishes. Use peer_dispatch_status with the dispatchId to check it, never delegate the same task again.",
      };
    }).pipe(Effect.mapError(asError));

  const status: PeerDispatchServiceShape["status"] = (input) =>
    deps.dispatches.get(input.dispatchId).pipe(
      Effect.map((dispatch) =>
        dispatch && dispatch.coordinatorThreadId === input.callerThreadId
          ? peerDispatchView(deps, dispatch)
          : { ok: false, error: { code: "dispatch-unknown", message: "Unknown dispatch." } },
      ),
      Effect.mapError(asError),
    );

  const cancel: PeerDispatchServiceShape["cancel"] = (input) =>
    Effect.gen(function* () {
      const outcome = yield* requestPeerCancel(deps, input);
      if (outcome._tag === "unknown")
        return { ok: false, error: { code: "dispatch-unknown", message: "Unknown dispatch." } };
      // Wake the follower so the worker cancel goes out now, not after the current long poll.
      if (outcome.dispatch.state === "cancel-pending")
        yield* ensureFollower(outcome.dispatch.dispatchId, true);
      return peerDispatchView(deps, outcome.dispatch);
    }).pipe(Effect.mapError(asError));

  const resume: PeerDispatchServiceShape["resume"] = () =>
    Effect.gen(function* () {
      const unsettled = yield* deps.dispatches.listUnsettled(UNSETTLED_LIMIT);
      for (const dispatch of unsettled) yield* ensureFollower(dispatch.dispatchId);
      return unsettled.length;
    }).pipe(Effect.mapError(asError));

  const kick: PeerDispatchServiceShape["kick"] = (workerAuthorityId) =>
    Effect.gen(function* () {
      deps.setupErrors.delete(workerAuthorityId);
      const unsettled = yield* deps.dispatches.listUnsettled(UNSETTLED_LIMIT);
      for (const dispatch of unsettled)
        if (dispatch.worker.workerAuthorityId === workerAuthorityId)
          yield* ensureFollower(dispatch.dispatchId, true);
    }).pipe(Effect.mapError(asError));

  return { delegate, status, cancel, resume, kick, deps } satisfies PeerDispatchServiceShape;
});
