/**
 * Supervision of held delegated first turns (D8), part of the thread watch reactor that already
 * supervises parent/child delegations. The server timer is authoritative: a hold is never left
 * pending. Each requested choice gets an expiry timer; a resolution cancels it; a sweep at start
 * and every 30 s resolves holds whose timer was lost (restart, crash or missed event).
 *
 * @module ThreadWatchReactor.modelChoice
 */
import type { EventId } from "@bigbud/contracts";
import { Clock, Effect, FiberMap, Schedule, Stream } from "effect";

import type { ProjectionThreadActivityRepositoryShape } from "../../persistence/Services/ProjectionThreadActivities.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  expireModelChoiceCommand,
  MODEL_CHOICE_EXPIRE_ATTEMPTS,
  MODEL_CHOICE_SWEEP_BATCH,
  MODEL_CHOICE_SWEEP_INTERVAL_MS,
  modelChoiceEventEffect,
  modelChoiceExpiryDelayMs,
  type PendingModelChoice,
  pendingModelChoiceFromRow,
} from "./ThreadWatchReactor.modelChoice.logic.ts";

const nowIso = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()));

export const startDelegatedModelChoiceSupervision = Effect.fn(
  "startDelegatedModelChoiceSupervision",
)(function* (input: {
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch" | "streamDomainEvents">;
  readonly activityRepository: Pick<
    ProjectionThreadActivityRepositoryShape,
    "listPendingDelegatedModelChoiceRequests"
  >;
}) {
  const timers = yield* FiberMap.make<string>();

  const expire = (choice: PendingModelChoice, resolvedBy: "timeout" | "restart-sweep") =>
    Effect.gen(function* () {
      // One command for every retry, so a retry never conflicts with its own receipt.
      const command = expireModelChoiceCommand({ choice, resolvedBy, createdAt: yield* nowIso });
      yield* input.orchestrationEngine.dispatch(command).pipe(
        Effect.retry({
          times: MODEL_CHOICE_EXPIRE_ATTEMPTS,
          schedule: Schedule.exponential("200 millis"),
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("delegated model choice expiry failed; the sweep retries it", {
          threadId: choice.threadId,
          choiceId: choice.request.choiceId,
          cause: cause.toString(),
        }),
      ),
    );

  const schedule = (choice: PendingModelChoice) =>
    Effect.gen(function* () {
      const delayMs = modelChoiceExpiryDelayMs(
        choice.request.deadlineAt,
        yield* Clock.currentTimeMillis,
      );
      yield* FiberMap.run(
        timers,
        choice.request.choiceId,
        Effect.sleep(delayMs).pipe(Effect.andThen(expire(choice, "timeout"))),
        { onlyIfMissing: true },
      );
    });

  // Pages with a keyset cursor, so rows that keep failing never starve newer holds (M4).
  const sweep = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    let after: { readonly createdAt: string; readonly activityId: EventId } | undefined;
    for (;;) {
      const rows = yield* input.activityRepository.listPendingDelegatedModelChoiceRequests({
        limit: MODEL_CHOICE_SWEEP_BATCH,
        ...(after !== undefined ? { after } : {}),
      });
      for (const row of rows) {
        const choice = pendingModelChoiceFromRow(row);
        if (choice === null || (yield* FiberMap.has(timers, choice.request.choiceId))) continue;
        if (Date.parse(choice.request.deadlineAt) <= nowMs) {
          yield* expire(choice, "restart-sweep");
        } else {
          yield* schedule(choice);
        }
      }
      const last = rows.at(-1);
      if (last === undefined || rows.length < MODEL_CHOICE_SWEEP_BATCH) break;
      after = { createdAt: last.createdAt, activityId: last.activityId };
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("delegated model choice sweep failed", { cause: cause.toString() }),
    ),
  );

  yield* Effect.forkScoped(
    Stream.runForEach(input.orchestrationEngine.streamDomainEvents, (event) => {
      const effect = modelChoiceEventEffect(event);
      if (effect === null) return Effect.void;
      return effect.type === "requested"
        ? schedule(effect.choice)
        : FiberMap.remove(timers, effect.choiceId);
    }),
  );
  yield* Effect.forkScoped(
    sweep.pipe(Effect.repeat(Schedule.spaced(`${MODEL_CHOICE_SWEEP_INTERVAL_MS} millis`))),
  );
});
