import { BUILT_IN_CHATS_PROJECT_ID, BUILT_IN_CHATS_PROJECT_TITLE } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("022_ProjectionProjectsNullableWorkspaceRoot", (it) => {
  it.effect(
    "preserves existing project rows, makes workspace roots nullable, and inserts built-in Chats",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 21 });

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          scripts_json,
          created_at,
          updated_at,
          deleted_at,
          default_model_selection_json
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL,
          '{"provider":"codex","model":"gpt-5.4"}'
        )
      `;

        yield* runMigrations({ toMigrationInclusive: 22 });

        const projectRows = yield* sql<{
          readonly projectId: string;
          readonly title: string;
          readonly workspaceRoot: string | null;
          readonly defaultModelSelection: string | null;
        }>`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        ORDER BY project_id
      `;
        assert.deepStrictEqual(projectRows, [
          {
            projectId: BUILT_IN_CHATS_PROJECT_ID,
            title: BUILT_IN_CHATS_PROJECT_TITLE,
            workspaceRoot: null,
            defaultModelSelection: null,
          },
          {
            projectId: "project-1",
            title: "Project 1",
            workspaceRoot: "/tmp/project-1",
            defaultModelSelection: '{"provider":"codex","model":"gpt-5.4"}',
          },
        ]);

        const workspaceRootColumn = yield* sql<{
          readonly cid: number;
          readonly name: string;
          readonly type: string;
          readonly notnull: number;
          readonly dflt_value: string | null;
          readonly pk: number;
        }>`
        PRAGMA table_info('projection_projects')
      `;
        const workspaceRootInfo = workspaceRootColumn.find(
          (column) => column.name === "workspace_root",
        );
        assert.ok(workspaceRootInfo);
        assert.strictEqual(workspaceRootInfo.notnull, 0);

        const projectIndexes = yield* sql<{
          readonly name: string;
        }>`
        PRAGMA index_list('projection_projects')
      `;
        assert.ok(
          projectIndexes.some((index) => index.name === "idx_projection_projects_updated_at"),
        );
        assert.ok(
          projectIndexes.some(
            (index) => index.name === "idx_projection_projects_workspace_root_deleted_at",
          ),
        );
      }),
  );
});
