/**
 * ProjectionPipeline — thin shell Layer wiring.
 *
 * Exports `ORCHESTRATION_PROJECTOR_NAMES` (consumed by projectors.ts) and
 * `OrchestrationProjectionPipelineLive` (the composed Effect Layer).
 *
 * @module ProjectionPipeline
 */
import { type OrchestrationEvent } from "@bigbud/contracts";
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { isPersistenceError, toPersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionBaselineRepository } from "../../persistence/Services/ProjectionBaselines.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionPendingUserInputRepository } from "../../persistence/Services/ProjectionPendingUserInputs.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadTaskRepository } from "../../persistence/Services/ProjectionThreadTasks.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepository } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionBaselineRepositoryLive } from "../../persistence/Layers/ProjectionBaselines.ts";
import { ProjectionPendingUserInputRepositoryLive } from "../../persistence/Layers/ProjectionPendingUserInputs.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadTaskRepositoryLive } from "../../persistence/Layers/ProjectionThreadTasks.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ServerConfig } from "../../startup/config.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  runAttachmentSideEffects,
  type AttachmentSideEffects,
  ORCHESTRATION_PROJECTOR_NAMES,
} from "./ProjectionPipeline.helpers.ts";
import { makeProjectors, type ProjectorDefinition } from "./ProjectionPipeline.projectors.ts";
import { runUsageContributionBackfill } from "./ProjectionPipeline.usageBackfill.ts";
import { makeProjectionBaselineOperations } from "./ProjectionPipeline.baseline.ts";
import { increment, threadRetentionCompactionRows } from "../../observability/Metrics.ts";
import {
  makeProjectionBaselineCoordinator,
  PROJECTION_BASELINE_FAILURE_COOLDOWN_MS,
} from "./ProjectionPipeline.baseline.coordination.ts";
import { verifyCandidateInWorkspace } from "./ProjectionPipeline.baseline.workspace.ts";
import { writeStartupStatus } from "../../startup/startupStatus.ts";

export { ORCHESTRATION_PROJECTOR_NAMES };

export { PROJECTION_BASELINE_FAILURE_COOLDOWN_MS };

