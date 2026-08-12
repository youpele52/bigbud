import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";

const layer = it.layer(
  ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionCatalogQuery", (it) => {
  it.effect("pages projects by durable last-used timestamp and stable id", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionCatalogQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at,
          last_used_at, deleting_at, deleted_at
        ) VALUES
          ('project-a', 'A', '/a', '[]', '2026-01-01', '2026-01-01', '2026-01-03', NULL, NULL),
          ('project-b', 'B', '/b', '[]', '2026-01-01', '2026-01-01', '2026-01-03', NULL, NULL),
          ('project-c', 'C', '/c', '[]', '2026-01-01', '2026-01-01', '2026-01-02', NULL, NULL)
      `;

      const first = yield* query.getStartupProjectCatalog({ scope: "local", limit: 2 });
      assert.deepEqual(
        first.projects.map((project) => project.id),
        ["project-a", "project-b"],
      );
      assert.equal(first.projects[0]?.workspaceExecutionTargetId, "local");
      assert.deepEqual(first.nextCursor, {
        lastUsedAt: "2026-01-03",
        projectId: "project-b",
      });

      const defaultPage = yield* query.getStartupProjectCatalog({ scope: "local" });
      assert.deepEqual(
        defaultPage.projects.map((project) => project.id),
        ["project-a"],
      );

      const prioritized = yield* query.getStartupProjectCatalog({
        scope: "local",
        limit: 2,
        priorityProjectId: ProjectId.makeUnsafe("project-c"),
      });
      assert.deepEqual(
        prioritized.projects.map((project) => project.id),
        ["project-c", "project-a"],
      );

      const second = yield* query.getStartupProjectCatalog({
        scope: "local",
        limit: 2,
        cursor: first.nextCursor,
      });
      assert.deepEqual(
        second.projects.map((project) => project.id),
        ["project-c"],
      );
      assert.equal(second.nextCursor, undefined);
    }),
  );

  it.effect("returns bounded lightweight thread summaries with operational flags", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionCatalogQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_pending_approvals`;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, purpose, elevator_summary,
          model_selection_json, runtime_mode, interaction_mode,
          provider_runtime_execution_target_id, workspace_execution_target_id, execution_target_id,
          branch, worktree_path, latest_turn_id,
          created_at, updated_at, archived_at, pinned_at, deleted_at
        ) VALUES
          ('thread-a', 'project-a', 'A', 'standard', 'Summary A',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           'ssh:provider', 'ssh:workspace', 'ssh:legacy', 'feature/remote', '/worktrees/remote', NULL,
           '2026-01-01', '2026-01-03', NULL, '2026-01-03', NULL),
          ('thread-b', 'project-a', 'B', 'standard', 'Summary B',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           'local', 'local', 'local', NULL, NULL, NULL,
           '2026-01-01', '2026-01-02', NULL, NULL, NULL)
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, updated_at
        ) VALUES ('thread-a', 'running', 'codex', '2026-01-03')
      `;
      yield* sql`
         INSERT INTO projection_pending_approvals (
          request_id, thread_id, status, created_at
         ) VALUES ('approval-1', 'thread-a', 'pending', '2026-01-03')
       `;
      yield* sql`
         INSERT INTO projection_thread_messages (
           message_id, thread_id, role, text, is_streaming, created_at, updated_at
         ) VALUES
           ('assistant-message', 'thread-a', 'assistant', 'Hello', 0, '2026-01-04', '2026-01-04'),
           ('old-user-message', 'thread-a', 'user', 'Earlier request', 0, '2026-01-05', '2026-01-05'),
           ('latest-user-message', 'thread-a', 'user', 'Latest request', 0, '2026-01-06', '2026-01-06')
       `;

      const result = yield* query.getProjectThreadSummaries({
        projectId: ProjectId.makeUnsafe("project-a"),
        limit: 1,
      });
      assert.equal(result.threads.length, 1);
      assert.equal(result.threads[0]?.id, "thread-a");
      assert.equal(result.threads[0]?.pinnedAt, "2026-01-03");
      assert.equal(result.threads[0]?.sessionStatus, "running");
      assert.equal(result.threads[0]?.isAwaitingApproval, true);
      assert.equal(result.threads[0]?.providerRuntimeExecutionTargetId, "ssh:provider");
      assert.equal(result.threads[0]?.workspaceExecutionTargetId, "ssh:workspace");
      assert.equal(result.threads[0]?.executionTargetId, "ssh:legacy");
      assert.equal(result.threads[0]?.branch, "feature/remote");
      assert.equal(result.threads[0]?.worktreePath, "/worktrees/remote");
      assert.equal(result.threads[0]?.createdAt, "2026-01-01");
      assert.equal(result.threads[0]?.latestUserMessageAt, "2026-01-06");
      assert.equal("messages" in (result.threads[0] ?? {}), false);
      assert.deepEqual(result.nextCursor, {
        updatedAt: "2026-01-03",
        threadId: "thread-a",
      });

      const prioritized = yield* query.getProjectThreadSummaries({
        projectId: ProjectId.makeUnsafe("project-a"),
        priorityThreadId: ThreadId.makeUnsafe("thread-b"),
        limit: 1,
      });
      assert.equal(prioritized.threads[0]?.id, "thread-b");
    }),
  );

  it.effect("filters project catalogs by workspace execution target", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionCatalogQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_execution_target_id, workspace_root, scripts_json,
          created_at, updated_at, last_used_at, deleting_at, deleted_at
        ) VALUES
          ('local-project', 'Local', 'local', '/local', '[]',
           '2026-01-01', '2026-01-01', '2026-01-02', NULL, NULL),
          ('remote-project', 'Remote', 'ssh:workspace', '/remote', '[]',
           '2026-01-01', '2026-01-01', '2026-01-03', NULL, NULL)
      `;

      const [local, remote] = yield* Effect.all([
        query.getStartupProjectCatalog({ scope: "local" }),
        query.getStartupProjectCatalog({ scope: "remote" }),
      ]);

      assert.deepEqual(
        local.projects.map((project) => project.id),
        ["local-project"],
      );
      assert.deepEqual(
        remote.projects.map((project) => project.id),
        ["remote-project"],
      );
    }),
  );

  it.effect("clamps oversized project catalog pages", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionCatalogQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_projects`;
      yield* Effect.forEach(
        Array.from({ length: 21 }, (_, index) => index),
        (index) =>
          sql`
            INSERT INTO projection_projects (
              project_id, title, workspace_root, scripts_json, created_at, updated_at,
              last_used_at, deleting_at, deleted_at
            ) VALUES (
              ${`project-${String(index).padStart(2, "0")}`},
              ${`Project ${index}`},
              ${`/project-${index}`},
              '[]', '2026-01-01', '2026-01-01', '2026-01-01', NULL, NULL
            )
          `,
        { discard: true },
      );

      const result = yield* query.getStartupProjectCatalog({ scope: "local", limit: 100 });
      assert.equal(result.projects.length, 20);
      assert.notEqual(result.nextCursor, undefined);
    }),
  );

  it.effect("returns null when a thread has no user messages", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionCatalogQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, deleted_at
        ) VALUES (
          'assistant-only-thread', 'project-a', 'Assistant only', 'standard',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access',
          'default', '2026-01-01', '2026-01-03', NULL, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('assistant-only-message', 'assistant-only-thread', 'assistant', 'Hello', 0,
          '2026-01-02', '2026-01-02')
      `;

      const result = yield* query.getProjectThreadSummaries({
        projectId: ProjectId.makeUnsafe("project-a"),
      });

      assert.equal(result.threads[0]?.latestUserMessageAt, null);
      assert.equal(result.threads[0]?.createdAt, "2026-01-01");
    }),
  );

  it.effect("returns bounded global recent chats and pins with deduplicated summaries", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionCatalogQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_thread_messages`;
      yield* sql`DELETE FROM projection_threads`;
      yield* Effect.forEach(
        Array.from({ length: 7 }, (_, index) => index),
        (index) => sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
            interaction_mode, created_at, updated_at, archived_at, pinned_at, deleting_at, deleted_at
          ) VALUES (
            ${`chat-${index}`}, '__chats__', ${`Chat ${index}`}, 'standard',
            '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
            ${`2026-01-0${index + 1}`}, ${`2026-01-0${index + 1}`}, NULL,
            ${index === 0 ? "2026-02-01" : null}, NULL, NULL
          )
        `,
        { discard: true },
      );
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, pinned_at, deleting_at, deleted_at
        ) VALUES
          ('project-pin', 'project-outside-page', 'Pinned', 'standard',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           '2025-01-01', '2025-01-01', NULL, '2026-02-02', NULL, NULL),
          ('deleting-pin', 'project-a', 'Deleting', 'standard',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           '2026-01-01', '2026-01-01', NULL, '2026-02-03', '2026-02-04', NULL)
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES ('old-chat-new-message', 'chat-0', 'user', 'Recent', 0,
          '2026-03-01', '2026-03-01')
      `;

      const result = yield* query.getSidebarThreadCatalog();

      assert.equal(result.recentThreadIds.includes(ThreadId.makeUnsafe("chat-0")), true);
      assert.equal(result.recentThreadIds.includes(ThreadId.makeUnsafe("chat-6")), true);
      assert.deepEqual(result.pinnedThreadIds.map(String), ["project-pin", "chat-0"]);
      assert.equal(result.threads.filter((thread) => thread.id === "chat-0").length, 1);
      assert.equal(
        result.threads.some((thread) => thread.id === "deleting-pin"),
        false,
      );
    }),
  );
});
