import { LOCAL_EXECUTION_TARGET_ID, ProjectId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const insertThread = (sql: SqlClient.SqlClient, threadId: string, projectId: string) => sql`
  INSERT INTO projection_threads (
    thread_id, project_id, title, model_selection_json, runtime_mode,
    interaction_mode, created_at, updated_at
  ) VALUES (${threadId}, ${projectId}, 'Thread', '{"provider":"codex","model":"test"}',
    'full-access', 'default', 'now', 'now')
`;

layer("ProjectionProjectRepository deletion", (it) => {
  it.effect("removes owned operational rows without touching global or other-project rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projects = yield* ProjectionProjectRepository;
      const owned = ProjectId.makeUnsafe("delete-project");
      const other = ProjectId.makeUnsafe("other-project");
      yield* projects.upsert({
        projectId: owned,
        title: "Delete project",
        providerRuntimeExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
        workspaceExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
        executionTargetId: LOCAL_EXECUTION_TARGET_ID,
        workspaceRoot: "/tmp/delete-project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        deletingAt: null,
        deletedAt: null,
      });
      yield* projects.upsert({
        projectId: other,
        title: "Other project",
        providerRuntimeExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
        workspaceExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
        executionTargetId: LOCAL_EXECUTION_TARGET_ID,
        workspaceRoot: "/tmp/other-project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        deletingAt: null,
        deletedAt: null,
      });
      yield* insertThread(sql, "delete-project-thread", owned);
      yield* insertThread(sql, "other-project-thread", other);
      yield* sql`
        INSERT INTO projection_notes (note_id, project_id, title, content, created_at, updated_at)
        VALUES ('notes/delete.md', ${owned}, 'Owned', 'owned', 'now', 'now'),
          ('notes/other.md', ${other}, 'Other', 'other', 'now', 'now'),
          ('notes/global.md', NULL, 'Global', 'global', 'now', 'now')
      `;
      yield* sql`
        INSERT INTO automation_schedules (
          automation_id, project_id, target_thread_id, title, prompt, cron_expression,
          timezone, created_at, updated_at
        ) VALUES ('schedule-owned', ${owned}, 'delete-project-thread', 'Owned', 'prompt', '* * * * *', 'UTC', 'now', 'now'),
          ('schedule-other', ${other}, 'other-project-thread', 'Other', 'prompt', '* * * * *', 'UTC', 'now', 'now')
      `;
      yield* sql`
        INSERT INTO remote_agent_restart_requests
          (request_id, project_id, target_id, route_json, phase, updated_at)
        VALUES ('restart-owned', ${owned}, 'target', '{}', 'queued', 1),
          ('restart-other', ${other}, 'target', '{}', 'queued', 1)
      `;
      yield* sql`
        INSERT INTO orchestration_bootstrap_recipes
          (parent_command_id, recipe_version, project_id, project_cwd, base_branch, created_at)
        VALUES ('recipe-owned', 'bootstrap/v1', ${owned}, '/tmp/owned', 'main', 'now'),
          ('recipe-other', 'bootstrap/v1', ${other}, '/tmp/other', 'main', 'now')
      `;
      yield* sql`
        INSERT INTO thread_delegations (
          delegation_id, caller_thread_id, source_message_id, invocation_id, root_delegation_id,
          depth, target_kind, target_project_id, child_thread_id, child_turn_id, created_project_id,
          state, created_at, updated_at
        ) VALUES
          ('delegation-target-owned', 'other-project-thread', 'message-1', 'invocation-1',
            'delegation-target-owned', 0, 'project', ${owned}, 'delete-project-thread', 'turn-1', ${other}, 'completed', 'now', 'now'),
          ('delegation-created-owned', 'delete-project-thread', 'message-2', 'invocation-2',
            'delegation-created-owned', 0, 'project', ${other}, 'other-project-thread', 'turn-2', ${owned}, 'completed', 'now', 'now')
      `;

      yield* projects.deleteById({ projectId: owned });

      assert.deepEqual(yield* sql`SELECT project_id FROM projection_projects ORDER BY project_id`, [
        { project_id: "__chats__" },
        { project_id: other },
      ]);
      assert.deepEqual(yield* sql`SELECT note_id FROM projection_notes ORDER BY note_id`, [
        { note_id: "notes/global.md" },
        { note_id: "notes/other.md" },
      ]);
      assert.deepEqual(yield* sql`SELECT automation_id FROM automation_schedules`, [
        { automation_id: "schedule-other" },
      ]);
      assert.deepEqual(yield* sql`SELECT request_id FROM remote_agent_restart_requests`, [
        { request_id: "restart-other" },
      ]);
      assert.deepEqual(yield* sql`SELECT parent_command_id FROM orchestration_bootstrap_recipes`, [
        { parent_command_id: "recipe-other" },
      ]);
      assert.deepEqual(
        yield* sql`SELECT delegation_id, target_project_id, created_project_id FROM thread_delegations ORDER BY delegation_id`,
        [
          {
            delegation_id: "delegation-created-owned",
            target_project_id: other,
            created_project_id: null,
          },
          {
            delegation_id: "delegation-target-owned",
            target_project_id: null,
            created_project_id: other,
          },
        ],
      );
      assert.isNotNull(
        yield* projects.getById({ projectId: ProjectId.makeUnsafe("other-project") }),
      );
    }),
  );
});
