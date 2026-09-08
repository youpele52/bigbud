import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import {
  ThreadRetentionRepository,
  type ThreadRetentionRepositoryShape,
} from "../../persistence/Services/ThreadRetentionRepository.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadRetentionRepositoryLive } from "../../persistence/Layers/ThreadRetentionRepository.ts";
import { runDirectThreadRetention } from "./ThreadRetention.direct.ts";

const projectId = ProjectId.makeUnsafe("retention-direct-sqlite-project");
const oldAt = "2026-08-01T00:00:00.000Z";
const cutoffAt = "2026-08-10T00:00:00.000Z";
const now = "2026-08-18T00:00:00.000Z";

const layer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive,
    ProjectionThreadRepositoryLive,
    ThreadRetentionRepositoryLive,
  ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const resetData = Effect.fn("resetDirectRetentionSqliteData")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM thread_retention_run_items`;
  yield* sql`DELETE FROM thread_retention_runs`;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM projection_projects`;
});

const seedThread = Effect.fn("seedDirectRetentionSqliteThread")(function* (threadId: ThreadId) {
  const projects = yield* ProjectionProjectRepository;
  const threads = yield* ProjectionThreadRepository;
  yield* projects.upsert({
    projectId,
    title: "Retention direct SQLite",
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    workspaceRoot: "/tmp/retention-direct-sqlite",
    defaultModelSelection: null,
    scripts: [],
    createdAt: oldAt,
    updatedAt: oldAt,
    deletingAt: null,
    deletedAt: null,
  });
  yield* threads.upsert({
    threadId,
    projectId,
    title: threadId,
    purpose: "standard",
    elevatorSummary: threadId,
    elevatorSummaryMessageCount: 0,
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurnId: null,
    queuedPrompts: [],
    createdAt: oldAt,
    updatedAt: oldAt,
    lastActivityAt: oldAt,
    archivedAt: null,
    pinnedAt: null,
    deletingAt: null,
    deletedAt: null,
  });
});

const seedRun = Effect.fn("seedDirectRetentionSqliteRun")(function* (input: {
  readonly runId: string;
  readonly threadId: ThreadId;
  readonly deletionCommandId: string;
  readonly resumedProgress: boolean;
}) {
  const repository = yield* ThreadRetentionRepository;
  const sql = yield* SqlClient.SqlClient;
  yield* repository.createOrGetActiveRun({
    runId: input.runId,
    trigger: "scheduled",
    policy: "7-days",
    cutoffAt,
    createdAt: now,
  });
  assert.isTrue(
    yield* repository.transitionRun({
      runId: input.runId,
      expectedStatuses: ["queued"],
      nextStatus: "selecting",
      updatedAt: now,
    }),
  );
  assert.isTrue(
    (yield* repository.insertSelectedPage({
      runId: input.runId,
      expectedStatus: "selecting",
      expectedCursor: null,
      nextCursor: { lastActivityAt: oldAt, threadId: input.threadId },
      candidates: [
        {
          threadId: input.threadId,
          lastActivityAt: oldAt,
          deletionCommandId: input.deletionCommandId,
        },
      ],
      createdAt: now,
    })).applied,
  );
  if (input.resumedProgress) {
    yield* sql`
      UPDATE thread_retention_runs SET eligible_count = 4, selected_count = 4,
        requested_count = 3, completed_count = 1, skipped_count = 1, failed_count = 1
      WHERE run_id = ${input.runId}
    `;
  }
  const run = yield* repository.getRun(input.runId);
  if (Option.isNone(run)) return yield* Effect.die("seeded retention run disappeared");
  return run.value;
});

function readModel(threadId: ThreadId, deleted: boolean) {
  return {
    threads: deleted
      ? []
      : [{ id: threadId, deletedAt: null, deletingAt: null, parentThread: undefined }],
  } as never;
}

function trackedRepository(
  repository: ThreadRetentionRepositoryShape,
  transitions: string[],
): ThreadRetentionRepositoryShape {
  return {
    ...repository,
    transitionItem: (input) =>
      repository.transitionItem(input).pipe(
        Effect.tap((changed) =>
          Effect.sync(() => {
            transitions.push(`${input.expectedStatuses[0]} -> ${input.nextStatus}: ${changed}`);
          }),
        ),
      ),
  };
}