const makeOrchestrationProjectionPipeline = Effect.fn("makeOrchestrationProjectionPipeline")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* OrchestrationEventStore;
    const projectionStateRepository = yield* ProjectionStateRepository;
    const projectionProjectRepository = yield* ProjectionProjectRepository;
    const projectionThreadRepository = yield* ProjectionThreadRepository;
    const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
    const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
    const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
    const projectionThreadTaskRepository = yield* ProjectionThreadTaskRepository;
    const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;
    const projectionPendingUserInputRepository = yield* ProjectionPendingUserInputRepository;
    const projectionBaselineRepository = yield* ProjectionBaselineRepository;

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

    const projectors: ReadonlyArray<ProjectorDefinition> = makeProjectors({
      findThreadProjectId: eventStore.findThreadProjectId,
      projectionProjectRepository,
      projectionThreadRepository,
      projectionThreadMessageRepository,
      projectionThreadProposedPlanRepository,
      projectionThreadActivityRepository,
      projectionThreadTaskRepository,
      projectionThreadSessionRepository,
      projectionTurnRepository,
      projectionPendingApprovalRepository,
      projectionPendingUserInputRepository,
    });

    const runProjectorForEvent = Effect.fn("runProjectorForEvent")(function* (
      projector: ProjectorDefinition,
      event: OrchestrationEvent,
      runSideEffects = true,
    ) {
      const attachmentSideEffects: AttachmentSideEffects = {
        prunedThreadRelativePaths: new Map<string, Set<string>>(),
      };

      yield* sql.withTransaction(
        projector.apply(event, attachmentSideEffects).pipe(
          Effect.flatMap(() =>
            projectionStateRepository.upsert({
              projector: projector.name,
              lastAppliedSequence: event.sequence,
              updatedAt: event.occurredAt,
            }),
          ),
        ),
      );

      if (!runSideEffects) return;
      yield* runAttachmentSideEffects(attachmentSideEffects).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to apply projected attachment side-effects", {
            projector: projector.name,
            sequence: event.sequence,
            eventType: event.type,
            cause,
          }),
        ),
      );
    });

    const projectorNames = Object.values(ORCHESTRATION_PROJECTOR_NAMES);
    const baselineOperations = makeProjectionBaselineOperations({
      eventStore,
      baselines: projectionBaselineRepository,
      projectorNames,
      verifyCandidate: (candidate, source) =>
        verifyCandidateInWorkspace({
          candidate,
          source,
          eventStore,
          projectorNames,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ServerConfig, serverConfig),
          Effect.mapError((error) =>
            isPersistenceError(error)
              ? error
              : toPersistenceSqlError("ProjectionPipeline.verify:workspace")(error),
          ),
        ),
    });
    const ensureVerifiedBaselineThrough = yield* makeProjectionBaselineCoordinator({
      baselines: projectionBaselineRepository,
      compact: baselineOperations.compact(),
    });
    const ensureVerifiedBaselineThroughWithoutCompaction = yield* makeProjectionBaselineCoordinator(
      {
        baselines: projectionBaselineRepository,
        compact: baselineOperations.verifyThrough(),
      },
    );

    const bootstrapProjector = (projector: ProjectorDefinition) =>
      projectionStateRepository
        .getByProjector({
          projector: projector.name,
        })
        .pipe(
          Effect.flatMap((stateRow) =>
            Stream.runForEach(
              eventStore.readFromSequence(
                Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
                Number.MAX_SAFE_INTEGER,
              ),
              (event) => runProjectorForEvent(projector, event),
            ),
          ),
        );

    const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = (event) =>
      Effect.forEach(projectors, (projector) => runProjectorForEvent(projector, event), {
        concurrency: 1,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig, serverConfig),
        Effect.asVoid,
        Effect.catchTag("SqlError", (sqlError) =>
          Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
        ),
      );

    const restoreBaselineForRetainedGap = Effect.gen(function* () {
      const states = yield* projectionStateRepository.listAll();
      const stateNames = new Set(states.map((state) => state.projector));
      const hasEveryRequiredCursor = projectorNames.every((projector) => stateNames.has(projector));
      const cursor =
        states.length === 0 || !hasEveryRequiredCursor
          ? 0
          : Math.min(...states.map((state) => state.lastAppliedSequence));
      const replay = yield* eventStore.readReplay(cursor, 0);
      if (replay.availability !== "gap") return;
      const baseline = yield* projectionBaselineRepository.latestVerified();
      if (
        Option.isNone(baseline) ||
        baseline.value.sequence < replay.retainedFromSequenceExclusive
      ) {
        return yield* toPersistenceSqlError("ProjectionPipeline.bootstrap:retainedGap")(
          new Error(
            `no verified baseline covers retained sequence ${replay.retainedFromSequenceExclusive}`,
          ),
        );
      }
      yield* projectionBaselineRepository.restorePayload(
        baseline.value.payloadJson,
        baseline.value.sequence,
        projectorNames,
      );
    });

    const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.andThen(
      restoreBaselineForRetainedGap,
      Effect.gen(function* () {
        const cursor = yield* projectionStateRepository.minLastAppliedSequence();
        const replay = yield* eventStore.readReplay(cursor ?? 0, 1);
        if (replay.events.length > 0) {
          yield* Effect.sync(() => writeStartupStatus("upgrading"));
        }
        yield* Effect.forEach(projectors, bootstrapProjector, { concurrency: 1 });
        yield* Effect.sync(() => writeStartupStatus("starting"));
      }),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.tap(() =>
        Effect.logDebug("orchestration projection pipeline bootstrapped").pipe(
          Effect.annotateLogs({ projectors: projectors.length }),
        ),
      ),
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
      ),
      Effect.tapError(() =>
        Effect.sync(() => writeStartupStatus("error", "projection_database_initialization_failed")),
      ),
    );

    const backfillUsageContributions: OrchestrationProjectionPipelineShape["backfillUsageContributions"] =
      runUsageContributionBackfill({
        repository: projectionThreadActivityRepository,
      });

    const compactVerifiedPrefix = (batchSize?: number) =>
      eventStore.compactVerifiedPrefix
        ? eventStore.compactVerifiedPrefix(batchSize).pipe(
            Effect.tap((result) =>
              increment(threadRetentionCompactionRows, {}, result.deletedCount),
            ),
            Effect.asVoid,
          )
        : Effect.void;

    return {
      bootstrap,
      backfillUsageContributions,
      ensureVerifiedBaselineThrough,
      ensureVerifiedBaselineThroughWithoutCompaction,
      compactVerifiedPrefix,
      projectEvent,
    } satisfies OrchestrationProjectionPipelineShape;
  },
);

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline(),
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadTaskRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionPendingUserInputRepositoryLive),
  Layer.provideMerge(ProjectionBaselineRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
);
