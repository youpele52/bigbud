import { ServerThreadRetentionError } from "@bigbud/contracts/server/threadRetention.ts";
import { Effect, Layer, Option, Schedule, Schema } from "effect";

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
import { toServerThreadRetentionRun } from "./ThreadRetention.public.ts";

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
      yield* coordinator.drain().pipe(
        Effect.catch((error) =>
          Effect.logWarning("thread retention background execution deferred", {
            runId: accepted.run.runId,
            detail: String(error),
          }),
        ),
        Effect.forkDetach,
      );
      return toServerThreadRetentionRun(accepted.run);
    }).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("thread retention execution failed", { detail: String(error) }),
      ),
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
        const authority = yield* repository.getPolicyAuthority();
        const saved = Option.getOrUndefined(authority);
        if (saved?.policy !== policy) return;
        const createdAt = new Date().toISOString();
        const scheduled = yield* repository.createScheduledQueuedRun({
          runId: crypto.randomUUID(),
          trigger: "scheduled",
          policy,
          selectionMode: saved.selectionMode ?? "legacy-subtree",
          ageCriterion: saved.ageCriterion ?? "last-conversation-activity",
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
    getRun: ({ runId }) =>
      Effect.gen(function* () {
        const run = yield* repository.getRun(runId);
        if (Option.isNone(run)) {
          return yield* retentionError("not_found", "Thread cleanup run was not found.");
        }
        const resources = yield* repository.readResourceSummary(runId);
        return toServerThreadRetentionRun(run.value, resources);
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(ServerThreadRetentionError)(error)
            ? error
            : retentionError("failed", "Failed to load thread cleanup progress."),
        ),
      ),
    listRecentRuns: ({ limit }) =>
      repository.listRecentRuns(Math.min(limit ?? 20, 50)).pipe(
        Effect.flatMap((runs) =>
          Effect.forEach(runs, (run) =>
            repository
              .readResourceSummary(run.runId)
              .pipe(Effect.map((resources) => toServerThreadRetentionRun(run, resources))),
          ),
        ),
        Effect.flatMap((runs) =>
          repository.getPolicyAuthority().pipe(
            Effect.map((authority) => ({
              runs,
              availability:
                process.env.BIGBUD_DISABLE_THREAD_RETENTION === "1"
                  ? ("disabled" as const)
                  : ("available" as const),
              policySelectionMode:
                Option.getOrUndefined(authority)?.selectionMode ?? ("legacy-subtree" as const),
              policyAgeCriterion:
                Option.getOrUndefined(authority)?.ageCriterion ??
                ("last-conversation-activity" as const),
            })),
          ),
        ),
        Effect.mapError(() => retentionError("failed", "Failed to list thread cleanup runs.")),
      ),
    setPolicy: makeSetThreadRetentionPolicy({
      repository,
      settings,
      getPolicy: getAuthoritativePolicy,
    }),
    runScheduledOnce,
    start: Effect.gen(function* () {
      yield* Effect.repeat(
        coordinator.drain().pipe(
          Effect.catch((error) =>
            Effect.logWarning("thread retention recovery deferred", {
              detail: String(error),
            }),
          ),
        ),
        Schedule.fixed("1 minute"),
      ).pipe(Effect.forkDetach);
      yield* runThreadRetentionSchedule(runScheduledOnce);
    }),
  } satisfies ThreadRetentionShape;
});

export const ThreadRetentionLive = Layer.effect(ThreadRetention, makeThreadRetention);
