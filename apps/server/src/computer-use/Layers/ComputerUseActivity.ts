import { Effect, Layer, Option, Stream, SubscriptionRef } from "effect";

import {
  beginComputerUseAction,
  emptyComputerUseActivityState,
  endComputerUseAction,
  markComputerUseStopped,
  pruneComputerUseActivity,
} from "../computerUseActivity.logic.ts";
import {
  COMPUTER_USE_STOPPED_BY_USER_MESSAGE,
  ComputerUseAdmission,
} from "../computerUseAdmission.ts";
import {
  ComputerUseActivity,
  type ComputerUseActivityAction,
  type ComputerUseActivityShape,
  ComputerUseStoppedError,
} from "../Services/ComputerUseActivity.ts";

export const makeComputerUseActivity = Effect.gen(function* () {
  const state = yield* SubscriptionRef.make(emptyComputerUseActivityState);

  const track: ComputerUseActivityShape["track"] = <A, E, R>(
    action: ComputerUseActivityAction,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      SubscriptionRef.modify(state, (current) => {
        const [admitted, next] = beginComputerUseAction(current, action, Date.now());
        return [admitted ? next.stopEpoch : null, next] as const;
      }),
      (epoch): Effect.Effect<A, E | ComputerUseStoppedError, R> =>
        epoch === null
          ? Effect.fail(
              new ComputerUseStoppedError({ message: COMPUTER_USE_STOPPED_BY_USER_MESSAGE }),
            )
          : effect.pipe(
              Effect.provideService(ComputerUseAdmission, {
                isCurrent: () => SubscriptionRef.getUnsafe(state).stopEpoch === epoch,
              }),
            ),
      (epoch) =>
        epoch === null
          ? Effect.void
          : SubscriptionRef.update(state, (current) =>
              endComputerUseAction(current, action, Date.now()),
            ),
    );

  return ComputerUseActivity.of({
    track,
    entries: SubscriptionRef.get(state).pipe(
      Effect.map((current) => Array.from(current.entries.values())),
    ),
    markStopped: (keys) =>
      SubscriptionRef.update(state, (current) => markComputerUseStopped(current, keys)),
    // Publishes only a real change, so a subscriber that prunes cannot wake itself up.
    prune: (keep) =>
      SubscriptionRef.updateSome(state, (current) => {
        const next = pruneComputerUseActivity(current, keep);
        return next === current ? Option.none() : Option.some(next);
      }),
    changes: SubscriptionRef.changes(state).pipe(
      Stream.map((current) => Array.from(current.entries.values())),
    ),
  });
});

export const ComputerUseActivityLive = Layer.effect(ComputerUseActivity, makeComputerUseActivity);
