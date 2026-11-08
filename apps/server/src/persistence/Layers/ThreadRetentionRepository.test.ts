import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ThreadRetentionRepository } from "../Services/ThreadRetentionRepository.ts";
import {
  cutoffAt,
  layer,
  now,
  oldAt,
  projectId,
  resetData,
  seedProject,
  seedThread,
} from "./ThreadRetentionRepository.test.helpers.ts";

layer("ThreadRetentionRepository", (it) => {
  it.effect("selects exact-boundary candidates in stable keyset order", () =>
    Effect.gen(function* () {
      yield* resetData();
      yield* seedProject();
      yield* seedThread("thread-b", cutoffAt);
      yield* seedThread("thread-a", cutoffAt);
      yield* seedThread("thread-new", "2026-02-01T00:00:00.001Z");
      const repository = yield* ThreadRetentionRepository;

      const first = yield* repository.selectNextPage({ cutoffAt, limit: 1 });
      const cursor = first[0];
      if (cursor === undefined) return yield* Effect.die("expected first candidate");
      assert.equal(cursor.threadId, "thread-a");
      assert.equal(cursor.lastActivityAt, cutoffAt);
      const second = yield* repository.selectNextPage({
        cutoffAt,
        cursor,
        limit: 10,
      });
      assert.equal(second[0]?.threadId, "thread-b");
      assert.equal(second[0]?.lastActivityAt, cutoffAt);
    }),
  );

  it.effect("does not exclude eligible threads because of an incomplete purge job", () =>
    Effect.gen(function* () {
      yield* resetData();
      yield* seedProject();
      yield* seedThread("purge-backlog-independent");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO purge_jobs (
          job_id, entity_kind, entity_id, phase, status, resource_manifest_json, created_at, updated_at
        ) VALUES (
          'failed-historical-purge', 'thread', 'purge-backlog-independent',
          'files', 'failed', '{}', ${oldAt}, ${now}
        )
      `;
      const repository = yield* ThreadRetentionRepository;
      assert.deepEqual(yield* repository.selectNextPage({ cutoffAt, limit: 10 }), [
        { threadId: ThreadId.makeUnsafe("purge-backlog-independent"), lastActivityAt: oldAt },
      ]);
    }),
  );

  it.effect("protects an old root when a descendant has newer activity", () =>
    Effect.gen(function* () {
      yield* resetData();
      yield* seedProject();
      yield* seedThread("old-root");
      yield* seedThread("new-child", oldAt);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE projection_threads
        SET parent_thread_id = 'old-root', parent_thread_title = 'old-root',
          parent_thread_project_id = ${projectId},
          created_at = ${now}, updated_at = ${now}, last_activity_at = ${now}
        WHERE thread_id = 'new-child'
      `;
      const repository = yield* ThreadRetentionRepository;
      assert.deepEqual(yield* repository.selectNextPage({ cutoffAt, limit: 10 }), []);
      assert.equal((yield* repository.preview(cutoffAt)).eligibleCount, 0);
    }),
  );

  it.effect("reports deterministic exclusive exclusions", () =>
    Effect.gen(function* () {
      yield* resetData();
      yield* seedProject();
      yield* seedThread("eligible");
      yield* seedThread("pinned");
      yield* seedThread("running");
      yield* seedThread("task");
      yield* seedThread("queued");
      yield* seedThread("waiting");
      yield* seedThread("watched");
      yield* seedThread("delegated");
      yield* seedThread("scheduled");
      yield* seedThread("owned");
      yield* seedThread("already-deleted");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_threads SET pinned_at = ${now} WHERE thread_id = 'pinned'`;
      yield* sql`
        UPDATE projection_threads SET deleted_at = ${now} WHERE thread_id = 'already-deleted'
      `;
      yield* sql`
        UPDATE projection_threads
        SET queued_prompts_json = '[{"id":"queued-message"}]' WHERE thread_id = 'queued'
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, updated_at)
        VALUES ('running', 'running', ${now})
      `;
      yield* sql` -- Touched within 24 hours: an older open task no longer holds a thread back.
        INSERT INTO projection_thread_tasks (task_id, thread_id, task_json, created_at, updated_at)
        VALUES ('task-active', 'task', '{"status":"pending"}', ${oldAt}, ${new Date().toISOString()})
      `;
      yield* sql`
        INSERT INTO projection_pending_approvals (
          request_id, thread_id, turn_id, status, created_at
        ) VALUES ('approval-1', 'waiting', NULL, 'pending', ${oldAt})
      `;
      yield* sql`
        INSERT INTO projection_thread_watches (
          watch_id, watcher_thread_id, watched_thread_id, watched_thread_title,
          source_message_id, status, created_at
        ) VALUES ('watch-preview', 'watched', 'eligible', 'Eligible', 'message-preview', 'active', ${oldAt})
      `;
      yield* sql`
        INSERT INTO thread_delegations (
          delegation_id, caller_thread_id, source_message_id, invocation_id,
          root_delegation_id, depth, target_kind, child_thread_id, child_turn_id,
          state, created_at, updated_at
        ) VALUES ('delegation-preview', 'delegated', 'message-preview', 'invocation-preview',
          'delegation-preview', 0, 'project', 'eligible', 'turn-preview', 'reserved', ${oldAt}, ${oldAt})
      `;
      yield* sql`
        INSERT INTO automation_schedules (
          automation_id, project_id, target_thread_id, owns_target_thread, title, prompt,
          cron_expression, timezone, next_run_at, paused_at, created_at, updated_at
        ) VALUES
          ('schedule-preview', ${projectId}, 'scheduled', 0, 'Schedule', 'Prompt',
            '* * * * *', 'UTC', ${now}, NULL, ${oldAt}, ${oldAt}),
          ('owned-preview', ${projectId}, 'owned', 1, 'Owned', 'Prompt',
            '* * * * *', 'UTC', NULL, ${now}, ${oldAt}, ${oldAt})
      `;
      const repository = yield* ThreadRetentionRepository;
      const preview = yield* repository.preview(cutoffAt);
      assert.equal(preview.eligibleCount, 3);
      assert.deepEqual(preview.exclusionCounts, [
        { reason: "active_task", count: 1 },
        { reason: "already_deleted", count: 1 },
        { reason: "automation_owned", count: 1 },
        { reason: "pending_work", count: 1 },
        { reason: "pinned", count: 1 },
        { reason: "running", count: 1 },
        { reason: "scheduled", count: 1 },
        { reason: "waiting_for_user", count: 1 },
      ]);
    }),
  );

  it.effect("advances activity monotonically", () =>
    Effect.gen(function* () {
      yield* resetData();
      yield* seedProject();
      yield* seedThread("monotonic", cutoffAt);
      const threads = yield* ProjectionThreadRepository;
      yield* threads.touchActivity({
        threadId: ThreadId.makeUnsafe("monotonic"),
        occurredAt: oldAt,
      });
      assert.equal(
        Option.getOrThrow(yield* threads.getById({ threadId: ThreadId.makeUnsafe("monotonic") }))
          .lastActivityAt,
        cutoffAt,
      );
      yield* threads.touchActivity({
        threadId: ThreadId.makeUnsafe("monotonic"),
        occurredAt: now,
      });
      assert.equal(
        Option.getOrThrow(yield* threads.getById({ threadId: ThreadId.makeUnsafe("monotonic") }))
          .lastActivityAt,
        now,
      );
    }),
  );

  it.effect("applies run transitions with compare-and-set semantics", () =>
    Effect.gen(function* () {
      yield* resetData();
      const repository = yield* ThreadRetentionRepository;
      yield* repository.createOrGetActiveRun({
        runId: "run-cas",
        trigger: "scheduled",
        policy: "7-days",
        cutoffAt,
        createdAt: oldAt,
      });
      assert.equal(
        yield* repository.transitionRun({
          runId: "run-cas",
          expectedStatuses: ["selecting"],
          nextStatus: "preparing",
          updatedAt: now,
        }),
        false,
      );
      assert.equal(
        yield* repository.transitionRun({
          runId: "run-cas",
          expectedStatuses: ["queued"],
          nextStatus: "selecting",
          updatedAt: now,
          eligibleCount: 12,
        }),
        true,
      );
      assert.equal(Option.getOrThrow(yield* repository.getRun("run-cas")).eligibleCount, 12);
    }),
  );
});