layer("direct retention with SQLite lifecycle triggers", (it) => {
  it.effect("completes a claimed item through the persisted lifecycle on resume", () =>
    Effect.gen(function* () {
      yield* resetData();
      const repository = yield* ThreadRetentionRepository;
      const threadId = ThreadId.makeUnsafe("retention-direct-sqlite-success");
      const deletionCommandId = "stable:retention:sqlite:success";
      yield* seedThread(threadId);
      const run = yield* seedRun({
        runId: "retention-direct-sqlite-success-run",
        threadId,
        deletionCommandId,
        resumedProgress: true,
      });
      let deleted = false;
      const dispatched: Array<{ readonly commandId: string; readonly createdAt: string }> = [];
      const transitions: string[] = [];
      const orchestration = {
        dispatch: (command: Parameters<OrchestrationEngineShape["dispatch"]>[0]) =>
          Effect.gen(function* () {
            if (command.type !== "thread.retention-delete") {
              return yield* Effect.die("unexpected retention test command");
            }
            const claimed = yield* repository.recheckAndClaimItem({
              runId: command.runId,
              threadId: command.threadId,
              expectedLastActivityAt: command.expectedLastActivityAt,
              cutoffAt: command.cutoffAt,
              claimedAt: command.createdAt,
            });
            assert.isTrue(claimed.claimed);
            dispatched.push({ commandId: command.commandId, createdAt: command.createdAt });
            deleted = true;
            return { sequence: 1 };
          }),
        streamDomainEvents: Stream.empty,
        getReadModel: () => Effect.succeed(readModel(threadId, deleted)),
      } as never;

      const result = yield* runDirectThreadRetention({
        run,
        repository: trackedRepository(repository, transitions),
        orchestration,
        now: () => Date.parse(now),
      });
      const item = (yield* repository.listRunItems(run.runId))[0]!;
      const completedRun = Option.getOrThrow(yield* repository.getRun(run.runId));

      assert.deepEqual(transitions, [
        "deletion_requested -> prepared: true",
        "prepared -> purging: true",
        "purging -> completed: true",
      ]);
      assert.equal(item.status, "completed");
      assert.equal(item.deletionCommandId, deletionCommandId);
      assert.deepEqual(dispatched, [{ commandId: deletionCommandId, createdAt: item.createdAt }]);
      assert.equal(completedRun.status, "completed_with_failures");
      assert.deepEqual(
        [completedRun.completedCount, completedRun.skippedCount, completedRun.failedCount],
        [2, 1, 1],
      );
      assert.deepEqual([result.deletedCount, result.skippedCount, result.pendingCount], [2, 1, 1]);
    }),
  );

  it.effect("fails once and preserves recovery state when item ownership is stale", () =>
    Effect.gen(function* () {
      yield* resetData();
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("retention-direct-sqlite-stale");
      const deletionCommandId = "stable:retention:sqlite:stale";
      yield* seedThread(threadId);
      const run = yield* seedRun({
        runId: "retention-direct-sqlite-stale-run",
        threadId,
        deletionCommandId,
        resumedProgress: false,
      });
      let deleted = false;
      let dispatchCount = 0;
      const transitions: string[] = [];
      const orchestration = {
        dispatch: (command: Parameters<OrchestrationEngineShape["dispatch"]>[0]) =>
          Effect.gen(function* () {
            if (command.type !== "thread.retention-delete") {
              return yield* Effect.die("unexpected retention test command");
            }
            const claimed = yield* repository.recheckAndClaimItem({
              runId: command.runId,
              threadId: command.threadId,
              expectedLastActivityAt: command.expectedLastActivityAt,
              cutoffAt: command.cutoffAt,
              claimedAt: command.createdAt,
            });
            assert.isTrue(claimed.claimed);
            dispatchCount += 1;
            yield* sql`UPDATE thread_retention_runs SET active_slot = NULL WHERE run_id = ${run.runId}`;
            deleted = true;
            return { sequence: 1 };
          }),
        streamDomainEvents: Stream.empty,
        getReadModel: () => Effect.succeed(readModel(threadId, deleted)),
      } as never;

      const error = yield* runDirectThreadRetention({
        run,
        repository: trackedRepository(repository, transitions),
        orchestration,
        now: () => Date.parse(now),
      }).pipe(Effect.flip);
      const item = (yield* repository.listRunItems(run.runId))[0]!;
      const persistedRun = Option.getOrThrow(yield* repository.getRun(run.runId));

      assert.match(String(error), /transition lost ownership or state/);
      assert.deepEqual(transitions, ["deletion_requested -> prepared: false"]);
      assert.equal(dispatchCount, 1);
      assert.equal(item.status, "deletion_requested");
      assert.equal(item.deletionCommandId, deletionCommandId);
      assert.equal(persistedRun.status, "selecting");
      assert.equal(persistedRun.completedCount, 0);
    }),
  );
});
