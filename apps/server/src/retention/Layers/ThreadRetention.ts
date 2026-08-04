import { ServerThreadRetentionError } from "@bigbud/contracts/server/threadRetention.ts";
import { Cause, Effect, Layer, Option, Queue, Ref, Schema } from "effect";

import { EntityPurge } from "../../deletion/Services/EntityPurge.ts";
import { BrowserManager } from "../../browser/Services/BrowserManager.ts";
import { ComputerUse } from "../../computer-use/Services/ComputerUse.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { PurgeJobRepository } from "../../persistence/Services/PurgeJobRepository.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ThreadShellRunner } from "../../shell/Services/ThreadShellRunner.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import {
  increment,
  threadRetentionPurgeBacklog,
  threadRetentionRunAge,
  threadRetentionRunsTotal,
} from "../../observability/Metrics.ts";
import { ThreadRetention, type ThreadRetentionShape } from "../Services/ThreadRetention.ts";
import { runThreadRetentionScheduledTick } from "./ThreadRetention.scheduler.ts";
import { cutoffForRetentionPolicy, toPublicThreadRetentionRun } from "./ThreadRetention.logic.ts";
import { makeProcessThreadRetentionRun } from "./ThreadRetention.coordinator.ts";
import { makeRetryRetentionRuntimeCleanup } from "./ThreadRetention.cleanup.ts";
import {
  recentRetentionFailureSummary,
  hasProviderRuntimePressure,
  retentionCircuitReopenAt,
  type ThreadRetentionRepositoryAuditExtensions,
} from "./ThreadRetention.coordinator.helpers.ts";
import { makeThreadRetentionPreview } from "./ThreadRetention.preview.ts";
import { makeSetThreadRetentionPolicy } from "./ThreadRetention.policy.ts";
import {
  makeThreadRetentionStart,
  makeThreadRetentionWakeScheduler,
} from "./ThreadRetention.runtime.ts";

const RETENTION_READY_DELAY_MS = 10 * 60 * 1_000;
const PURGE_BACKLOG_LIMIT = 100;

const retentionError = (code: ServerThreadRetentionError["code"], message: string) =>
  new ServerThreadRetentionError({ code, message });

