import { Cause, Clock, Effect, Exit, FileSystem, Layer, Option, Path, Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError, toPersistenceDecodeCauseError } from "../../persistence/Errors.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionBaselineRepositoryLive } from "../../persistence/Layers/ProjectionBaselines.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionPendingUserInputRepositoryLive } from "../../persistence/Layers/ProjectionPendingUserInputs.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionThreadTaskRepositoryLive } from "../../persistence/Layers/ProjectionThreadTasks.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { type OrchestrationEventStoreShape } from "../../persistence/Services/OrchestrationEventStore.ts";
import {
  copyBaselinePayloadRows,
  emptyBaselinePayloadSource,
  storedBaselinePayloadSource,
} from "../../persistence/ProjectionBaselineRows.ts";
import {
  ProjectionBaselineRepository,
  type BaselinePayloadSource,
  type ProjectionBaseline,
} from "../../persistence/Services/ProjectionBaselines.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionPendingUserInputRepository } from "../../persistence/Services/ProjectionPendingUserInputs.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepository } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThreadTaskRepository } from "../../persistence/Services/ProjectionThreadTasks.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ServerConfig } from "../../startup/config.ts";
import { type ProjectorDefinition, makeProjectors } from "./ProjectionPipeline.projectors.ts";
import { type AttachmentSideEffects } from "./ProjectionPipeline.helpers.ts";
import {
  ProjectionBaselineWorkspaceSchemaError,
  validateProjectionBaselineWorkspace,
} from "./ProjectionPipeline.baseline.workspace.schema.ts";

const REPLAY_PAGE_SIZE = 250;

const workspaceLayer = Layer.mergeAll(
  ProjectionBaselineRepositoryLive,
  ProjectionPendingApprovalRepositoryLive,
  ProjectionPendingUserInputRepositoryLive,
  ProjectionProjectRepositoryLive,
  ProjectionStateRepositoryLive,
  ProjectionThreadActivityRepositoryLive,
  ProjectionThreadMessageRepositoryLive,
  ProjectionThreadProposedPlanRepositoryLive,
  ProjectionThreadRepositoryLive,
  ProjectionThreadSessionRepositoryLive,
  ProjectionThreadTaskRepositoryLive,
  ProjectionTurnRepositoryLive,
);

type WorkspaceMeta = {
  readonly candidateId: number;
  readonly candidateHash: string;
  readonly candidateSequence: number;
  readonly sourceSequence: number;
  readonly cursor: number;
};

