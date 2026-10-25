import { Deferred, Duration, Effect } from "effect";

export interface WsInitialApplicationDeadline {
  readonly timeout: Duration.Input;
  readonly isApplied?: () => boolean;
}

/** Cancels the owned attempt if initial application stalls; healthy idle streams have no deadline. */
export function withWsInitialApplicationDeadline<A, E, R>(
  deadline: WsInitialApplicationDeadline | undefined,
  consume: (markApplied: () => void) => Effect.Effect<A, E, R>,
) {
  if (!deadline) return consume(() => undefined);
  return Effect.scoped(
    Effect.gen(function* () {
      const applied = yield* Deferred.make<void>();
      const markApplied = () => {
        if (deadline.isApplied?.() !== false) Deferred.doneUnsafe(applied, Effect.void);
      };
      const initialApplication = Deferred.await(applied).pipe(
        Effect.timeout(deadline.timeout),
        Effect.andThen(Effect.never),
      );
      return yield* Effect.raceFirst(consume(markApplied), initialApplication);
    }),
  );
}
