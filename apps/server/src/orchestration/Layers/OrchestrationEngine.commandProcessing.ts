import { recordCommandResultMetrics } from "./OrchestrationEngine.commandMetrics.ts";
import { makeCanonicalCommandCommit } from "./OrchestrationEngine.commit.ts";
import { commandToAggregateRef } from "./OrchestrationEngine.commandAggregate.ts";
import { makeTerminalIdleGuard } from "./OrchestrationEngine.terminalIdle.ts";
import { QueueDecisionReason } from "@bigbud/contracts/orchestration/orchestration.queueDecision.ts";
import type { OrchestrationEvent, OrchestrationReadModel } from "@bigbud/contracts";
import type { CommandEnvelope } from "./OrchestrationEngine.commandEnvelope.ts";
export type { CommandEnvelope } from "./OrchestrationEngine.commandEnvelope.ts";
import { Cause, Deferred, Duration, Effect, Exit, Metric, Option, Schema } from "effect";
import {
  withWorkspaceCommandAdmission,
  commitProjectWorkspaceApplication,
} from "../ProjectWorkspace.engineTransition.ts";
import { reconcileCommittedReadModel } from "./OrchestrationEngine.reconcileReadModel.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { metricAttributes, orchestrationCommandAckDuration } from "../../observability/Metrics.ts";
import {
  orchestrationCommandDigestConflictsTotal,
  orchestrationCommandUnknownOutcomesTotal,
} from "../../observability/Metrics.orchestrationRecovery.ts";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { VisibleBrowserControl } from "../../browser/Services/VisibleBrowserControl.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import {
  OrchestrationCommandIdConflictError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  type OrchestrationDispatchError,
} from "../Errors.ts";
import * as ProjectWorkspace from "../ProjectWorkspace.files.ts";
import { ServerConfig } from "../../startup/config.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { enqueueLifecycleFlush } from "./OrchestrationEngine.lifecycleFlush.ts";
import type { BoundedCommandAdmission } from "../../command-admission/CommandAdmission.ts";
import { persistRejectedCommandReceipt } from "./OrchestrationEngine.rejectionReceipt.ts";

export { commandToAggregateRef } from "./OrchestrationEngine.commandAggregate.ts";

