import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Metric,
  Option,
  PubSub,
  Queue,
  Schema,
  Stream,
} from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  metricAttributes,
  orchestrationCommandAckDuration,
  orchestrationCommandDuration,
  orchestrationCommandsTotal,
} from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { VisibleBrowserControl } from "../../browser/Services/VisibleBrowserControl.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import { projectEvent } from "../projector.ts";
import { makeLifecycleQueuedPromptFlushCommand } from "../QueuedPromptFlush.logic.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";

export interface CommandEnvelope {
  readonly command: OrchestrationCommand;
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
  readonly commandQueue: Queue.Queue<CommandEnvelope>;
  readonly eventPubSub: PubSub.PubSub<OrchestrationEvent>;
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
        yield* PubSub.publish(input.eventPubSub, persistedEvent);
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
        const existingReceipt = yield* commandReceiptRepository.getByCommandId({
          commandId: envelope.command.commandId,
        });
        if (Option.isSome(existingReceipt)) {
          if (existingReceipt.value.status === "accepted") {
            return { sequence: existingReceipt.value.resultSequence };
          }
          return yield* new OrchestrationCommandPreviouslyRejectedError({
            commandId: envelope.command.commandId,
            detail: existingReceipt.value.error ?? "Previously rejected.",
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
                  error: null,
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
          yield* PubSub.publish(input.eventPubSub, event);
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
        return { sequence: committedCommand.lastSequence };
      }).pipe(Effect.withSpan(`orchestration.command.${envelope.command.type}`)),
    ).pipe(
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isSuccess(exit)
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
            yield* Deferred.succeed(envelope.result, exit.value);
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
              yield* Queue.offer(input.commandQueue, {
                command: flushCommand,
                result,
                startedAtMs: Date.now(),
              });
            }
            return true;
          }
          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
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
              yield* commandReceiptRepository
                .upsert({
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  acceptedAt: new Date().toISOString(),
                  resultSequence: input.readModel().snapshotSequence,
                  status: "rejected",
                  error: error.message,
                })
                .pipe(Effect.catch(() => Effect.void));
            }
          }
          yield* Deferred.fail(envelope.result, error);
          return false;
        }),
      ),
    );
  };
});
