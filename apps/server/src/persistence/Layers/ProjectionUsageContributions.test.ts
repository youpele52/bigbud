import { EventId, ThreadId, TurnId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runUsageContributionBackfill } from "../../orchestration/Layers/ProjectionPipeline.usageBackfill.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";

const usageContributionLayer = it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const contribution = (input: {
  readonly usedTokens: number;
  readonly sequence: number | null;
  readonly updatedAt: string;
}) => ({
  contributionId: "codex:thread-1:turn:turn-1",
  activityId: EventId.makeUnsafe("activity-" + input.usedTokens),
  threadId: ThreadId.makeUnsafe("thread-1"),
  turnId: TurnId.makeUnsafe("turn-1"),
  provider: "codex",
  model: "gpt-5.6",
  interactionMode: "default" as const,
  occurredAt: input.updatedAt,
  usedTokens: input.usedTokens,
  inputTokens: input.usedTokens,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  finalized: true,
  sourceSequence: input.sequence,
  updatedAt: input.updatedAt,
});

usageContributionLayer("Projection usage contributions", (it) => {
  it.effect("preserves consumed usage when thread activities are pruned for revert", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* repository.upsert({
        activityId: EventId.makeUnsafe("activity-reverted"),
        threadId: ThreadId.makeUnsafe("thread-reverted"),
        turnId: TurnId.makeUnsafe("turn-reverted"),
        tone: "info",
        kind: "context-window.updated",
        summary: "Context window updated",
        payload: { usedTokens: 100 },
        sequence: 1,
        createdAt: "2026-07-14T00:00:00.000Z",
      });
      yield* repository.upsertUsageContribution({
        ...contribution({
          usedTokens: 100,
          sequence: 1,
          updatedAt: "2026-07-14T00:00:00.000Z",
        }),
        contributionId: "codex:thread-reverted:turn:turn-reverted",
        activityId: EventId.makeUnsafe("activity-reverted"),
        threadId: ThreadId.makeUnsafe("thread-reverted"),
        turnId: TurnId.makeUnsafe("turn-reverted"),
      });

      yield* repository.deleteByThreadId({
        threadId: ThreadId.makeUnsafe("thread-reverted"),
      });

      const rows = yield* sql<{ count: number }>`
        SELECT COUNT(*) AS count
        FROM projection_usage_contributions
        WHERE thread_id = 'thread-reverted'
      `;
      assert.deepStrictEqual(rows, [{ count: 1 }]);
    }),
  );

  it.effect("prevents unsequenced or older replay from replacing newer usage", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* repository.upsertUsageContribution(
        contribution({
          usedTokens: 100,
          sequence: 10,
          updatedAt: "2026-07-14T00:00:00.000Z",
        }),
      );
      yield* repository.upsertUsageContribution(
        contribution({
          usedTokens: 999,
          sequence: null,
          updatedAt: "2026-07-14T00:00:02.000Z",
        }),
      );
      yield* repository.upsertUsageContribution(
        contribution({
          usedTokens: 90,
          sequence: 9,
          updatedAt: "2026-07-14T00:00:03.000Z",
        }),
      );
      yield* repository.upsertUsageContribution(
        contribution({
          usedTokens: 110,
          sequence: 11,
          updatedAt: "2026-07-14T00:00:04.000Z",
        }),
      );

      const rows = yield* sql<{ usedTokens: number; sourceSequence: number }>`
        SELECT
          used_tokens AS "usedTokens",
          source_sequence AS "sourceSequence"
        FROM projection_usage_contributions
        WHERE contribution_id = 'codex:thread-1:turn:turn-1'
      `;
      assert.deepStrictEqual(rows, [{ usedTokens: 110, sourceSequence: 11 }]);
    }),
  );

  it.effect("resumes bounded legacy backfill without replacing live usage", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadActivityRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id, created_at, updated_at,
          archived_at, deleted_at
        ) VALUES (
          'thread-backfill', 'project-backfill', 'Backfill', 'standard',
          '{"provider":"codex","model":"gpt-5.6"}', 'full-access', 'default',
          NULL, NULL, NULL, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z', NULL, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES (
          'activity-backfill', 'thread-backfill', 'turn-backfill', 'info',
          'context-window.updated', 'Context window updated',
          '{"usedTokens":200,"inputTokens":150,"outputTokens":50}',
          2, '2026-07-14T00:00:02.000Z'
        )
      `;
      yield* repository.upsertUsageContribution({
        contributionId: "codex:thread-backfill:turn:turn-backfill",
        activityId: EventId.makeUnsafe("activity-live"),
        threadId: ThreadId.makeUnsafe("thread-backfill"),
        turnId: TurnId.makeUnsafe("turn-backfill"),
        provider: "codex",
        model: "gpt-5.6",
        interactionMode: "default",
        occurredAt: "2026-07-14T00:00:03.000Z",
        usedTokens: 300,
        inputTokens: 200,
        cachedInputTokens: 0,
        outputTokens: 100,
        reasoningOutputTokens: 0,
        finalized: true,
        sourceSequence: 3,
        updatedAt: "2026-07-14T00:00:03.000Z",
      });

      yield* runUsageContributionBackfill({ repository });

      const state = yield* repository.getUsageBackfillState();
      const rows = yield* sql<{ usedTokens: number; sourceSequence: number }>`
        SELECT
          used_tokens AS "usedTokens",
          source_sequence AS "sourceSequence"
        FROM projection_usage_contributions
        WHERE contribution_id = 'codex:thread-backfill:turn:turn-backfill'
      `;
      const queryPlan = yield* sql<{ detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
        WHERE activity_id > ''
        ORDER BY activity_id ASC
        LIMIT 100
      `;
      assert.strictEqual(state.completed, true);
      assert.deepStrictEqual(rows, [{ usedTokens: 300, sourceSequence: 3 }]);
      assert.ok(queryPlan.every((row) => !row.detail.includes("TEMP B-TREE")));
    }),
  );
});