const cleanupWorkspaceArtifacts = (input: {
  readonly fs: FileSystem.FileSystem;
  readonly workspacePath: string;
  readonly workspaceId: string;
}) =>
  Effect.forEach(
    [
      ["database", input.workspacePath],
      ["wal", `${input.workspacePath}-wal`],
      ["shm", `${input.workspacePath}-shm`],
      ["journal", `${input.workspacePath}-journal`],
    ] as const,
    ([artifact, artifactPath]) =>
      Effect.exit(input.fs.remove(artifactPath, { force: true })).pipe(
        Effect.flatMap((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.logWarning("projection baseline workspace cleanup failed", {
                workspaceId: input.workspaceId,
                artifact,
                outcome: "failed",
              }),
        ),
      ),
    { concurrency: 1, discard: true },
  );

export const verifyCandidateInWorkspace = (input: {
  readonly candidate: ProjectionBaseline;
  readonly source: Option.Option<ProjectionBaseline>;
  /** Reads the source baseline's rows from the live database, page by page. */
  readonly readSource: (baseline: ProjectionBaseline) => BaselinePayloadSource;
  readonly eventStore: OrchestrationEventStoreShape;
  readonly projectorNames: ReadonlyArray<string>;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig;
      const workspaceDirectory = path.join(config.stateDir, "projection-baseline-verification");
      const workspacePath = path.join(workspaceDirectory, `${input.candidate.baselineId}.sqlite`);
      yield* fs.makeDirectory(workspaceDirectory, { recursive: true });

      const runAttempt = Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        let resumable = false;
        const result = yield* Effect.acquireUseRelease(
          Scope.make("sequential"),
          (workspaceScope) =>
            Effect.gen(function* () {
              const persistence = makeSqlitePersistenceLive(workspacePath);
              const context = yield* Layer.build(
                workspaceLayer.pipe(Layer.provideMerge(persistence)),
              ).pipe(
                Scope.provide(workspaceScope),
                Effect.mapError(
                  () =>
                    new ProjectionBaselineWorkspaceSchemaError({
                      workspaceId: String(input.candidate.baselineId),
                      stage: "workspace initialization",
                      migrationId: null,
                      missingMigrations: [],
                      missingTables: [],
                    }),
                ),
              );
              const workspaceSql = yield* Effect.service(SqlClient.SqlClient).pipe(
                Effect.provide(context),
              );
              yield* validateProjectionBaselineWorkspace({
                sql: workspaceSql,
                workspaceId: String(input.candidate.baselineId),
              });
              const operationalGuards = yield* workspaceSql<{ readonly name: string }>`
                SELECT name FROM sqlite_master
                WHERE type = 'trigger' AND name LIKE 'thread_retention_guard_%'
                ORDER BY name
              `;
              for (const guard of operationalGuards) {
                yield* workspaceSql.unsafe(`DROP TRIGGER "${guard.name}"`);
              }
              yield* Effect.logDebug("projection baseline workspace schema ready", {
                candidateId: input.candidate.baselineId,
                sequence: input.candidate.sequence,
                workspaceId: String(input.candidate.baselineId),
              });

              const baselines = yield* Effect.service(ProjectionBaselineRepository).pipe(
                Effect.provide(context),
              );
              const state = yield* Effect.service(ProjectionStateRepository).pipe(
                Effect.provide(context),
              );
              const projectors = yield* Effect.gen(function* () {
                return makeProjectors({
                  findThreadProjectId: input.eventStore.findThreadProjectId,
                  projectionProjectRepository: yield* ProjectionProjectRepository,
                  projectionThreadRepository: yield* ProjectionThreadRepository,
                  projectionThreadMessageRepository: yield* ProjectionThreadMessageRepository,
                  projectionThreadProposedPlanRepository:
                    yield* ProjectionThreadProposedPlanRepository,
                  projectionThreadActivityRepository: yield* ProjectionThreadActivityRepository,
                  projectionThreadTaskRepository: yield* ProjectionThreadTaskRepository,
                  projectionThreadSessionRepository: yield* ProjectionThreadSessionRepository,
                  projectionTurnRepository: yield* ProjectionTurnRepository,
                  projectionPendingApprovalRepository: yield* ProjectionPendingApprovalRepository,
                  projectionPendingUserInputRepository: yield* ProjectionPendingUserInputRepository,
                });
              }).pipe(Effect.provide(context));

              yield* workspaceSql`
                CREATE TABLE IF NOT EXISTS projection_baseline_verification (
                  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
                  candidate_id INTEGER NOT NULL,
                  candidate_hash TEXT NOT NULL,
                  candidate_sequence INTEGER NOT NULL,
                  source_sequence INTEGER NOT NULL,
                  cursor INTEGER NOT NULL
                )
              `;
              const metadataRows = yield* workspaceSql<WorkspaceMeta>`
                SELECT candidate_id AS "candidateId", candidate_hash AS "candidateHash",
                  candidate_sequence AS "candidateSequence", source_sequence AS "sourceSequence", cursor
                FROM projection_baseline_verification WHERE singleton_id = 1
              `;
              const sourceSequence = Option.match(input.source, {
                onNone: () => 0,
                onSome: (baseline) => baseline.sequence,
              });
              const metadata = metadataRows[0];
              let cursor: number;
              if (
                metadata === undefined ||
                metadata.candidateId !== input.candidate.baselineId ||
                metadata.candidateHash !== input.candidate.payloadHash ||
                metadata.candidateSequence !== input.candidate.sequence ||
                metadata.sourceSequence !== sourceSequence
              ) {
                // Copy the source rows in before the transaction: reads issued inside a
                // workspace transaction would run against the workspace, not the live database.
                const sourcePayload = yield* Option.match(input.source, {
                  onNone: () => Effect.succeed(emptyBaselinePayloadSource),
                  onSome: (baseline) =>
                    copyBaselinePayloadRows(
                      input.readSource(baseline),
                      workspaceSql,
                      baseline.baselineId,
                    ).pipe(
                      Effect.as(
                        storedBaselinePayloadSource(
                          workspaceSql,
                          baseline.baselineId,
                          baseline.payloadHash,
                        ),
                      ),
                    ),
                });
                yield* workspaceSql.withTransaction(
                  Effect.gen(function* () {
                    yield* baselines.restorePayload(
                      sourcePayload,
                      sourceSequence,
                      input.projectorNames,
                    );
                    yield* workspaceSql`DELETE FROM projection_baseline_verification`;
                    yield* workspaceSql`
                      INSERT INTO projection_baseline_verification (
                        singleton_id, candidate_id, candidate_hash, candidate_sequence, source_sequence, cursor
                      ) VALUES (1, ${input.candidate.baselineId}, ${input.candidate.payloadHash},
                        ${input.candidate.sequence}, ${sourceSequence}, ${sourceSequence})
                    `;
                  }),
                );
                cursor = sourceSequence;
              } else {
                cursor = metadata.cursor;
              }
              resumable = true;

              const sideEffects: AttachmentSideEffects = { prunedThreadRelativePaths: new Map() };
              const replayPage = (
                events: ReadonlyArray<import("@bigbud/contracts").OrchestrationEvent>,
              ) =>
                workspaceSql.withTransaction(
                  Effect.forEach(
                    events,
                    (event) =>
                      Effect.forEach(
                        projectors,
                        (projector: ProjectorDefinition) => projector.apply(event, sideEffects),
                        { concurrency: 1, discard: true },
                      ).pipe(
                        Effect.andThen(
                          Effect.forEach(
                            input.projectorNames,
                            (projector) =>
                              state.upsert({
                                projector,
                                lastAppliedSequence: event.sequence,
                                updatedAt: event.occurredAt,
                              }),
                            { concurrency: 1, discard: true },
                          ),
                        ),
                      ),
                    { concurrency: 1, discard: true },
                  ).pipe(
                    Effect.andThen(
                      () =>
                        workspaceSql`
                          UPDATE projection_baseline_verification
                          SET cursor = ${events.at(-1)?.sequence ?? cursor}
                          WHERE singleton_id = 1
                        `,
                    ),
                  ),
                );

              while (cursor < input.candidate.sequence) {
                const replay = yield* input.eventStore.readReplay(cursor, REPLAY_PAGE_SIZE);
                if (replay.availability === "gap") {
                  return yield* toPersistenceDecodeCauseError(
                    "ProjectionBaseline.verify:retainedGap",
                  )(new Error(`retained history starts after ${cursor}`));
                }
                const events = replay.events.filter(
                  (event) => event.sequence <= input.candidate.sequence,
                );
                if (events.length === 0) {
                  return yield* toPersistenceDecodeCauseError(
                    "ProjectionBaseline.verify:missingReplay",
                  )(new Error(`canonical replay ended before ${input.candidate.sequence}`));
                }
                yield* replayPage(events);
                cursor = events.at(-1)?.sequence ?? cursor;
                if (cursor < input.candidate.sequence) yield* Effect.sleep("1 millis");
              }

              // Same capture and hash as the candidate; neither payload is ever held in memory.
              return (yield* baselines.captureDigest()) === input.candidate.payloadHash;
            }).pipe(Scope.provide(workspaceScope)),
          (workspaceScope, exit) => {
            const preserve =
              resumable && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
            return Effect.exit(Scope.close(workspaceScope, exit)).pipe(
              Effect.flatMap((closeExit) =>
                Exit.isSuccess(closeExit)
                  ? Effect.void
                  : Effect.logWarning("projection baseline workspace close failed", {
                      workspaceId: String(input.candidate.baselineId),
                      outcome: "failed",
                    }),
              ),
              Effect.andThen(
                preserve
                  ? Effect.void
                  : cleanupWorkspaceArtifacts({
                      fs,
                      workspacePath,
                      workspaceId: String(input.candidate.baselineId),
                    }),
              ),
            );
          },
        );
        yield* Effect.logDebug("projection baseline workspace verification finished", {
          candidateId: input.candidate.baselineId,
          sequence: input.candidate.sequence,
          workspaceId: String(input.candidate.baselineId),
          durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
        });
        return result;
      });

      return yield* runAttempt.pipe(
        Effect.catchTag("ProjectionBaselineWorkspaceSchemaError", (first) =>
          Effect.logWarning(
            "projection baseline workspace recreated after schema validation failure",
            {
              candidateId: input.candidate.baselineId,
              sequence: input.candidate.sequence,
              workspaceId: first.workspaceId,
              migrationId: first.migrationId,
              missingMigrations: first.missingMigrations,
              missingTables: first.missingTables,
            },
          ).pipe(
            Effect.andThen(
              runAttempt.pipe(
                Effect.catchTag("ProjectionBaselineWorkspaceSchemaError", (second) =>
                  Effect.fail(
                    new PersistenceSqlError({
                      operation: "ProjectionBaseline.verify:workspaceSchema",
                      detail: second.message,
                      cause: second,
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }),
  );
