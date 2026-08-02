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
const callerThreadId = ThreadId.makeUnsafe("caller");

const seed = Effect.fn("seedListThreadsCatalog")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM projection_thread_messages`;
  yield* sql`DELETE FROM projection_thread_sessions`;
  yield* sql`DELETE FROM projection_turns`;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM projection_projects`;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at,
      last_used_at, deleting_at, deleted_at
    ) VALUES
      ('project-list', 'Persisted project', '/list', '[]', '2026-01-01', '2026-01-01',
       '2026-01-01', NULL, NULL),
      ('project-other', 'Other persisted project', '/other', '[]', '2026-01-01',
       '2026-01-01', '2026-01-01', NULL, NULL)
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
      interaction_mode, created_at, updated_at, archived_at, pinned_at, deleting_at,
      deleted_at, parent_thread_id
    ) VALUES
      ('caller', 'project-list', 'Caller', 'standard',
       '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
       '2026-01-01', '2026-01-05', NULL, NULL, NULL, NULL, NULL),
      ('active-old', 'project-list', 'Active old', 'standard',
       '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
       '2026-01-01', '2026-01-02', NULL, NULL, NULL, NULL, 'caller'),
      ('archived', 'project-list', 'Archived', 'standard',
       '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
       '2026-01-01', '2026-01-04', '2026-01-04', NULL, NULL, NULL, NULL),
      ('deleting-active', 'project-list', 'Deleting active', 'standard',
       '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
       '2026-01-01', '2026-01-06', NULL, NULL, '2026-01-06', NULL, NULL),
      ('deleting-archived', 'project-list', 'Deleting archived', 'standard',
       '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
       '2026-01-01', '2026-01-07', '2026-01-06', NULL, '2026-01-07', NULL, NULL),
      ('deleted', 'project-list', 'Deleted', 'standard',
       '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
       '2026-01-01', '2026-01-08', NULL, NULL, NULL, '2026-01-08', NULL),
      ('other-thread', 'project-other', 'Other thread', 'standard',
       '{"provider":"codex","model":"gpt-5"}', 'full-access', 'default',
       '2026-01-01', '2026-01-03', NULL, NULL, NULL, NULL, NULL)
  `;
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, role, text, is_streaming, created_at, updated_at
    ) VALUES
      ('m1', 'active-old', 'user', 'Question', 0, '2026-01-01', '2026-01-01'),
      ('m2', 'active-old', 'assistant', 'The persisted answer.', 0,
       '2026-01-02', '2026-01-02')
  `;
});

