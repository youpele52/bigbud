import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadRetentionRepositoryLive } from "../../persistence/Layers/ThreadRetentionRepository.ts";
import {
  ThreadRetentionRepository,
  type ThreadRetentionRepositoryShape,
} from "../../persistence/Services/ThreadRetentionRepository.ts";
import { runDirectThreadRetentionCoordinated } from "./ThreadRetention.direct.ts";

const layer = it.layer(
  ThreadRetentionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const oldAt = "2026-01-01T00:00:00.000Z";
const cutoffAt = "2026-02-01T00:00:00.000Z";
const nowMs = Date.parse("2026-03-01T00:00:00.000Z");
const orchestration = {
  dispatch: () => Effect.die(new Error("nothing is eligible, so nothing is dispatched")),
  getReadModel: () => Effect.succeed({ threads: [] } as never),
  streamDomainEvents: Stream.empty,
} as never;

/** One old thread with a turn in progress: the selector skips it as running. */
const seedRunningThreadAndRun = Effect.fn("seedRetentionExclusionDirectRun")(function* (
  runId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ThreadRetentionRepository;
  yield* sql`DELETE FROM thread_retention_runs`;
  yield* sql`DELETE FROM projection_thread_sessions`;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM projection_projects`;
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('direct-exclusion-project', 'Direct', '/direct', '[]', ${oldAt}, ${oldAt})`;
  yield* sql`INSERT INTO projection_threads
    (thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, created_at, updated_at)
    VALUES ('stale-running', 'direct-exclusion-project', 'Stale',
      '{"provider":"codex","model":"test"}', 'full-access', 'default', ${oldAt}, ${oldAt})`;
  yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
    VALUES ('stale-running', 'running', ${oldAt})`;
  return yield* repository.createOrGetActiveRun({
    runId,
    trigger: "scheduled",
    policy: "3-days",
    cutoffAt,
    createdAt: new Date(nowMs).toISOString(),
  });
});

const execute = (
  run: Parameters<typeof runDirectThreadRetentionCoordinated>[0]["run"],
  repository: ThreadRetentionRepositoryShape,
) =>
  runDirectThreadRetentionCoordinated({
    run,
    repository,
    orchestration,
    now: () => nowMs,
    settleTimeoutMs: 0,
    onSelectionPagePersisted: () => Effect.succeed(false),
  });

layer("direct retention exclusion summary", (it) => {
  it.effect("a scheduled legacy run that deletes nothing records why", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const run = yield* seedRunningThreadAndRun("direct-exclusion-run");
      let recorded = 0;
      const execution = yield* execute(run, {
        ...repository,
        recordRunExclusionSummary: (input) => {
          recorded += 1;
          assert.deepEqual(
            { mode: input.selectionMode, age: input.ageCriterion, cutoff: input.cutoffAt },
            { mode: "legacy-subtree", age: "last-conversation-activity", cutoff: cutoffAt },
          );
          return repository.recordRunExclusionSummary(input);
        },
      });

      assert.equal(execution.kind, "completed");
      if (execution.kind !== "completed") return;
      assert.equal(execution.result.deletedCount, 0);
      assert.equal(recorded, 1);
      const finished = Option.getOrThrow(yield* repository.getRun(run.runId));
      assert.equal(finished.status, "completed");
      assert.deepEqual(finished.exclusionSummary, {
        olderThanCutoffCount: 1,
        exclusionCounts: [{ reason: "running", count: 1 }],
      });
    }),
  );

  it.effect("a resumed run keeps its first breakdown instead of recomputing it", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const run = yield* seedRunningThreadAndRun("direct-exclusion-resumed");
      let recorded = 0;
      const execution = yield* execute(
        {
          ...run,
          exclusionSummary: {
            olderThanCutoffCount: 4,
            exclusionCounts: [{ reason: "pinned", count: 4 }],
          },
        },
        {
          ...repository,
          recordRunExclusionSummary: () => {
            recorded += 1;
            return Effect.succeed(true);
          },
        },
      );
      assert.equal(execution.kind, "completed");
      assert.equal(recorded, 0);
    }),
  );

  it.effect("a failed breakdown write does not stop the run", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadRetentionRepository;
      const run = yield* seedRunningThreadAndRun("direct-exclusion-write-failed");
      const execution = yield* execute(run, {
        ...repository,
        recordRunExclusionSummary: () =>
          Effect.fail(
            new PersistenceSqlError({
              operation: "recordRunExclusionSummary",
              detail: "SQLITE_BUSY",
            }),
          ),
      });
      assert.equal(execution.kind, "completed");
      const finished = Option.getOrThrow(yield* repository.getRun(run.runId));
      assert.equal(finished.status, "completed");
      assert.isNull(finished.exclusionSummary);
    }),
  );
});
