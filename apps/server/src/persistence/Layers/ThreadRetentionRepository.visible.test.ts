import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";
import { ThreadRetentionRepository } from "../Services/ThreadRetentionRepository.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ThreadRetentionRepositoryLive } from "./ThreadRetentionRepository.ts";

const repositories = Layer.mergeAll(
  ProjectionProjectRepositoryLive,
  ProjectionThreadRepositoryLive,
  ThreadRetentionRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));
const layer = it.layer(repositories);
const projectId = ProjectId.makeUnsafe("retention-visible-project");
const oldAt = "2026-01-01T00:00:00.000Z";
const cutoffAt = "2026-02-01T00:00:00.000Z";
const now = "2026-03-01T00:00:00.000Z";

const resetData = Effect.fn("resetVisibleRetentionData")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM projection_thread_messages`;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM projection_projects`;
});

const seedProject = Effect.fn("seedVisibleRetentionProject")(function* () {
  const projects = yield* ProjectionProjectRepository;
  yield* projects.upsert({
    projectId,
    title: "Retention",
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    workspaceRoot: "/tmp/retention-visible",
    defaultModelSelection: null,
    scripts: [],
    createdAt: oldAt,
    updatedAt: oldAt,
    deletingAt: null,
    deletedAt: null,
  });
});

layer("thread retention visible recency", (it) => {
  it.effect("treats last_activity_at-only updates as eligible when the user message is old", () =>
    Effect.gen(function* () {
      yield* resetData();
      yield* seedProject();
      const threads = yield* ProjectionThreadRepository;
      yield* threads.upsert({
        threadId: ThreadId.makeUnsafe("stale-chat"),
        projectId,
        title: "stale-chat",
        purpose: "standard",
        elevatorSummary: "stale-chat",
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
        updatedAt: now,
        lastActivityAt: now,
        archivedAt: null,
        pinnedAt: null,
        deletingAt: null,
        deletedAt: null,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('stale-user', 'stale-chat', 'user', 'old', 0, ${oldAt}, ${oldAt})
      `;
      yield* sql`
        UPDATE projection_threads SET queued_prompts_json = 'not-json' WHERE thread_id = 'stale-chat'
      `;
      const repository = yield* ThreadRetentionRepository;
      const preview = yield* repository.preview(cutoffAt);
      assert.equal(preview.eligibleCount, 1);
      assert.equal(preview.oldestEligibleActivityAt, oldAt);
      assert.deepEqual(yield* repository.selectNextPage({ cutoffAt, limit: 10 }), [
        { threadId: ThreadId.makeUnsafe("stale-chat"), lastActivityAt: oldAt },
      ]);
    }),
  );

  it.effect("previews despite invalid attachment JSON on an eligible thread", () =>
    Effect.gen(function* () {
      yield* resetData();
      yield* seedProject();
      const threads = yield* ProjectionThreadRepository;
      yield* threads.upsert({
        threadId: ThreadId.makeUnsafe("bad-json"),
        projectId,
        title: "bad-json",
        purpose: "standard",
        elevatorSummary: "bad-json",
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
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at
        ) VALUES ('bad-attach', 'bad-json', 'user', 'old', '{', 0, ${oldAt}, ${oldAt})
      `;
      const preview = yield* (yield* ThreadRetentionRepository).preview(cutoffAt);
      assert.equal(preview.eligibleCount, 1);
    }),
  );
});
