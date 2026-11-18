import { Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ProjectionProjectDbRowSchema } from "./ProjectionSnapshotQuerySql.schemas.ts";

/** The projected project columns every operational read selects (`p` is the row alias). */
export const projectionProjectColumnsSql = (sql: SqlClient.SqlClient) => sql`
  p.project_id AS "projectId", p.title,
  p.provider_runtime_execution_target_id AS "providerRuntimeExecutionTargetId",
  p.workspace_execution_target_id AS "workspaceExecutionTargetId",
  p.execution_target_id AS "executionTargetId", p.workspace_root AS "workspaceRoot",
  p.workspace_kind AS "workspaceKind", p.previous_workspace_root AS "previousWorkspaceRoot",
  p.default_model_selection_json AS "defaultModelSelection", p.scripts_json AS scripts,
  p.created_at AS "createdAt", p.updated_at AS "updatedAt",
  p.deleting_at AS "deletingAt", p.deleted_at AS "deletedAt"`;

const ProjectRequest = Schema.Struct({ projectId: Schema.String });
const WorkspaceRootRequest = Schema.Struct({ workspaceRoot: Schema.String });

/**
 * Project-scoped reads for hydrating an aggregate the startup window left out: the startup
 * operational state holds only projects with an operational thread, so an idle project (or the
 * settled threads of one) is read from these durable projections on demand.
 */
export function makeProjectOperationalStateSql(sql: SqlClient.SqlClient) {
  const listProjectRowsById = SqlSchema.findAll({
    Request: ProjectRequest,
    Result: ProjectionProjectDbRowSchema,
    execute: ({ projectId }) => sql`
      SELECT ${projectionProjectColumnsSql(sql)}
      FROM projection_projects p
      WHERE p.project_id = ${projectId}
    `,
  });

  const listProjectThreadIds = SqlSchema.findAll({
    Request: ProjectRequest,
    Result: Schema.Struct({ threadId: Schema.String }),
    execute: ({ projectId }) => sql`
      SELECT thread_id AS "threadId"
      FROM projection_threads
      WHERE project_id = ${projectId} AND deleted_at IS NULL
      ORDER BY created_at ASC, thread_id ASC
    `,
  });

  const listProjectIdsByWorkspaceRoot = SqlSchema.findAll({
    Request: WorkspaceRootRequest,
    Result: Schema.Struct({ projectId: Schema.String }),
    execute: ({ workspaceRoot }) => sql`
      SELECT project_id AS "projectId"
      FROM projection_projects
      WHERE workspace_root = ${workspaceRoot} AND deleted_at IS NULL
      ORDER BY created_at ASC, project_id ASC
    `,
  });

  return { listProjectRowsById, listProjectThreadIds, listProjectIdsByWorkspaceRoot };
}
