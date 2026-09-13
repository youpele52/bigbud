import { LOCAL_EXECUTION_TARGET_ID, ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";

const layer = it.layer(
  ProjectionThreadRepositoryLive.pipe(
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, SqlitePersistenceMemory)),
  ),
);

const makeThread = (threadId: ThreadId, projectId: ProjectId) => ({
  threadId,
  projectId,
  title: "Project cascade thread",
  purpose: "standard" as const,
  elevatorSummary: "Project cascade thread",
  elevatorSummaryMessageCount: 0,
  providerRuntimeExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
  workspaceExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
  executionTargetId: LOCAL_EXECUTION_TARGET_ID,
  modelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  latestTurnId: null,
  queuedPrompts: [],
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
  lastActivityAt: "2026-09-13T00:00:00.000Z",
  archivedAt: null,
  pinnedAt: null,
  deletedAt: null,
  deletingAt: null,
});

layer("Projection thread deletion", (it) => {
  it.effect("rejects project-cascade deletion before a shared schedule can cascade", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("project-cascade-thread");
      const scheduledThreadId = ThreadId.makeUnsafe("project-cascade-scheduled-thread");
      const projectId = ProjectId.makeUnsafe("project-cascade-project");
      yield* threads.upsert(makeThread(threadId, projectId));
      yield* threads.upsert(makeThread(scheduledThreadId, projectId));
      yield* sql`
        INSERT INTO automation_schedules (
          automation_id, project_id, target_thread_id, title, prompt, cron_expression,
          timezone, created_at, updated_at
        ) VALUES ('projection-shared-schedule', 'other-project', ${scheduledThreadId}, 'Shared', 'prompt',
          '* * * * *', 'UTC', 'now', 'now')
      `;

      const rejected = yield* Effect.exit(
        threads.deleteById({
          threadId,
          threadIds: [threadId, scheduledThreadId],
          origin: "project-cascade",
        }),
      );
      assert.isTrue(Exit.isFailure(rejected));
      assert.deepEqual(yield* sql`SELECT thread_id FROM projection_threads ORDER BY thread_id`, [
        { thread_id: scheduledThreadId },
        { thread_id: threadId },
      ]);
      assert.deepEqual(yield* sql`SELECT automation_id FROM automation_schedules`, [
        { automation_id: "projection-shared-schedule" },
      ]);

      yield* threads.deleteById({ threadId, threadIds: [threadId, scheduledThreadId] });
      assert.deepEqual(yield* sql`SELECT thread_id FROM projection_threads`, []);
      assert.deepEqual(yield* sql`SELECT automation_id FROM automation_schedules`, []);
    }),
  );
});
