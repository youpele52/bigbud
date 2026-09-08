import { ServerThreadRetentionError } from "@bigbud/contracts/server/threadRetention.ts";
import { Effect, Layer, Option, Schema } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { ThreadRetention, type ThreadRetentionShape } from "../Services/ThreadRetention.ts";
import { runThreadRetentionScheduledTick } from "./ThreadRetention.scheduler.ts";
import { makeThreadRetentionPreview } from "./ThreadRetention.preview.ts";
import { makeSetThreadRetentionPolicy } from "./ThreadRetention.policy.ts";
import { runThreadRetentionSchedule } from "./ThreadRetention.scheduler.ts";
import { makeThreadRetentionExecutionCoordinator } from "./ThreadRetention.coordinator.ts";
import { cutoffForRetentionPolicy } from "./ThreadRetention.logic.ts";

const retentionError = (code: ServerThreadRetentionError["code"], message: string) =>
  new ServerThreadRetentionError({ code, message });

const makeThreadRetention = Effect.gen(function* () {
  const repository = yield* ThreadRetentionRepository;
  const orchestration = yield* OrchestrationEngineService;
  const settings = yield* ServerSettingsService;
  const getAuthoritativePolicy = repository.getPolicyAuthority().pipe(
    Effect.map((authority) =>
      Option.match(authority, {
        onNone: () => "never" as const,
        onSome: (value) => value.policy,
      }),
    ),
  );
  const preview = makeThreadRetentionPreview({ repository });
  const coordinator = yield* makeThreadRetentionExecutionCoordinator({ repository, orchestration });

  const enqueue: ThreadRetentionShape["enqueue"] = ({ challengeToken }) =>
    Effect.gen(function* () {
      if (process.env.BIGBUD_DISABLE_THREAD_RETENTION === "1") {
        return yield* retentionError(
          "disabled",
          "Thread retention is disabled by the server administrator.",
        );
      }
      const consumedAt = new Date().toISOString();
      const accepted = yield* repository.consumeChallengeAndCreateRun({
        token: challengeToken,
        trigger: "manual",
        runId: crypto.randomUUID(),
        consumedAt,
      });
      if (!accepted.consumed) {
        if (accepted.result === "expired")
          return yield* retentionError(
            "challenge_expired",
            "The confirmation expired. Preview again.",
          );
        if (accepted.result === "already_consumed")
          return yield* retentionError("challenge_consumed", "The confirmation was already used.");
        return yield* retentionError("challenge_invalid", "The confirmation is invalid.");
      }
      return yield* coordinator.execute(accepted.run.runId);
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(ServerThreadRetentionError)(error)
          ? error
          : retentionError("failed", "Failed to run thread retention."),
      ),
    );

  const runScheduledOnce = runThreadRetentionScheduledTick({
    getPolicy: getAuthoritativePolicy,
    isDisabled: () => process.env.BIGBUD_DISABLE_THREAD_RETENTION === "1",
    run: (policy) =>
      Effect.gen(function* () {
        const createdAt = new Date().toISOString();
        const scheduled = yield* repository.createScheduledQueuedRun({
          runId: crypto.randomUUID(),
          trigger: "scheduled",
          policy,
          cutoffAt: cutoffForRetentionPolicy(policy, Date.parse(createdAt)),
          createdAt,
        });
        yield* coordinator.execute(scheduled.run.runId);
      }).pipe(Effect.asVoid),
  }).pipe(
    Effect.mapError((error) =>
      Schema.is(ServerThreadRetentionError)(error)
        ? error
        : retentionError("failed", "Scheduled thread retention failed."),
    ),
  );

  return {
    preview,
    enqueue,
    setPolicy: makeSetThreadRetentionPolicy({
      repository,
      settings,
      getPolicy: getAuthoritativePolicy,
    }),
    runScheduledOnce,
    start: coordinator.drain().pipe(
      Effect.catch((error) =>
        Effect.logWarning("thread retention startup recovery deferred", {
          detail: String(error),
        }),
      ),
      Effect.andThen(runThreadRetentionSchedule(runScheduledOnce)),
    ),
  } satisfies ThreadRetentionShape;
});

export const ThreadRetentionLive = Layer.effect(ThreadRetention, makeThreadRetention);
