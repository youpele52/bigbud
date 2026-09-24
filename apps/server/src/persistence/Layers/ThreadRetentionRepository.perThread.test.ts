import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadRetentionRepository } from "../Services/ThreadRetentionRepository.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ThreadRetentionRepositoryLive } from "./ThreadRetentionRepository.ts";

const layer = it.layer(
  ThreadRetentionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);
const createdAt = "2026-01-01T00:00:00.000Z";
const cutoffAt = "2026-02-01T00:00:00.000Z";
const laterAt = "2026-03-01T00:00:00.000Z";

const seed = Effect.fn("seedPerThreadRetention")(function* (
  suffix = "",
  dates = { createdAt, cutoffAt, laterAt },
) {
  const sql = yield* SqlClient.SqlClient;
  const projectId = `project${suffix}`;
  const parentId = `a-parent${suffix}`;
  const childId = `z-child${suffix}`;
  const pinnedId = `pinned${suffix}`;
  yield* sql`INSERT INTO projection_projects (
    project_id, title, workspace_root, scripts_json, created_at, updated_at
  ) VALUES (${projectId}, 'Project', '/project', '[]', ${dates.createdAt}, ${dates.createdAt})`;
  for (const [threadId, parent] of [
    [parentId, null],
    [childId, parentId],
    [pinnedId, null],
  ] as const) {
    yield* sql`INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, parent_thread_id, created_at, updated_at, last_activity_at,
      pinned_at
    ) VALUES (${threadId}, ${projectId}, ${threadId},
      '{"provider":"codex","model":"test"}', 'full-access', 'default',
      ${parent}, ${dates.createdAt}, ${dates.laterAt}, ${dates.laterAt},
      ${threadId === pinnedId ? dates.createdAt : null})`;
  }
  yield* sql`INSERT INTO projection_thread_messages (
    message_id, thread_id, role, text, is_streaming, created_at, updated_at
  ) VALUES (${`parent-user${suffix}`}, ${parentId}, 'user', 'old', 0, ${dates.cutoffAt}, ${dates.cutoffAt}),
    (${`child-assistant${suffix}`}, ${childId}, 'assistant', 'new', 0, ${dates.laterAt}, ${dates.laterAt})`;
});

layer("per-thread retention selection", (it) => {
  it.effect("agrees across preview, queue, pages and claim at the inclusive cutoff", () =>
    Effect.gen(function* () {
      yield* seed();
      const repository = yield* ThreadRetentionRepository;
      const options = {
        selectionMode: "per-thread" as const,
        ageCriterion: "last-conversation-activity" as const,
      };
      const diagnostic = yield* repository.selectNextPage({ cutoffAt, ...options, limit: 10 });
      assert.deepEqual(
        diagnostic.map((candidate) => candidate.threadId),
        ["z-child", "a-parent"],
      );
      const preview = yield* repository.preview(cutoffAt, options);
      assert.deepEqual(preview.exclusionCounts, [{ reason: "pinned", count: 1 }]);
      assert.equal(preview.eligibleCount, 2);
      assert.equal(preview.oldestEligibleAgeAt, createdAt);
      assert.equal(preview.newestEligibleAgeAt, cutoffAt);
      const run = yield* repository.createOrGetActiveRun({
        runId: "per-thread-boundary",
        trigger: "manual",
        policy: "7-days",
        ...options,
        cutoffAt,
        createdAt: laterAt,
      });
      assert.equal(run.eligibleCount, preview.eligibleCount);
      const page = yield* repository.selectNextPage({ cutoffAt, ...options, limit: 10 });
      assert.deepEqual(
        page.map((candidate) => candidate.threadId),
        ["z-child", "a-parent"],
      );
      assert.isTrue(
        yield* repository.transitionRun({
          runId: run.runId,
          expectedStatuses: ["queued"],
          nextStatus: "selecting",
          updatedAt: laterAt,
        }),
      );
      assert.isTrue(
        (yield* repository.insertSelectedPage({
          runId: run.runId,
          expectedStatus: "selecting",
          expectedCursor: null,
          nextCursor: page.at(-1)!,
          candidates: page.map((candidate) => ({
            threadId: candidate.threadId,
            lastActivityAt: candidate.lastActivityAt,
            deletionCommandId: `delete:${candidate.threadId}`,
          })),
          createdAt: laterAt,
        })).applied,
      );
      const outstanding = yield* repository.listOutstandingItems(run.runId, 10);
      assert.deepEqual(
        outstanding.map((item) => item.threadId),
        ["z-child"],
      );
      assert.deepEqual(
        yield* repository.recheckAndClaimItem({
          runId: run.runId,
          threadId: ThreadId.makeUnsafe("z-child"),
          expectedLastActivityAt: createdAt,
          cutoffAt: laterAt,
          claimedAt: laterAt,
        }),
        { claimed: false, reason: "not_selected" },
      );
      const claimed = yield* repository.recheckAndClaimItem({
        runId: run.runId,
        threadId: ThreadId.makeUnsafe("z-child"),
        expectedLastActivityAt: createdAt,
        cutoffAt,
        claimedAt: laterAt,
      });
      assert.deepEqual(claimed, { claimed: true });
      assert.equal(Option.getOrThrow(yield* repository.getRun(run.runId)).uncertainCount, 1);
      for (const [previous, next] of [
        ["deletion_requested", "prepared"],
        ["prepared", "purging"],
      ] as const) {
        assert.isTrue(
          yield* repository.transitionItem({
            runId: run.runId,
            threadId: ThreadId.makeUnsafe("z-child"),
            expectedStatuses: [previous],
            nextStatus: next,
            updatedAt: laterAt,
          }),
        );
      }
      assert.isTrue(
        yield* repository.transitionItem({
          runId: run.runId,
          threadId: ThreadId.makeUnsafe("z-child"),
          expectedStatuses: ["purging"],
          nextStatus: "completed",
          updatedAt: laterAt,
        }),
      );
      assert.equal(Option.getOrThrow(yield* repository.getRun(run.runId)).uncertainCount, 0);
    }),
  );

  it.effect("created age ignores later user activity, while conversation age rechecks it", () =>
    Effect.gen(function* () {
      const earlierDates = {
        createdAt: "2025-01-01T00:00:00.000Z",
        cutoffAt: "2025-02-01T00:00:00.000Z",
        laterAt: "2025-03-01T00:00:00.000Z",
      };
      yield* seed("-second", earlierDates);
      const repository = yield* ThreadRetentionRepository;
      const sql = yield* SqlClient.SqlClient;
      const createdOptions = {
        selectionMode: "per-thread" as const,
        ageCriterion: "created" as const,
      };
      const createdPreview = yield* repository.preview(earlierDates.cutoffAt, createdOptions);
      assert.equal(createdPreview.eligibleCount, 2);
      yield* sql`INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, is_streaming, created_at, updated_at
      ) VALUES ('child-user-new', 'z-child-second', 'user', 'new', 0, ${earlierDates.laterAt}, ${earlierDates.laterAt})`;
      const activityPreview = yield* repository.preview(earlierDates.cutoffAt, {
        selectionMode: "per-thread",
        ageCriterion: "last-conversation-activity",
      });
      assert.equal(activityPreview.eligibleCount, 1);
      assert.equal(
        (yield* repository.preview(earlierDates.cutoffAt, createdOptions)).eligibleCount,
        2,
      );
    }),
  );
});
