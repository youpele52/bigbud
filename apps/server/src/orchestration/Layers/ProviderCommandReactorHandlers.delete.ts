import { CommandId, type OrchestrationThread, ThreadId } from "@bigbud/contracts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { BrowserManager } from "../../browser/Services/BrowserManager.ts";
import { finalizeThreadCanonicalHistory } from "../../deletion/Layers/CanonicalThreadCleanup.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { serverCommandId } from "./ProviderCommandReactorHelpers.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { ThreadDeletionOperationError } from "../../deletion/Services/ThreadDeletion.ts";
import { threadSubtreeHasLiveActiveRuntime } from "../../deletion/Services/ThreadDeletion.preflight.ts";
import { ThreadShellRunner } from "../../shell/Services/ThreadShellRunner.ts";
import { DirectResourceCleanupExecutor } from "../../deletion/Services/DirectResourceCleanupExecutor.ts";
import { DirectResourceCleanupRepository } from "../../persistence/Services/DirectResourceCleanupRepository.ts";
import { calculateCommandPayloadDigest } from "../commandDigest.ts";
import { executeReadyDirectCleanupPlan } from "../../deletion/Layers/DirectResourceCleanupCoordinator.ts";
import { createHash } from "node:crypto";
import { makeDirectResourceCleanupExecutor } from "../../deletion/Layers/DirectResourceCleanupExecutor.ts";
import { makeDirectResourceCleanupRepository } from "../../persistence/Layers/DirectResourceCleanupRepository.ts";
import { directCleanupProofDigest } from "../../deletion/Layers/DirectResourceCleanup.proof.ts";
import {
  describeRuntimeCleanupFailures,
  appendDeletionFailureActivity,
  hydrateStoredDirectCleanupResources,
  makeStoppedDeletionSession,
  readFinalizeReceiptStatus,
  resolveDeletionRequestMode,
  runCleanupStep,
} from "./ProviderCommandReactorHandlers.delete.cleanup.ts";
import { ServerConfig } from "../../startup/config.ts";
type DeleteRequestedEvent = Extract<OrchestrationEvent, { type: "thread.deletion-requested" }>;
interface DeletionDeps {
  readonly resolveThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
  readonly setThreadSession: (input: {
    readonly threadId: ThreadId;
    readonly session: import("@bigbud/contracts").OrchestrationSession;
    readonly createdAt: string;
  }) => Effect.Effect<void, OrchestrationDispatchError>;
}
export const makeProcessDeletionRequested = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const browser = yield* BrowserManager;
  const terminal = yield* TerminalManager;
  const shell = yield* Effect.serviceOption(ThreadShellRunner);
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig;
  const cleanupExecutorService = yield* Effect.serviceOption(DirectResourceCleanupExecutor);
  const cleanupExecutor = Option.isSome(cleanupExecutorService)
    ? cleanupExecutorService.value
    : makeDirectResourceCleanupExecutor();
  const cleanupRepositoryService = yield* Effect.serviceOption(DirectResourceCleanupRepository);
  const cleanupRepository = Option.isSome(cleanupRepositoryService)
    ? cleanupRepositoryService.value
    : yield* makeDirectResourceCleanupRepository;
  return Effect.fn("processDeletionRequested")(function* (
    deps: DeletionDeps,
    event: DeleteRequestedEvent,
  ) {
    const mode = resolveDeletionRequestMode(event.payload.mode);
    const thread = yield* deps.resolveThread(event.payload.threadId);
    if (!thread || thread.deletedAt !== null) {
      yield* orchestrationEngine.threadDeletion!.releaseFence(event.payload.threadId, mode);
      return;
    }
    if (
      mode === "single" &&
      (yield* orchestrationEngine.threadDeletion!.isFenceRoot(thread.id, "subtree"))
    ) {
      return;
    }
    const fenceAlreadyHeld = yield* orchestrationEngine.threadDeletion!.isFenceRoot(
      thread.id,
      mode,
    );

    let preparedExecutor:
      | import("../../deletion/Services/DirectResourceCleanupExecutor.ts").PreparedDirectResourceCleanupExecutor
      | undefined;
    let preparedOperationId: string | undefined;
    let finalizeState: string = "not-started";
    const outcome = yield* orchestrationEngine
      .threadDeletion!.deleteNow({
        rootThreadId: thread.id,
        mode,
        fenceAlreadyHeld,
        resolveThreads: () =>
          orchestrationEngine.getReadModel().pipe(Effect.map((model) => model.threads)),
        preflight: (threads) =>
          Effect.gen(function* () {
            if (threads.some((candidate) => candidate.pinnedAt !== null)) return "pinned" as const;
            const liveSessions = yield* providerService.listSessions();
            return threadSubtreeHasLiveActiveRuntime({ threads, liveSessions })
              ? ("active" as const)
              : undefined;
          }).pipe(
            Effect.mapError((error) => new ThreadDeletionOperationError({ detail: String(error) })),
          ),
        teardown: (candidate) =>
          Effect.gen(function* () {
            preparedExecutor ??= yield* cleanupExecutor.prepare();
            const liveSessions = yield* providerService.listSessions();
            const liveSession = liveSessions.find((session) => session.threadId === candidate.id);
            const providerCleanup =
              liveSession !== undefined
                ? providerService.stopSession({ threadId: candidate.id }).pipe(
                    Effect.andThen(
                      deps.setThreadSession({
                        threadId: candidate.id,
                        session: makeStoppedDeletionSession({
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
                      session: makeStoppedDeletionSession({
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
                runCleanupStep("provider", () => providerCleanup),
                runCleanupStep("browser", () => browser.close(candidate.id)),
                runCleanupStep("terminal", () =>
                  terminal.close({ threadId: candidate.id, deleteHistory: false }),
                ),
                runCleanupStep("shell", () =>
                  Option.isSome(shell) ? shell.value.closeThread(candidate.id) : Effect.void,
                ),
              ],
              { concurrency: 1 },
            );
            const failures = results.filter((result) => !result.ok);
            if (failures.length > 0) {
              return yield* Effect.fail(
                new Error(`Runtime cleanup failed: ${describeRuntimeCleanupFailures(failures)}.`),
              );
            }
          }).pipe(
            Effect.mapError((error) => new ThreadDeletionOperationError({ detail: String(error) })),
          ),
        finalize: (threadIds) =>
          Effect.gen(function* () {
            const activeExecutor = (preparedExecutor ??= yield* cleanupExecutor.prepare());
            const files = yield* orchestrationEngine.threadDeletion!.discoverFiles({
              rootThreadId: thread.id,
              threadIds,
            });
            const operationId = `direct-cleanup:${event.eventId}`;
            preparedOperationId = operationId;
            const finalizeCommandId = CommandId.makeUnsafe(
              `server:thread-delete-finalize:${event.eventId}`,
            );
            const proposedFinalizeCommand = {
              type: "thread.delete.finalize",
              commandId: finalizeCommandId,
              threadId: thread.id,
              threadIds,
              mode,
              createdAt: event.occurredAt,
            } as const;
            yield* Effect.tryPromise(() => activeExecutor.assertAlive());
            let storedPlan = yield* cleanupRepository.loadPlan(operationId);
            if (!storedPlan) {
              const payloadDigest = calculateCommandPayloadDigest(proposedFinalizeCommand);
              const discoveredPlanDigest = createHash("sha256")
                .update(
                  JSON.stringify({
                    operationId,
                    finalizeCommand: proposedFinalizeCommand,
                    resources: files.directResources,
                    retainedResources: files.retainedResources,
                  }),
                )
                .digest("hex");
              yield* cleanupRepository.prepare({
                operationId,
                intentId: `deletion-intent:${event.eventId}`,
                finalizeCommandId,
                finalizePayloadJson: JSON.stringify(proposedFinalizeCommand),
                finalizePayloadDigestVersion: payloadDigest.version,
                finalizePayloadDigest: payloadDigest.digest,
                planDigest: discoveredPlanDigest,
                expectedPlatform: `${process.platform}/${process.arch}`,
                resources: files.directResources,
                retainedResources: files.retainedResources,
                createdAt: event.occurredAt,
              });
              storedPlan = yield* cleanupRepository.loadPlan(operationId);
            }
            if (!storedPlan) return yield* Effect.fail(new Error("cleanup plan was not stored"));
            const finalizeCommand = JSON.parse(
              storedPlan.finalizePayloadJson,
            ) as typeof proposedFinalizeCommand;
            const storedPayloadDigest = calculateCommandPayloadDigest(finalizeCommand);
            if (
              finalizeCommand.type !== proposedFinalizeCommand.type ||
              finalizeCommand.commandId !== proposedFinalizeCommand.commandId ||
              finalizeCommand.threadId !== proposedFinalizeCommand.threadId ||
              storedPayloadDigest.version !== storedPlan.finalizePayloadDigestVersion ||
              storedPayloadDigest.digest !== storedPlan.finalizePayloadDigest
            ) {
              return yield* Effect.fail(new Error("stored cleanup finalize command is invalid"));
            }
            const payloadDigest = {
              version: storedPlan.finalizePayloadDigestVersion,
              digest: storedPlan.finalizePayloadDigest,
            };
            const directResources = hydrateStoredDirectCleanupResources(
              config,
              storedPlan.resources,
            );
            finalizeState = "ambiguous";
            const finalized = yield* orchestrationEngine.dispatch(finalizeCommand);
            finalizeState = "committed";
            const finalizeEvents =
              yield* orchestrationEngine.readEventsByCommandId!(finalizeCommandId);
            const deletionEvent = finalizeEvents.find(
              (candidate) =>
                candidate.type === "thread.deleted" && candidate.aggregateId === thread.id,
            );
            let proofPersisted = false;
            if (deletionEvent) {
              proofPersisted = yield* cleanupRepository
                .markFinalizeCommitted({
                  operationId,
                  aggregateKind: "thread",
                  aggregateId: thread.id,
                  payloadDigestVersion: payloadDigest.version,
                  payloadDigest: payloadDigest.digest,
                  eventId: deletionEvent!.eventId,
                  eventSequence: deletionEvent!.sequence,
                  eventType: deletionEvent!.type,
                  eventPayloadJson: JSON.stringify(deletionEvent!.payload),
                  provenAt: new Date().toISOString(),
                })
                .pipe(
                  Effect.as(true),
                  Effect.catch((error) =>
                    Effect.logWarning("thread cleanup finalize proof deferred", {
                      rootThreadId: thread.id,
                      detail: String(error),
                    }).pipe(Effect.as(false)),
                  ),
                );
            }
            if (!proofPersisted) return;
            const pruningRecorded = yield* finalizeThreadCanonicalHistory({
              projectionPipeline,
              sql,
              threadId: thread.id,
              deletionSequence: finalized.sequence,
            }).pipe(
              Effect.andThen(
                cleanupRepository.markCanonicalPruned(operationId, new Date().toISOString()),
              ),
              Effect.as(true),
              Effect.catch((error) =>
                Effect.logWarning("thread canonical history cleanup deferred", {
                  rootThreadId: thread.id,
                  detail: String(error),
                }).pipe(Effect.as(false)),
              ),
            );
            yield* Effect.forEach(
              threadIds,
              (threadId) =>
                terminal.close({ threadId, deleteHistory: true }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("thread deletion terminal history cleanup deferred", {
                      rootThreadId: thread.id,
                      threadId,
                      detail: String(error),
                    }),
                  ),
                ),
              { concurrency: 1, discard: true },
            );
            const orphanedResources = yield* orchestrationEngine
              .threadDeletion!.cleanupWorktrees(files)
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("thread deletion file cleanup deferred", {
                    rootThreadId: thread.id,
                    detail: String(error),
                  }).pipe(Effect.as([{ resource: "files", detail: String(error) }])),
                ),
              );
            if (orphanedResources.length > 0) {
              yield* Effect.logWarning("thread deletion orphan resource cleanup required", {
                rootThreadId: thread.id,
                orphanedResources,
              });
            }
            if (!pruningRecorded) return;
            if (directResources.length > 0 && preparedExecutor) {
              yield* executeReadyDirectCleanupPlan({
                operationId,
                planDigest: storedPlan.planDigest,
                proofDigest: directCleanupProofDigest({
                  operationId,
                  payloadDigestVersion: payloadDigest.version,
                  payloadDigest: payloadDigest.digest,
                  eventId: deletionEvent!.eventId,
                  eventSequence: deletionEvent!.sequence,
                  eventType: deletionEvent!.type,
                  eventPayloadJson: JSON.stringify(deletionEvent!.payload),
                }),
                resources: directResources,
                executor: preparedExecutor,
                repository: cleanupRepository,
              }).pipe(
                Effect.catch(() =>
                  Effect.logWarning("thread resource cleanup deferred", {
                    rootThreadId: thread.id,
                    code: "execution_failure",
                  }),
                ),
              );
            } else {
              yield* cleanupRepository.complete(operationId, new Date().toISOString());
            }
          }).pipe(
            Effect.mapError((error) => new ThreadDeletionOperationError({ detail: String(error) })),
          ),
      })
      .pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            preparedExecutor
              ? Effect.tryPromise(() => preparedExecutor!.shutdown()).pipe(
                  Effect.ignore,
                  Effect.ensuring(Effect.sync(() => preparedExecutor!.close())),
                )
              : Effect.void,
          ),
        ),
      );

    if (outcome.type !== "deleted") {
      const createdAt = new Date().toISOString();
      if (finalizeState === "committed") {
        yield* Effect.logWarning("thread deletion committed with deferred cleanup", {
          rootThreadId: thread.id,
          detail: outcome.type === "failed" ? outcome.detail : outcome.type,
        });
        return;
      }
      if (finalizeState === "ambiguous") {
        const receipt = yield* readFinalizeReceiptStatus(
          sql,
          `server:thread-delete-finalize:${event.eventId}`,
        ).pipe(Effect.catch(() => Effect.succeed([])));
        if (receipt[0]?.status !== "rejected") {
          yield* Effect.logWarning("thread deletion finalize outcome deferred", {
            rootThreadId: thread.id,
          });
          return;
        }
      }
      if (preparedOperationId) {
        yield* cleanupRepository.cancelPrepared(preparedOperationId, createdAt).pipe(Effect.ignore);
      }
      yield* cleanupRepository
        .cancelIntentIfUnplanned(`deletion-intent:${event.eventId}`, createdAt)
        .pipe(Effect.ignore);
      yield* orchestrationEngine.dispatch({
        type: "thread.delete.abort",
        commandId: serverCommandId("thread-delete-abort"),
        threadId: thread.id,
        mode,
        createdAt,
      });
      if (outcome.type === "failed") {
        yield* appendDeletionFailureActivity(orchestrationEngine, {
          threadId: thread.id,
          createdAt,
          detail: outcome.detail,
        }).pipe(Effect.asVoid);
      }
    }
  });
});
