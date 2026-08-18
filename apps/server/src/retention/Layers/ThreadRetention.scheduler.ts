import type { ThreadRetentionPolicy } from "@bigbud/contracts/core/settings.threadRetention.ts";
import { Effect, Schedule } from "effect";

export const runThreadRetentionScheduledTick = Effect.fn("ThreadRetention.runScheduledTick")(
  function* <EP, EE>(input: {
    readonly getPolicy: Effect.Effect<ThreadRetentionPolicy, EP>;
    readonly run: (policy: Exclude<ThreadRetentionPolicy, "never">) => Effect.Effect<void, EE>;
    readonly isDisabled: () => boolean;
  }) {
    if (input.isDisabled()) return;
    const policy = yield* input.getPolicy;
    if (policy === "never") return;
    yield* input.run(policy);
  },
);

export const runThreadRetentionSchedule = <E>(tick: Effect.Effect<void, E>) =>
  Effect.sleep("10 minutes").pipe(
    Effect.andThen(
      Effect.repeat(
        tick.pipe(
          Effect.catchCause(() =>
            Effect.logWarning("thread retention scheduled tick failed", {
              reason: "scheduled_tick_failure",
            }),
          ),
        ),
        Schedule.fixed("24 hours"),
      ),
    ),
  );
