import type { OrchestrationEvent, OrchestrationReadModel } from "@bigbud/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { persistWorktreeRuntimeCwd } from "../../git/Layers/WorktreeRuntimeCwd.ts";
import { makeThreadOrganizationOperations } from "../../persistence/Layers/ThreadOrganizationOperations.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { makeOrganizationAcceptance } from "../../thread-organization/organizationAcceptance.ts";
import { recordOrganizationRuntimeEvent } from "../../thread-organization/organizationFacts.events.ts";
import { makeOrganizationUndo } from "../../thread-organization/organizationUndo.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { projectEvent } from "../projector.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { commandToAggregateRef } from "./OrchestrationEngine.commandAggregate.ts";
import type { CommandEnvelope } from "./OrchestrationEngine.commandEnvelope.ts";
import { recordAppendedEventMetrics } from "./OrchestrationEngine.commandMetrics.ts";
import { makeMetadataCommitHooks } from "./OrchestrationEngine.metadataGeneration.ts";
import { makeRecoveryIntentRecorder } from "./OrchestrationEngine.recoveryIntents.ts";

/** Called inside the workspace/canonical SQL transaction; never installs or publishes state. */
export const makeCanonicalCommandCommit = Effect.fn("makeCanonicalCommandCommit")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const projections = yield* OrchestrationProjectionPipeline;
  const retentionRepository = yield* Effect.serviceOption(ThreadRetentionRepository);
  const recordRecoveryIntent = yield* makeRecoveryIntentRecorder;
  const metadata = yield* makeMetadataCommitHooks();
  const undoOrganization = yield* makeOrganizationUndo;
  const acceptOrganization = yield* makeOrganizationAcceptance;
  const organizationOperations = yield* makeThreadOrganizationOperations;
  const settings = yield* ServerSettingsService;

  return Effect.fn("canonicalCommandCommit")(function* (
    envelope: CommandEnvelope,
    currentReadModel: OrchestrationReadModel,
    eventBases: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
  ) {
    const aggregateRef = commandToAggregateRef(envelope.command);
    const metadataCommit = yield* metadata.authorize(
      envelope.command,
      envelope.metadataCommit,
      currentReadModel,
    );
    const retentionClaim =
      envelope.command.type === "thread.retention-delete"
        ? Option.isSome(retentionRepository)
          ? yield* retentionRepository.value.recheckAndClaimItem({
              runId: envelope.command.runId,
              threadId: envelope.command.threadId,
              expectedLastActivityAt: envelope.command.expectedLastActivityAt,
              cutoffAt: envelope.command.cutoffAt,
              claimedAt: envelope.command.createdAt,
            })
          : yield* Effect.die("ThreadRetentionRepository is unavailable")
        : null;
    const committedEvents: OrchestrationEvent[] = [];
    let nextReadModel = currentReadModel;
    const acceptedEvents = envelope.nativeOrganizationOperation
      ? yield* acceptOrganization(envelope.command, envelope.nativeOrganizationOperation)
      : envelope.command.type === "thread.organization.move" && envelope.command.undoAutomaticMoveId
        ? yield* undoOrganization(envelope.command)
        : eventBases;
    const events =
      retentionClaim?.claimed === false || metadataCommit?.apply === false ? [] : acceptedEvents;
    for (const nextEvent of events) {
      const savedEvent = yield* eventStore.append(nextEvent);
      yield* recordAppendedEventMetrics(savedEvent);
      nextReadModel = yield* projectEvent(nextReadModel, savedEvent);
      yield* projections.projectEvent(savedEvent);
      yield* recordOrganizationRuntimeEvent(
        sql,
        savedEvent,
        (yield* settings.getSettings).inyosiraGraceMinutes * 60000,
      );
      yield* recordRecoveryIntent(savedEvent, envelope.command);
      yield* persistWorktreeRuntimeCwd(sql, savedEvent);
      yield* metadata.record(savedEvent);
      committedEvents.push(savedEvent);
    }
    if (metadataCommit) yield* metadataCommit.settle;
    const lastSavedEvent = committedEvents.at(-1) ?? null;
    if (
      envelope.nativeOrganizationOperation &&
      lastSavedEvent?.type === "thread.organization-updated"
    ) {
      yield* organizationOperations.settle(envelope.nativeOrganizationOperation.operationId, {
        status: "applied",
        resultRevision: lastSavedEvent.payload.organization.revision,
        resultSequence: lastSavedEvent.sequence,
      });
    }
    yield* receipts.upsert({
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
    return {
      committedEvents,
      lastSequence: lastSavedEvent?.sequence ?? currentReadModel.snapshotSequence,
      nextReadModel,
    } as const;
  });
});