const makeThreadRetention = Effect.gen(function* () {
  const repository = yield* ThreadRetentionRepository;
  const purgeJobs = yield* PurgeJobRepository;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const threads = yield* ProjectionThreadRepository;
  const entityPurge = yield* EntityPurge;
  const orchestration = yield* OrchestrationEngineService;
  const providers = yield* ProviderService;
  const browser = yield* BrowserManager;
  const terminal = yield* TerminalManager;
  const computerUse = yield* Effect.serviceOption(ComputerUse);
  const shell = yield* Effect.serviceOption(ThreadShellRunner);
  const settings = yield* ServerSettingsService;
  const providerRuntime = yield* Effect.serviceOption(ProviderSessionRuntimeRepository);
  const workQueue = yield* Queue.unbounded<string>();
  const scope = yield* Effect.scope;
  const maintenanceReadyAt = yield* Ref.make<number | null>(null);
  const scheduleWake = yield* makeThreadRetentionWakeScheduler({ workQueue, scope });

  const loadRun = Effect.fn("ThreadRetention.loadRun")(function* (runId: string) {
    const run = yield* repository.getRun(runId);
    if (Option.isNone(run))
      return yield* retentionError("not_found", "Retention run was not found.");
    return run.value;
  });
  const getAuthoritativePolicy = repository.getPolicyAuthority().pipe(
    Effect.map((authority) =>
      Option.match(authority, {
        onNone: () => "never" as const,
        onSome: (value) => value.policy,
      }),
    ),
  );

  const processRun = makeProcessThreadRetentionRun({
    repository,
    purgeJobs,
    receipts,
    threads,
    entityPurge,
    orchestration,
    retryRuntimeCleanup: makeRetryRetentionRuntimeCleanup({
      providers,
      browser,
      terminal,
      ...(Option.isSome(computerUse) ? { computerUse: computerUse.value } : {}),
      ...(Option.isSome(shell) ? { shell: shell.value } : {}),
    }),
    selectionGate: (run) =>
      Effect.gen(function* () {
        if (process.env.BIGBUD_DISABLE_THREAD_RETENTION === "1") return "disabled" as const;
        if (run.trigger === "scheduled") {
          if (process.env.BIGBUD_INTERNAL_THREAD_RETENTION_AUTOMATIC_ROLLOUT !== "1") {
            return "disabled" as const;
          }
          const policy = yield* getAuthoritativePolicy;
          if (policy === "never") return "policy_never" as const;
          if (policy !== run.policy) return "policy_changed" as const;
          const discovered = yield* providers.listSessions();
          const durable = Option.isSome(providerRuntime) ? yield* providerRuntime.value.list() : [];
          if (hasProviderRuntimePressure([...discovered, ...durable])) {
            return "provider_pressure" as const;
          }
        }
        const reopenAt = retentionCircuitReopenAt(
          yield* recentRetentionFailureSummary(
            repository as ThreadRetentionRepositoryAuditExtensions,
            Date.now(),
          ),
        );
        if (reopenAt !== null && reopenAt > new Date().toISOString()) {
          return { reason: "recent_failures" as const, wakeAt: reopenAt };
        }
        return null;
      }).pipe(Effect.orDie),
    scheduleWake,
    loadRun,
  });

  yield* Effect.forkScoped(
    Effect.forever(
      Queue.take(workQueue).pipe(
        Effect.flatMap((runId) =>
          processRun(runId).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.gen(function* () {
                    const run = yield* loadRun(runId);
                    const failedAt = new Date().toISOString();
                    const retry = yield* repository.recordRunFailure({
                      runId,
                      expectedStatuses: [run.status],
                      failedAt,
                      lastErrorCode: "coordinator_failure",
                    });
                    if (Option.isNone(retry)) return;
                    yield* repository.transitionRun({
                      runId,
                      expectedStatuses: [run.status],
                      nextStatus: "deferred",
                      updatedAt: failedAt,
                    });
                    yield* increment(threadRetentionRunsTotal, {
                      trigger: run.trigger,
                      policy: run.policy,
                      outcome: "deferred",
                    });
                    if (retry.value.nextAttemptAt !== null) {
                      yield* scheduleWake(runId, retry.value.nextAttemptAt);
                    }
                    yield* Effect.logWarning("thread retention run deferred", {
                      reason: "coordinator_failure",
                    });
                  }).pipe(
                    Effect.catchCause(() =>
                      Effect.logWarning("thread retention failure recovery failed", {
                        reason: "retry_persistence_failure",
                      }),
                    ),
                  ),
            ),
          ),
        ),
      ),
    ),
  );

  const preview = makeThreadRetentionPreview({ repository, getPolicy: getAuthoritativePolicy });

  const enqueue: ThreadRetentionShape["enqueue"] = ({ challengeToken }) =>
    Effect.gen(function* () {
      if (process.env.BIGBUD_DISABLE_THREAD_RETENTION === "1") {
        return yield* retentionError(
          "disabled",
          "Thread retention is disabled by the server administrator.",
        );
      }
      const readyAt = yield* Ref.get(maintenanceReadyAt);
      if (readyAt === null || Date.now() < readyAt) {
        return yield* retentionError("busy", "Thread retention is not ready yet.");
      }
      if ((yield* purgeJobs.countIncomplete()) >= PURGE_BACKLOG_LIMIT) {
        return yield* retentionError(
          "busy",
          "Purge recovery must catch up before retention starts.",
        );
      }
      if ((yield* repository.listRecoverableRuns(1)).length > 0) {
        return yield* retentionError(
          "busy",
          "Thread retention maintenance is already active. Wait for it to finish before starting another run.",
        );
      }
      const challengeOption = yield* repository.readChallenge(challengeToken);
      if (Option.isNone(challengeOption) || challengeOption.value.trigger !== "manual") {
        return yield* retentionError(
          "challenge_invalid",
          "The confirmation no longer matches this action.",
        );
      }
      const challenge = challengeOption.value;
      const configuredPolicy = yield* getAuthoritativePolicy;
      if (configuredPolicy !== "never" && configuredPolicy !== challenge.policy) {
        return yield* retentionError(
          "validation",
          "The configured retention period changed. Preview this action again.",
        );
      }
      const now = new Date().toISOString();
      const requestedRunId = crypto.randomUUID();
      const accepted = yield* repository.consumeChallengeAndCreateRun({
        token: challengeToken,
        trigger: "manual",
        runId: requestedRunId,
        consumedAt: now,
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
      const run = accepted.run;
      if (
        run.runId !== requestedRunId &&
        (run.trigger !== "manual" ||
          run.policy !== challenge.policy ||
          run.cutoffAt !== challenge.cutoffAt)
      ) {
        return yield* retentionError(
          "busy",
          "Thread retention maintenance is already running with a different cutoff.",
        );
      }
      yield* increment(threadRetentionRunsTotal, {
        trigger: "manual",
        policy: run.policy,
        outcome: "started",
      });
      yield* Queue.offer(workQueue, run.runId);
      return toPublicThreadRetentionRun(run);
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(ServerThreadRetentionError)(error)
          ? error
          : retentionError("failed", "Failed to start thread retention."),
      ),
    );

  const runScheduledTick = runThreadRetentionScheduledTick({
    auditAndResume: Effect.gen(function* () {
      yield* entityPurge.auditAndResume(100);
      const recoverable = yield* repository.listRecoverableRuns(1);
      yield* increment(threadRetentionPurgeBacklog, {}, yield* purgeJobs.countIncomplete());
      yield* increment(
        threadRetentionRunAge,
        {},
        recoverable[0] ? Math.max(0, Date.now() - Date.parse(recoverable[0].createdAt)) : 0,
      );
      for (const run of recoverable) {
        if (run.nextAttemptAt !== null && run.nextAttemptAt > new Date().toISOString()) {
          yield* scheduleWake(run.runId, run.nextAttemptAt);
        } else {
          yield* Queue.offer(workQueue, run.runId);
        }
      }
      yield* repository.cleanupAudit({
        olderThan: new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString(),
        keepLatest: 100,
      });
    }),
    getPolicy: getAuthoritativePolicy,
    isDisabled: () => process.env.BIGBUD_DISABLE_THREAD_RETENTION === "1",
    isAutomaticRolloutEnabled: () =>
      process.env.BIGBUD_INTERNAL_THREAD_RETENTION_AUTOMATIC_ROLLOUT === "1",
    enqueue: (policy) => {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      return purgeJobs.countIncomplete().pipe(
        Effect.flatMap((backlog) =>
          backlog >= PURGE_BACKLOG_LIMIT
            ? Effect.void
            : repository
                .createOrGetActiveRun({
                  runId: crypto.randomUUID(),
                  trigger: "scheduled",
                  policy,
                  cutoffAt: cutoffForRetentionPolicy(policy, nowMs),
                  createdAt: now,
                })
                .pipe(
                  Effect.tap((run) =>
                    increment(threadRetentionRunsTotal, {
                      trigger: "scheduled",
                      policy: run.policy,
                      outcome: "started",
                    }),
                  ),
                  Effect.flatMap((run) => Queue.offer(workQueue, run.runId)),
                  Effect.asVoid,
                ),
        ),
      );
    },
  });

  const runScheduledOnce: ThreadRetentionShape["runScheduledOnce"] = Effect.gen(function* () {
    const readyAt = yield* Ref.get(maintenanceReadyAt);
    if (readyAt === null || Date.now() < readyAt) {
      return yield* retentionError("busy", "Thread retention is not ready yet.");
    }
    yield* runScheduledTick;
  }).pipe(
    Effect.mapError((error) =>
      Schema.is(ServerThreadRetentionError)(error)
        ? error
        : retentionError("failed", "Scheduled thread retention failed."),
    ),
  );
  const setPolicy = makeSetThreadRetentionPolicy({
    repository,
    settings,
    getPolicy: getAuthoritativePolicy,
  });

  return {
    preview,
    enqueue,
    getRun: (runId) =>
      loadRun(runId).pipe(
        Effect.map(toPublicThreadRetentionRun),
        Effect.mapError((error) =>
          Schema.is(ServerThreadRetentionError)(error)
            ? error
            : retentionError("failed", "Failed to load the retention run."),
        ),
      ),
    listRuns: (limit = 20) =>
      repository.listRecentRuns(Math.max(1, Math.min(20, limit))).pipe(
        Effect.map((runs) => ({
          runs: runs.map(toPublicThreadRetentionRun),
          availability:
            process.env.BIGBUD_DISABLE_THREAD_RETENTION === "1"
              ? ("disabled" as const)
              : ("available" as const),
        })),
        Effect.mapError(() => retentionError("failed", "Failed to list retention runs.")),
      ),
    setPolicy,
    runScheduledOnce,
    start: makeThreadRetentionStart({
      maintenanceReadyAt,
      readyDelayMs: RETENTION_READY_DELAY_MS,
      repository,
      workQueue,
      runScheduledTick,
      scheduleWake,
    }),
  } satisfies ThreadRetentionShape;
});

export const ThreadRetentionLive = Layer.effect(ThreadRetention, makeThreadRetention);
