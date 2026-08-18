import {
  type OrchestrationThread,
  DEFAULT_RUNTIME_MODE,
  EventId,
  ThreadId,
  type OrchestrationSession,
  type ProviderSession,
} from "@bigbud/contracts";
import { Cause, Duration, Effect, Option } from "effect";

import { BrowserManager } from "../../browser/Services/BrowserManager.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { EntityPurge } from "../../deletion/Services/EntityPurge.ts";
import { ThreadDeletionOperationError } from "../../deletion/Services/ThreadDeletion.ts";
import type { DiscoveredThreadDeletionFiles } from "../../deletion/Layers/ThreadDeletion.files.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { ThreadShellRunner } from "../../shell/Services/ThreadShellRunner.ts";
import {
  persistRequiredBaselineSequence,
  retentionFinalizeCommandId,
  retentionRetryDelayMs,
} from "../../retention/Layers/ThreadRetention.coordinator.helpers.ts";
import { increment, threadRetentionItemsTotal } from "../../observability/Metrics.ts";

type DeleteRequestedEvent = Extract<
  import("@bigbud/contracts").OrchestrationEvent,
  { type: "thread.deletion-requested" }
>;

interface DeletionDeps {
  readonly resolveThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
  readonly setThreadSession: (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) => Effect.Effect<void, OrchestrationDispatchError>;
}

const STEP_TIMEOUT = Duration.seconds(15);

function describeFailures(
  failures: ReadonlyArray<{
    readonly step: "provider" | "browser" | "terminal" | "shell";
    readonly detail: string;
  }>,
): string {
  return failures.map((failure) => failure.step).join(", ");
}

