import { ServerThreadRetentionError } from "@bigbud/contracts/server/threadRetention.ts";
import { Effect, Layer, Option, Schema } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { ThreadRetention, type ThreadRetentionShape } from "../Services/ThreadRetention.ts";
import { runThreadRetentionScheduledTick } from "./ThreadRetention.scheduler.ts";
import { makeThreadRetentionPreview } from "./ThreadRetention.preview.ts";
import { makeSetThreadRetentionPolicy } from "./ThreadRetention.policy.ts";
import { runDirectThreadRetention } from "./ThreadRetention.direct.ts";
import { runThreadRetentionSchedule } from "./ThreadRetention.scheduler.ts";

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
  const run = (
    policy: import("@bigbud/contracts").FiniteThreadRetentionPolicy,
    trigger: "manual" | "scheduled",
  ) => runDirectThreadRetention({ policy, trigger, repository, orchestration });

  const enqueue: ThreadRetentionShape["enqueue"] = ({ challengeToken }) =>
    Effect.gen(function* () {
      if (process.env.BIGBUD_DISABLE_THREAD_RETENTION === "1") {
        return yield* retentionError(
          "disabled",
          "Thread retention is disabled by the server administrator.",
        );
      }
      const accepted = yield* repository.consumeManualChallenge({
        token: challengeToken,
        consumedAt: new Date().toISOString(),
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
      return yield* run(accepted.policy, "manual");
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
    run: (policy) => run(policy, "scheduled").pipe(Effect.asVoid),
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
    start: runThreadRetentionSchedule(runScheduledOnce),
  } satisfies ThreadRetentionShape;
});

export const ThreadRetentionLive = Layer.effect(ThreadRetention, makeThreadRetention);