export const makeCommandProcessor = Effect.fn("makeCommandProcessor")(function* (input: {
  readonly commandAdmission: BoundedCommandAdmission<CommandEnvelope>;
  readonly publishDomainEvent: (event: OrchestrationEvent) => Effect.Effect<void>;
  readonly readModel: () => OrchestrationReadModel;
  readonly setReadModel: (readModel: OrchestrationReadModel) => void;
}) {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const visibleBrowser = yield* VisibleBrowserControl;
  const commitCanonicalCommand = yield* makeCanonicalCommandCommit();
  const terminalIdleBlocked = yield* makeTerminalIdleGuard();
  const workspaceConfig = yield* ServerConfig;
  const workspaceTerminal = yield* Effect.serviceOption(TerminalManager);

  return (envelope: CommandEnvelope): Effect.Effect<boolean> => {
    const dispatchStartSequence = input.readModel().snapshotSequence;
    const processingStartedAtMs = Date.now();
    const aggregateRef = commandToAggregateRef(envelope.command);
    const baseMetricAttributes = {
      commandType: envelope.command.type,
      aggregateKind: aggregateRef.aggregateKind,
    } as const;
    const reconcileReadModelAfterDispatchFailure = reconcileCommittedReadModel(
      eventStore,
      dispatchStartSequence,
      input,
    );

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
            ...(Schema.is(QueueDecisionReason)(receiptClaim.receipt.rejectionReason)
              ? { queueReason: receiptClaim.receipt.rejectionReason }
              : {}),
          });
        }
        const currentReadModel = input.readModel();
        const committedCommand = yield* withWorkspaceCommandAdmission(
          sql,
          envelope.command,
          currentReadModel,
          envelope.nativeWorkspaceOperationId,
          (nativeIdentity) =>
            Effect.gen(function* () {
              const eventBase =
                envelope.nativeOrganizationOperation ||
                (envelope.command.type === "thread.organization.move" &&
                  envelope.command.undoAutomaticMoveId) ||
                (yield* terminalIdleBlocked(envelope.command))
                  ? []
                  : yield* decideOrchestrationCommand({
                      command: envelope.command,
                      readModel: currentReadModel,
                    });
              const eventBases = yield* ProjectWorkspace.prepareProjectWorkspaceEvents(
                envelope.command,
                currentReadModel,
                Array.isArray(eventBase) ? eventBase : [eventBase],
                {
                  stateDir: workspaceConfig.stateDir,
                  sql,
                  ...(nativeIdentity
                    ? { nativeWorkspaceOperationId: nativeIdentity.operationId }
                    : {}),
                  ...(Option.isSome(workspaceTerminal)
                    ? { terminal: workspaceTerminal.value }
                    : {}),
                },
              );
              if (envelope.command.type === "thread.queued-prompt.flush" && eventBases.length === 0)
                return yield* new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Queue decision returned no action or refusal.",
                });
              const committedCommand = yield* commitProjectWorkspaceApplication(
                sql,
                nativeIdentity,
                commitCanonicalCommand(envelope, currentReadModel, eventBases),
              ).pipe(
                Effect.catchTag("SqlError", (sqlError) =>
                  Effect.fail(
                    toPersistenceSqlError("OrchestrationEngine.processEnvelope:transaction")(
                      sqlError,
                    ),
                  ),
                ),
                Effect.mapError(
                  ProjectWorkspace.projectWorkspacePersistenceError(
                    envelope.command,
                    currentReadModel,
                  ),
                ),
              );
              input.setReadModel(committedCommand.nextReadModel);
              return committedCommand;
            }),
        );
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
          yield* recordCommandResultMetrics(exit, baseMetricAttributes, processingStartedAtMs);
          if (Exit.isSuccess(exit)) {
            const dispatchResult = exit.value.dispatchResult;
            if (dispatchResult === undefined) {
              yield* Deferred.fail(
                envelope.result,
                new OrchestrationCommandInvariantError({
                  commandType: envelope.command.type,
                  detail: "Command completed without a dispatch result.",
                }),
              );
              return false;
            }
            yield* Deferred.succeed<{ sequence: number }, OrchestrationDispatchError>(
              envelope.result,
              dispatchResult,
            );
            yield* enqueueLifecycleFlush(
              input.commandAdmission,
              envelope.command,
              input.readModel(),
            );
            return true;
          }
          const error = Cause.squash(exit.cause) as OrchestrationDispatchError;
          if (
            Schema.is(OrchestrationCommandInvariantError)(error) &&
            Schema.is(QueueDecisionReason)(error.code)
          ) {
            yield* Effect.logInfo("Queue attempt not applied", {
              commandId: envelope.command.commandId,
              aggregateId: aggregateRef.aggregateId,
              reason: error.code,
              revision: input.readModel().snapshotSequence,
            });
          }
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
            if (
              Schema.is(OrchestrationCommandInvariantError)(error) &&
              !envelope.nativeWorkspaceOperationId &&
              // Internal ownership envelopes may be refreshed without changing the retained payload.
              // Keep the durable digest claim, but do not poison persistence with a rejected receipt.
              !envelope.metadataCommit
            ) {
              const persisted = yield* Effect.exit(
                persistRejectedCommandReceipt({
                  receipts: commandReceiptRepository,
                  commandId: envelope.command.commandId,
                  aggregateKind: aggregateRef.aggregateKind,
                  aggregateId: aggregateRef.aggregateId,
                  resultSequence: input.readModel().snapshotSequence,
                  rejectionReason:
                    error.code === "thread_already_exists" ||
                    Schema.is(QueueDecisionReason)(error.code)
                      ? error.code
                      : "other",
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
