import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import { Cause, Deferred, Duration, Effect, Exit, Metric, Option, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandDuration,
  orchestrationCommandsTotal,
} from "../../observability/Metrics.ts";
import {
  orchestrationCommandDigestConflictsTotal,
  orchestrationCommandUnknownOutcomesTotal,
} from "../../observability/Metrics.orchestrationRecovery.ts";
import {
  orchestrationEventPayloadBytes,
  orchestrationEventsAppendedTotal,
} from "../../observability/Metrics.load.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { VisibleBrowserControl } from "../../browser/Services/VisibleBrowserControl.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import {
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import { projectEvent } from "../projector.ts";
import { makeLifecycleQueuedPromptFlushCommand } from "../QueuedPromptFlush.logic.ts";
import type { BoundedCommandAdmission } from "../../command-admission/CommandAdmission.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { persistRejectedCommandReceipt } from "./OrchestrationEngine.rejectionReceipt.ts";
import {
  calculateCommandPayloadDigest,
  type OrchestrationCommandPayloadDigest,
} from "../commandDigest.ts";

const eventPayloadEncoder = new TextEncoder();

export interface CommandEnvelope {
  readonly command: OrchestrationCommand;
  readonly payloadDigest: OrchestrationCommandPayloadDigest;
  readonly result: Deferred.Deferred<{ sequence: number }, OrchestrationDispatchError>;
  readonly startedAtMs: number;
}

export function commandToAggregateRef(command: OrchestrationCommand): {
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: ProjectId | ThreadId;
} {
  switch (command.type) {
    case "project.create":
    case "project.meta.update":
    case "project.reconfigure":
    case "project.delete":
    case "project.delete.finalize":
    case "project.delete.abort":
      return { aggregateKind: "project", aggregateId: command.projectId };
    default:
      return { aggregateKind: "thread", aggregateId: command.threadId };
  }
}

export const makeCommandProcessor = Effect.fn("makeCommandProcessor")(function* (input: {
  readonly commandAdmission: BoundedCommandAdmission<CommandEnvelope>;
  readonly publishDomainEvent: (event: OrchestrationEvent) => Effect.Effect<void>;
  readonly readModel: () => OrchestrationReadModel;
  readonly setReadModel: (readModel: OrchestrationReadModel) => void;
}) {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const projectionPipeline = yield* OrchestrationProjectionPipeline;
  const retentionRepository = yield* Effect.serviceOption(ThreadRetentionRepository);
  const visibleBrowser = yield* VisibleBrowserControl;

  return (envelope: CommandEnvelope): Effect.Effect<boolean> => {
    const dispatchStartSequence = input.readModel().snapshotSequence;
    const processingStartedAtMs = Date.now();
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = Effect.gen(function* () {
      const persistedEvents = yield* Stream.runCollect(
        eventStore.readFromSequence(dispatchStartSequence),
      ).pipe(Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)));
      if (persistedEvents.length === 0) return;
      let nextReadModel = input.readModel();
      for (const persistedEvent of persistedEvents) {
        nextReadModel = yield* projectEvent(nextReadModel, persistedEvent);
      }
      input.setReadModel(nextReadModel);
      for (const persistedEvent of persistedEvents) {
        yield* input.publishDomainEvent(persistedEvent);
      }
    });

    return Effect.exit(
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan({
          "orchestration.command_id": envelope.command.commandId,
          "orchestration.command_type": envelope.command.type,
          "orchestration.aggregate_kind": aggregateRef.aggregateKind,
          "orchestration.aggregate_id": aggregateRef.aggregateId,
        });
        const receiptClaim = yield* commandReceiptRepository.claimOrInspect({
          commandId: envelope.command.commandId,
          payloadDigestVersion: envelope.payloadDigest.version,
          payloadDigest: envelope.payloadDigest.digest,
          claimedAt: new Date().toISOString(),
        });
        if (receiptClaim.status === "conflict") {
          yield* Metric.update(orchestrationCommandDigestConflictsTotal, 1);
          return yield* new OrchestrationCommandIdConflictError({
            commandId: envelope.command.commandId,
            payloadDigestVersion: envelope.payloadDigest.version,
            payloadDigest: envelope.payloadDigest.digest,
            storedPayloadDigestVersion: receiptClaim.storedPayloadDigestVersion,
            storedPayloadDigest: receiptClaim.storedPayloadDigest,
          });
        }
        if (receiptClaim.status === "existing") {
          if (receiptClaim.receipt.status === "accepted") {
            return {
              dispatchResult: { sequence: receiptClaim.receipt.resultSequence },
              committedEventCount: 1,
            };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: receiptClaim.receipt.error ?? "Previously rejected.",
          });
        }
        const currentReadModel = input.readModel();
        const eventBase = yield* decideOrchestrationCommand({
          command: envelope.command,
          readModel: currentReadModel,
        });
        const eventBases = Array.isArray(eventBase) ? eventBase : [eventBase];
        const committedCommand = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const retentionClaim =
                envelope.command.type === "thread.retention-delete" &&
                Option.isSome(retentionRepository)
                  ? yield* retentionRepository.value.recheckAndClaimItem({
                      runId: envelope.command.runId,
                      threadId: envelope.command.threadId,
                      expectedLastActivityAt: envelope.command.expectedLastActivityAt,
                      cutoffAt: envelope.command.cutoffAt,
                      claimedAt: envelope.command.createdAt,
                    })
                  : envelope.command.type === "thread.retention-delete"
                    ? yield* Effect.die("ThreadRetentionRepository is unavailable")
                    : null;
              const committedEvents: OrchestrationEvent[] = [];
              let nextReadModel = currentReadModel;
              for (const nextEvent of retentionClaim?.claimed === false ? [] : eventBases) {
                const savedEvent = yield* eventStore.append(nextEvent);
                const eventAttributes = metricAttributes({ eventType: savedEvent.type });
                yield* Metric.update(
                  Metric.withAttributes(orchestrationEventsAppendedTotal, eventAttributes),
                  1,
                );
                yield* Metric.update(
                  Metric.withAttributes(orchestrationEventPayloadBytes, eventAttributes),
                  eventPayloadEncoder.encode(JSON.stringify(savedEvent.payload)).byteLength,
                );
                nextReadModel = yield* projectEvent(nextReadModel, savedEvent);
                yield* projectionPipeline.projectEvent(savedEvent);
                committedEvents.push(savedEvent);
              }
              const lastSavedEvent = committedEvents.at(-1) ?? null;
              // A lifecycle flush can race with a new turn between command
              // creation and processing. An empty decision is retryable, not
              // successful work; receipt-caching it would poison the stable
              // flush command ID forever.
              if (
                envelope.command.type !== "thread.queued-prompt.flush" ||
                committedEvents.length > 0
              ) {
                yield* commandReceiptRepository.upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: lastSavedEvent?.aggregateKind ?? aggregateRef.aggregateKind,
                  aggregateId: lastSavedEvent?.aggregateId ?? aggregateRef.aggregateId,
                  acceptedAt: lastSavedEvent?.occurredAt ?? new Date().toISOString(),
                  resultSequence: lastSavedEvent?.sequence ?? currentReadModel.snapshotSequence,
                  status: "accepted",
                  rejectionReason: null,
                  error: null,
                  payloadDigestVersion: envelope.payloadDigest.version,
                  payloadDigest: envelope.payloadDigest.digest,
                });
              }
              return {
                committedEvents,
                lastSequence: lastSavedEvent?.sequence ?? currentReadModel.snapshotSequence,
                nextReadModel,
              } as const;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (sqlError) =>
              Effect.fail(
                toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(sqlError),
              ),
            ),
          );
        input.setReadModel(committedCommand.nextReadModel);
        if (aggregateRef.aggregateKind === "thread") {
          const thread = committedCommand.nextReadModel.threads.find(
            (candidate) => candidate.id === aggregateRef.aggregateId,
          );
          if (thread) {
            yield* visibleBrowser.reconcileThread({
              threadId: thread.id,
              activeTurnId: thread.session?.activeTurnId ?? null,
              isRunning: thread.session?.status === "running",
            });
          }
        }
        for (const [index, event] of committedCommand.committedEvents.entries()) {
          yield* input.publishDomainEvent(event);
          if (index === 0) {
            yield* Metric.update(
              Metric.withAttributes(
                orchestrationCommandAckDuration,
                metricAttributes({ ...baseMetricAttributes, ackEventType: event.type }),
              ),
              Duration.millis(Math.max(0, Date.now() - envelope.startedAtMs)),
            );
          }
        }
        return {
          dispatchResult: { sequence: committedCommand.lastSequence },
          committedEventCount: committedCommand.committedEvents.length,
        };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const staleFlush =
            Exit.isSuccess(exit) &&
            envelope.command.type === "thread.queued-prompt.flush" &&
            exit.value.committedEventCount === 0;
          const outcome = staleFlush
            ? "failure"
            : Exit.isSuccess(exit)
              ? "success"
              : Cause.hasInterruptsOnly(exit.cause)
                ? "interrupt"
                : "failure";
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandDuration,
              metricAttributes(baseMetricAttributes),
            ),
            Duration.millis(Math.max(0, Date.now() - processingStartedAtMs)),
          );
          yield* Metric.update(
            Metric.withAttributes(
              orchestrationCommandsTotal,
              metricAttributes({ ...baseMetricAttributes, outcome }),
            ),
            1,
          );
          if (Exit.isSuccess(exit)) {
            const dispatchResult = exit.value.dispatchResult;
            if (staleFlush || dispatchResult === undefined) {
              // A stale lifecycle flush is retryable. It must remain unknown
              // instead of being reported as committed without a receipt.
              yield* Deferred.fail(
                envelope.result,
                new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: staleFlush
                    ? "Queued prompt flush produced no canonical event."
                    : "Command completed without a dispatch result.",
                }),
              );
              return false;
            }
            yield* Deferred.succeed<{ sequence: number }, OrchestrationDispatchError>(
              envelope.result,
              dispatchResult,
            );
            const flushCommand = makeLifecycleQueuedPromptFlushCommand({
              trigger: envelope.command,
              readModel: input.readModel(),
              createdAt: new Date().toISOString(),
            });
            if (flushCommand) {
              const result = yield* Deferred.make<
                { sequence: number },
                OrchestrationDispatchError
              >();
              yield* input.commandAdmission
                .offer(
                  {
                    command: flushCommand,
                    result,
                    startedAtMs: Date.now(),
                    payloadDigest: calculateCommandPayloadDigest(flushCommand),
                  },
                  "internal",
                )
                .pipe(
                  Effect.catchTag("CommandAdmissionError", (error) =>
                    Effect.logError("failed to enqueue lifecycle command", {
                      queue: error.queue,
                      code: error.code,
                    }),
                  ),
                );
            }
            return true;
          }
          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          let reportedError = error;
          let acceptedRaceSequence: number | null = null;
          if (!Schema.is(OrchestrationCommandPreviouslyRejectedError)(error)) {
            yield* reconcileReadModelAfterDispatchFailure.pipe(
              Effect.catch(() =>
                Effect.logWarning(
                  "failed to reconcile orchestration read model after dispatch failure",
                ).pipe(
                  Effect.annotateLogs({
                    commandId: envelope.command.commandId,
                    snapshotSequence: input.readModel().snapshotSequence,
                  }),
                ),
              ),
            );
            if (Schema.is(OrchestrationCommandInvariantError)(error)) {
              const persisted = yield* Effect.exit(
                persistRejectedCommandReceipt({
                  receipts: commandReceiptRepository,
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  resultSequence: input.readModel().snapshotSequence,
                  rejectionReason:
                    error.code === "thread_already_exists" ? "thread_already_exists" : "other",
                  error: error.message,
                  payloadDigestVersion: envelope.payloadDigest.version,
                  payloadDigest: envelope.payloadDigest.digest,
                }),
              );
              if (Exit.isFailure(persisted)) {
                reportedError = Cause.squash(persisted.cause) as OrchestrationDispatchError;
              } else if (persisted.value.status === "accepted") {
                acceptedRaceSequence = persisted.value.sequence;
              }
            }
          }
          if (acceptedRaceSequence !== null) {
            yield* Deferred.succeed(envelope.result, { sequence: acceptedRaceSequence });
            return true;
          }
          if (
            !Schema.is(OrchestrationCommandInvariantError)(reportedError) &&
            !Schema.is(OrchestrationCommandPreviouslyRejectedError)(reportedError) &&
            !Schema.is(OrchestrationCommandIdConflictError)(reportedError)
          ) {
            yield* Metric.update(orchestrationCommandUnknownOutcomesTotal, 1);
          }
          yield* Deferred.fail(envelope.result, reportedError);
          return false;
        }),
      ),
    );
  };
});
