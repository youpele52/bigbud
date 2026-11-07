import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toServerThreadRetentionRun } from "../../retention/Layers/ThreadRetention.public.ts";
import {
  ThreadRetentionRepository,
  type ThreadRetentionExclusionReason,
} from "../Services/ThreadRetentionRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ThreadRetentionRepositoryLive } from "./ThreadRetentionRepository.ts";

const layer = it.layer(
  ThreadRetentionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const oldAt = "2026-01-01T00:00:00.000Z";
const cutoffAt = "2026-02-01T00:00:00.000Z";
const recentAt = "2026-02-20T00:00:00.000Z";
const now = "2026-03-01T00:00:00.000Z";
type ExclusionCounts = Array<{ reason: ThreadRetentionExclusionReason; count: number }>;

/**
 * Old root-a is held by child-a's queued prompt; old root-b by its new child-b. The others
 * are pinned, mid-turn, soft-deleted, and one idle thread nothing holds back.
 */
const seedThreads = Effect.fn("seedRetentionExclusionThreads")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM thread_retention_runs`;
  yield* sql`DELETE FROM projection_thread_sessions`;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM projection_projects`;
  yield* sql`INSERT INTO projection_projects
    (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('exclusion-project', 'Exclusions', '/exclusions', '[]', ${oldAt}, ${oldAt})`;
  const threads = [
    ["root-a", null, oldAt],
    ["child-a", "root-a", oldAt],
    ["root-b", null, oldAt],
    ["child-b", "root-b", recentAt],
    ["pinned", null, oldAt],
    ["running", null, oldAt],
    ["deleted", null, oldAt],
    ["idle", null, oldAt],
  ] as const;
  for (const [threadId, parentThreadId, createdAt] of threads) {
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, parent_thread_id, title, model_selection_json, runtime_mode,
        interaction_mode, created_at, updated_at)
      VALUES (${threadId}, 'exclusion-project', ${parentThreadId}, ${threadId},
        '{"provider":"codex","model":"test"}', 'full-access', 'default', ${createdAt}, ${createdAt})`;
  }
  yield* sql`UPDATE projection_threads SET queued_prompts_json = '[{"id":"queued"}]'
    WHERE thread_id = 'child-a'`;
  yield* sql`UPDATE projection_threads SET pinned_at = ${oldAt} WHERE thread_id = 'pinned'`;
  yield* sql`UPDATE projection_threads SET deleted_at = ${oldAt} WHERE thread_id = 'deleted'`;
  yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
    VALUES ('running', 'running', ${oldAt})`;
});

const startRun = Effect.fn("startRetentionExclusionRun")(function* (
  selectionMode: "legacy-subtree" | "per-thread",
) {
  const repository = yield* ThreadRetentionRepository;
  const run = yield* repository.createOrGetActiveRun({
    runId: `exclusion-run-${selectionMode}`,
    trigger: "scheduled",
    policy: "3-days",
    selectionMode,
    ageCriterion: "last-conversation-activity",
    cutoffAt,
    createdAt: now,
  });
  assert.isTrue(
    yield* repository.transitionRun({
      runId: run.runId,
      expectedStatuses: ["queued"],
      nextStatus: "selecting",
      updatedAt: now,
    }),
  );
  return run;
});

layer("ThreadRetentionRepository exclusion counts", (it) => {
  it.effect("saves the legacy selector's breakdown, including blocked_by_descendant", () =>
    Effect.gen(function* () {
      yield* seedThreads();
      const repository = yield* ThreadRetentionRepository;
      const run = yield* startRun("legacy-subtree");
      assert.isNull(Option.getOrThrow(yield* repository.getRun(run.runId)).exclusionSummary);

      assert.isTrue(
        yield* repository.recordRunExclusionSummary({
          runId: run.runId,
          cutoffAt,
          selectionMode: "legacy-subtree",
          ageCriterion: "last-conversation-activity",
          updatedAt: now,
        }),
      );
      const expected: ExclusionCounts = [
        { reason: "already_deleted", count: 1 },
        { reason: "blocked_by_descendant", count: 2 },
        { reason: "pending_work", count: 1 },
        { reason: "pinned", count: 1 },
        { reason: "running", count: 1 },
      ];
      const saved = Option.getOrThrow(yield* repository.getRun(run.runId));
      assert.deepEqual(saved.exclusionSummary, {
        olderThanCutoffCount: 6,
        exclusionCounts: expected,
      });
      const listed = (yield* repository.listRecentRuns(10)).find(
        (candidate) => candidate.runId === run.runId,
      );
      assert.deepEqual(listed?.exclusionSummary, saved.exclusionSummary);

      // The saved breakdown is the selector's own: the legacy preview reports the same.
      const preview = yield* repository.preview(cutoffAt, {
        selectionMode: "legacy-subtree",
        ageCriterion: "last-conversation-activity",
      });
      assert.deepEqual(preview.exclusionCounts, expected);
      assert.equal(preview.eligibleCount, 1);

      const publicRun = toServerThreadRetentionRun(saved);
      assert.equal(publicRun.olderThanCutoffCount, 6);
      assert.deepEqual(publicRun.exclusionCounts, expected);
    }),
  );

  it.effect("saves the per-thread breakdown without subtree attribution", () =>
    Effect.gen(function* () {
      yield* seedThreads();
      const repository = yield* ThreadRetentionRepository;
      const run = yield* startRun("per-thread");
      yield* repository.recordRunExclusionSummary({
        runId: run.runId,
        cutoffAt,
        selectionMode: "per-thread",
        ageCriterion: "last-conversation-activity",
        updatedAt: now,
      });

      const expected: ExclusionCounts = [
        { reason: "already_deleted", count: 1 },
        { reason: "pending_work", count: 1 },
        { reason: "pinned", count: 1 },
        { reason: "running", count: 1 },
      ];
      assert.deepEqual(Option.getOrThrow(yield* repository.getRun(run.runId)).exclusionSummary, {
        olderThanCutoffCount: 6,
        exclusionCounts: expected,
      });
      const preview = yield* repository.preview(cutoffAt, {
        selectionMode: "per-thread",
        ageCriterion: "last-conversation-activity",
      });
      assert.deepEqual(preview.exclusionCounts, expected);
      assert.equal(preview.eligibleCount, 3);
    }),
  );

  it.effect("does not write once the run left its slot and reads bad JSON as none", () =>
    Effect.gen(function* () {
      yield* seedThreads();
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      const run = yield* startRun("legacy-subtree");
      assert.isTrue(
        yield* repository.transitionRun({
          runId: run.runId,
          expectedStatuses: ["selecting"],
          nextStatus: "completed",
          updatedAt: now,
        }),
      );
      assert.isFalse(
        yield* repository.recordRunExclusionSummary({
          runId: run.runId,
          cutoffAt,
          selectionMode: "legacy-subtree",
          ageCriterion: "last-conversation-activity",
          updatedAt: now,
        }),
      );
      assert.isNull(Option.getOrThrow(yield* repository.getRun(run.runId)).exclusionSummary);

      yield* sql`UPDATE thread_retention_runs SET exclusion_counts_json = '{"broken"'
        WHERE run_id = ${run.runId}`;
      const unreadable = Option.getOrThrow(yield* repository.getRun(run.runId));
      assert.isNull(unreadable.exclusionSummary);
      assert.isUndefined(toServerThreadRetentionRun(unreadable).exclusionCounts);
    }),
  );
});