export const makeProcessDeletionRequested = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const browser = yield* BrowserManager;
  const terminal = yield* TerminalManager;
  const entityPurge = yield* EntityPurge;
  const retentionRepository = yield* Effect.serviceOption(ThreadRetentionRepository);
  const retention = Option.getOrUndefined(retentionRepository);
  const shell = yield* Effect.serviceOption(ThreadShellRunner);

  const appendDeletionFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
    readonly detail: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("thread-delete-failed-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: "thread.delete.failed",
        summary: "Thread deletion failed",
        payload: {
          detail: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const makeStoppedSession = (input: {
    readonly threadId: ThreadId;
    readonly occurredAt: string;
    readonly threadSession: import("@bigbud/contracts").OrchestrationThread["session"];
    readonly liveSession: ProviderSession | undefined;
  }): OrchestrationSession => ({
    threadId: input.threadId,
    status: "stopped",
    providerName: input.threadSession?.providerName ?? input.liveSession?.provider ?? null,
    runtimeMode:
      input.threadSession?.runtimeMode ?? input.liveSession?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    activeTurnId: null,
    lastError: input.threadSession?.lastError ?? input.liveSession?.lastError ?? null,
    updatedAt: input.occurredAt,
  });

  const runCleanupStep = <A, E, R>(
    step: "provider" | "browser" | "terminal" | "shell",
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.timeout(STEP_TIMEOUT),
      Effect.exit,
      Effect.map((exit) =>
        exit._tag === "Failure"
          ? {
              ok: false as const,
              step,
              detail: Cause.pretty(exit.cause),
            }
          : { ok: true as const, step },
      ),
    );

  return Effect.fn("processDeletionRequested")(function* (
    deps: DeletionDeps,
    event: DeleteRequestedEvent,
  ) {
    const thread = yield* deps.resolveThread(event.payload.threadId);
    if (!thread || thread.deletedAt !== null) {
      return;
    }

    const retentionItem =
      event.commandId && retention
        ? yield* retention.findItemByDeletionCommandId(event.commandId)
        : Option.none();

    if (Option.isNone(retentionItem)) {
      let discoveredFiles: DiscoveredThreadDeletionFiles | undefined;
      let purgeJob: import("../../persistence/Services/PurgeJobRepository.ts").PurgeJob | undefined;
      const outcome = yield* orchestrationEngine.threadDeletion!.deleteNow({
        rootThreadId: thread.id,
        fenceAlreadyHeld: true,
        resolveThreads: () =>
          orchestrationEngine.getReadModel().pipe(Effect.map((model) => model.threads)),
        preflight: (threads) =>
          Effect.gen(function* () {
            if (threads.some((candidate) => candidate.pinnedAt !== null)) return "pinned" as const;
            const liveSessions = yield* providerService.listSessions();
            const hasActiveRuntime = threads.some(
              (candidate) =>
                candidate.session?.status === "starting" ||
                candidate.session?.status === "running" ||
                candidate.latestTurn?.state === "running" ||
                liveSessions.some(
                  (session) =>
                    session.threadId === candidate.id &&
                    (session.status === "connecting" || session.status === "running"),
                ),
            );
            return hasActiveRuntime ? ("active" as const) : undefined;
          }).pipe(
            Effect.mapError((error) => new ThreadDeletionOperationError({ detail: String(error) })),
          ),
        teardown: (candidate) =>
          Effect.gen(function* () {
            const liveSessions = yield* providerService.listSessions();
            const liveSession = liveSessions.find((session) => session.threadId === candidate.id);
            const providerCleanup =
              liveSession !== undefined
                ? providerService.stopSession({ threadId: candidate.id }).pipe(
                    Effect.andThen(
                      deps.setThreadSession({
                        threadId: candidate.id,
                        session: makeStoppedSession({
                          threadId: candidate.id,
                          occurredAt: event.occurredAt,
                          threadSession: candidate.session,
                          liveSession,
                        }),
                        createdAt: event.occurredAt,
                      }),
                    ),
                  )
                : candidate.session && candidate.session.status !== "stopped"
                  ? deps.setThreadSession({
                      threadId: candidate.id,
                      session: makeStoppedSession({
                        threadId: candidate.id,
                        occurredAt: event.occurredAt,
                        threadSession: candidate.session,
                        liveSession: undefined,
                      }),
                      createdAt: event.occurredAt,
                    })
                  : Effect.void;
            const results = yield* Effect.all(
              [
                runCleanupStep("provider", providerCleanup),
                runCleanupStep("browser", browser.close(candidate.id)),
                runCleanupStep(
                  "terminal",
                  terminal.close({ threadId: candidate.id, deleteHistory: false }),
                ),
                runCleanupStep(
                  "shell",
                  Option.isSome(shell) ? shell.value.closeThread(candidate.id) : Effect.void,
                ),
              ],
              { concurrency: 1 },
            );
            const failures = results.filter((result) => !result.ok);
            if (failures.length > 0) {
              return yield* Effect.fail(
                new Error(`Runtime cleanup failed: ${describeFailures(failures)}.`),
              );
            }
          }).pipe(
            Effect.mapError((error) => new ThreadDeletionOperationError({ detail: String(error) })),
          ),
        finalize: (threadIds) =>
          Effect.gen(function* () {
            discoveredFiles = yield* orchestrationEngine.threadDeletion!.discoverFiles({
              rootThreadId: thread.id,
              threadIds,
            });
            purgeJob = yield* entityPurge.requestThread(thread.id);
            yield* orchestrationEngine.dispatch({
              type: "thread.delete.finalize",
              commandId: serverCommandId("thread-delete-finalize"),
              threadId: thread.id,
              threadIds,
              createdAt: new Date().toISOString(),
            });
          }).pipe(
            Effect.mapError((error) => new ThreadDeletionOperationError({ detail: String(error) })),
          ),
      });

      if (outcome.type !== "deleted") {
        const createdAt = new Date().toISOString();
        yield* orchestrationEngine.dispatch({
          type: "thread.delete.abort",
          commandId: serverCommandId("thread-delete-abort"),
          threadId: thread.id,
          createdAt,
        });
        if (outcome.type === "failed") {
          yield* appendDeletionFailureActivity({
            threadId: thread.id,
            createdAt,
            detail: outcome.detail,
          }).pipe(Effect.asVoid);
        }
        return;
      }

      if (discoveredFiles) yield* orchestrationEngine.threadDeletion!.cleanupFiles(discoveredFiles);
      if (purgeJob) yield* entityPurge.run(purgeJob);
      return;
    }

    const liveSessions = yield* providerService.listSessions();
    const liveSession = liveSessions.find((session) => session.threadId === thread.id);
    const runtimeBecameActive =
      thread.session?.status === "starting" ||
      thread.session?.status === "running" ||
      liveSession?.status === "connecting" ||
      liveSession?.status === "running";
    if (Option.isSome(retentionItem) && runtimeBecameActive) {
      const createdAt = new Date().toISOString();
      yield* retention!.transitionItem({
        runId: retentionItem.value.runId,
        threadId: thread.id,
        expectedStatuses: ["deletion_requested"],
        nextStatus: "skipped",
        exclusionReason: "running",
        updatedAt: createdAt,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.delete.abort",
        commandId: serverCommandId("thread-retention-delete-abort"),
        threadId: thread.id,
        createdAt,
      });
      return;
    }

    const providerCleanup =
      liveSession !== undefined
        ? providerService.stopSession({ threadId: thread.id }).pipe(
            Effect.andThen(
              deps.setThreadSession({
                threadId: thread.id,
                session: makeStoppedSession({
                  threadId: thread.id,
                  occurredAt: event.occurredAt,
                  threadSession: thread.session,
                  liveSession,
                }),
                createdAt: event.occurredAt,
              }),
            ),
          )
        : thread.session && thread.session.status !== "stopped"
          ? deps.setThreadSession({
              threadId: thread.id,
              session: makeStoppedSession({
                threadId: thread.id,
                occurredAt: event.occurredAt,
                threadSession: thread.session,
                liveSession: undefined,
              }),
              createdAt: event.occurredAt,
            })
          : Effect.void;

    const results = yield* Effect.all(
      [
        runCleanupStep("provider", providerCleanup),
        runCleanupStep("browser", browser.close(thread.id)),
        runCleanupStep("terminal", terminal.close({ threadId: thread.id, deleteHistory: false })),
        runCleanupStep(
          "shell",
          Option.isSome(shell) ? shell.value.closeThread(thread.id) : Effect.void,
        ),
      ],
      { concurrency: 1 },
    );

    const failures = results.filter((result) => !result.ok);
    if (failures.length > 0) {
      const failedSteps = describeFailures(failures);
      const createdAt = new Date().toISOString();
      yield* Effect.logWarning("thread deletion runtime cleanup failed", {
        failedSteps,
      });
      if (Option.isSome(retentionItem)) {
        yield* retention!.recordItemRetry({
          runId: retentionItem.value.runId,
          threadId: thread.id,
          expectedStatuses: ["deletion_requested"],
          lastErrorCode: "cleanup_failed",
          nextAttemptAt: new Date(
            Date.parse(createdAt) + retentionRetryDelayMs(retentionItem.value.attemptCount + 1),
          ).toISOString(),
          updatedAt: createdAt,
        });
        return;
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.delete.abort",
        commandId: serverCommandId("thread-delete-abort"),
        threadId: thread.id,
        createdAt,
      });
      yield* appendDeletionFailureActivity({
        threadId: thread.id,
        createdAt,
        detail: "One or more runtime cleanup steps failed.",
      }).pipe(Effect.asVoid);
      return;
    }

    const createdAt = new Date().toISOString();
    const purgeJob = yield* entityPurge.requestThread(thread.id);
    const finalized = yield* orchestrationEngine.dispatch({
      type: "thread.delete.finalize",
      commandId: Option.isSome(retentionItem)
        ? retentionFinalizeCommandId(retentionItem.value.runId, thread.id)
        : serverCommandId("thread-delete-finalize"),
      threadId: thread.id,
      createdAt,
    });
    if (Option.isSome(retentionItem)) {
      yield* persistRequiredBaselineSequence(
        retention!,
        retentionItem.value.runId,
        finalized.sequence,
        createdAt,
      );
      const prepared = yield* retention!.markPrepared({
        runId: retentionItem.value.runId,
        threadId: thread.id,
        purgeJobId: purgeJob.jobId,
        updatedAt: createdAt,
      });
      if (prepared) yield* increment(threadRetentionItemsTotal, { outcome: "prepared" });
      return;
    }
    yield* entityPurge.run(purgeJob);
  });
});