layer("ProjectionCatalogQuery listThreads", (it) => {
  it.effect("returns authoritative active count, ordering, pagination, and excerpt", () =>
    Effect.gen(function* () {
      yield* seed();
      const query = yield* ProjectionCatalogQuery;
      const result = yield* query.listThreads({
        callerThreadId,
        status: "active",
        limit: 1,
        includeExcerpt: true,
      });
      assert.equal(result.projectTitle, "Persisted project");
      assert.equal(result.totalCount, 2);
      assert.deepEqual(
        result.threads.map((thread) => thread.threadId),
        ["caller"],
      );

      const full = yield* query.listThreads({
        callerThreadId,
        status: "active",
        limit: 20,
        includeExcerpt: true,
      });
      assert.deepEqual(
        full.threads.map((thread) => thread.threadId),
        ["caller", "active-old"],
      );
      assert.equal(full.threads[1]?.parentThreadId, "caller");
      assert.equal(full.threads[1]?.messageCount, 2);
      assert.equal(full.threads[1]?.lastAssistantExcerpt, "The persisted answer.");
    }),
  );

  it.effect("keeps deleting semantics explicit for archived and all", () =>
    Effect.gen(function* () {
      yield* seed();
      const query = yield* ProjectionCatalogQuery;
      const archived = yield* query.listThreads({
        callerThreadId,
        status: "archived",
        limit: 20,
        includeExcerpt: false,
      });
      assert.deepEqual(
        archived.threads.map((thread) => thread.threadId),
        ["deleting-archived", "archived"],
      );
      const all = yield* query.listThreads({
        callerThreadId,
        status: "all",
        limit: 20,
        includeExcerpt: false,
      });
      assert.equal(all.totalCount, 5);
      assert.equal(
        all.threads.some((thread) => thread.threadId === "deleting-active"),
        true,
      );
      assert.equal("lastAssistantExcerpt" in (all.threads[0] ?? {}), false);
    }),
  );

  it.effect("resolves explicit persisted projects and rejects missing caller or project", () =>
    Effect.gen(function* () {
      yield* seed();
      const query = yield* ProjectionCatalogQuery;
      const other = yield* query.listThreads({
        callerThreadId,
        projectId: ProjectId.makeUnsafe("project-other"),
        status: "active",
        limit: 20,
        includeExcerpt: false,
      });
      assert.deepEqual(
        other.threads.map((thread) => thread.threadId),
        ["other-thread"],
      );
      const missingProject = yield* query.listThreads({
        callerThreadId,
        projectId: ProjectId.makeUnsafe("missing"),
        status: "active",
        limit: 20,
        includeExcerpt: false,
      });
      assert.equal(missingProject.projectId, null);
      const missingCaller = yield* query.listThreads({
        callerThreadId: ThreadId.makeUnsafe("missing"),
        status: "active",
        limit: 20,
        includeExcerpt: false,
      });
      assert.equal(missingCaller.callerResolved, false);

      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_projects SET deleted_at = '2026-01-09' WHERE project_id = 'project-other'`;
      const deletedProject = yield* query.listThreads({
        callerThreadId,
        projectId: ProjectId.makeUnsafe("project-other"),
        status: "active",
        limit: 20,
        includeExcerpt: false,
      });
      assert.equal(deletedProject.projectId, null);
      yield* sql`UPDATE projection_threads SET deleted_at = '2026-01-09' WHERE thread_id = 'caller'`;
      const deletedCaller = yield* query.listThreads({
        callerThreadId,
        status: "active",
        limit: 20,
        includeExcerpt: false,
      });
      assert.equal(deletedCaller.callerResolved, false);
    }),
  );

  it.effect("derives activity and completion flags from the canonical workflow status", () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionCatalogQuery;
      yield* sql`
        UPDATE projection_threads SET latest_turn_id = 'turn-1' WHERE thread_id = 'active-old'
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id, turn_id, state, requested_at, started_at, completed_at,
          checkpoint_files_json
        ) VALUES (
          'active-old', 'turn-1', 'completed', '2026-01-01', '2026-01-01',
          '2026-01-02', '[]'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, runtime_mode, active_turn_id, reason,
          last_error, updated_at
        ) VALUES (
          'active-old', 'running', 'codex', 'full-access', 'turn-other', NULL,
          NULL, '2026-01-02'
        )
      `;

      const readStatus = Effect.fn("readProjectedWorkflowStatus")(function* () {
        const result = yield* query.listThreads({
          callerThreadId,
          status: "active",
          limit: 20,
          includeExcerpt: false,
        });
        const thread = result.threads.find((candidate) => candidate.threadId === "active-old");
        assert.isDefined(thread);
        return thread;
      });
      const assertStatus = Effect.fn("assertProjectedWorkflowStatus")(function* (
        expected: readonly [string, boolean, boolean],
      ) {
        const thread = yield* readStatus();
        assert.deepEqual(
          [thread.workflowStatus, thread.isAgentActive, thread.isWorkflowComplete],
          expected,
        );
      });

      yield* assertStatus(["working", true, false]);
      yield* sql`
        UPDATE projection_threads SET pending_approval_count = 1 WHERE thread_id = 'active-old'
      `;
      yield* assertStatus(["awaiting_approval", false, false]);
      yield* sql`
        UPDATE projection_threads SET pending_approval_count = 0 WHERE thread_id = 'active-old'
      `;
      yield* sql`
        UPDATE projection_thread_sessions SET status = 'error' WHERE thread_id = 'active-old'
      `;
      yield* assertStatus(["error", false, false]);
      yield* sql`
        UPDATE projection_thread_sessions SET status = 'ready', active_turn_id = NULL
        WHERE thread_id = 'active-old'
      `;
      yield* assertStatus(["workflow_complete", false, true]);
      yield* sql`DELETE FROM projection_thread_sessions WHERE thread_id = 'active-old'`;
      yield* assertStatus(["workflow_complete", false, true]);
      yield* sql`
        UPDATE projection_threads SET interaction_mode = 'plan',
          has_actionable_proposed_plan = 1 WHERE thread_id = 'active-old'
      `;
      yield* assertStatus(["plan_ready", false, false]);
      yield* sql`
        UPDATE projection_turns SET started_at = NULL WHERE thread_id = 'active-old'
      `;
      yield* assertStatus(["idle", false, false]);
    }),
  );

  it.effect("uses stable tie ordering and excludes streaming replies from truncated excerpts", () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const query = yield* ProjectionCatalogQuery;
      yield* sql`
        UPDATE projection_threads SET updated_at = '2026-01-05' WHERE thread_id = 'active-old'
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('m3', 'active-old', 'assistant', ${"x".repeat(250)}, 0, '2026-01-03', '2026-01-03'),
          ('m4', 'active-old', 'assistant', 'unfinished', 1, '2026-01-04', '2026-01-04')
      `;
      const result = yield* query.listThreads({
        callerThreadId,
        status: "active",
        limit: 20,
        includeExcerpt: true,
      });
      assert.deepEqual(
        result.threads.map((thread) => thread.threadId),
        ["active-old", "caller"],
      );
      assert.equal(result.threads[0]?.lastAssistantExcerpt, `${"x".repeat(237)}...`);
    }),
  );
});
