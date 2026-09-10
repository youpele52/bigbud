import { Clock, Deferred, Duration, Effect, Ref } from "effect";

type AttemptState = "pending" | "completed" | "expired";
type CompletionOutcome = { readonly accepted: boolean; readonly shouldClose: boolean };

export function makeMobileRecoveryAttemptDeadline(input: {
  readonly durationMs: number;
  readonly closeCapture: Effect.Effect<void>;
  readonly markCaughtUp: () => void;
}) {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const deadlineAt = startedAt + input.durationMs;
    const state = yield* Ref.make<AttemptState>("pending");
    const completed = yield* Deferred.make<void>();

    const expire = Effect.gen(function* () {
      const shouldClose = yield* Ref.modify(state, (current) => {
        if (current !== "pending") return [false, current] as const;
        return [true, "expired"] as const;
      });
      if (shouldClose) yield* input.closeCapture;
    });

    yield* Effect.forkScoped(
      Effect.race(
        Effect.sleep(Duration.millis(input.durationMs)).pipe(Effect.andThen(expire)),
        Deferred.await(completed),
      ),
    );

    const isExpired = Effect.gen(function* () {
      const current = yield* Ref.get(state);
      if (current === "expired") return true;
      if (current === "completed") return false;
      const now = yield* Clock.currentTimeMillis;
      if (now < deadlineAt) return false;
      yield* expire;
      return (yield* Ref.get(state)) === "expired";
    });

    const completeIfCurrent = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const outcome = yield* Ref.modify(
        state,
        (current): readonly [CompletionOutcome, AttemptState] => {
          if (current === "completed") {
            return [{ accepted: true, shouldClose: false }, current] as const;
          }
          if (current === "expired") {
            return [{ accepted: false, shouldClose: false }, current] as const;
          }
          if (now >= deadlineAt) {
            return [{ accepted: false, shouldClose: true }, "expired"] as const;
          }
          return [{ accepted: true, shouldClose: false }, "completed"] as const;
        },
      );
      if (outcome.shouldClose) yield* input.closeCapture;
      if (!outcome.accepted) return false;
      input.markCaughtUp();
      yield* Deferred.succeed(completed, undefined);
      return true;
    });

    return { deadlineAt, isExpired, completeIfCurrent } as const;
  });
}
