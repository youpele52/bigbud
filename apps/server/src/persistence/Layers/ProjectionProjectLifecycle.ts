import { ProjectId } from "@bigbud/contracts";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "../Errors.ts";

export function isActiveProject(
  sql: Option.Option<SqlClient.SqlClient>,
  projectId: ProjectId,
  forMutation = false,
): Effect.Effect<boolean, PersistenceSqlError> {
  if (Option.isNone(sql)) return Effect.succeed(true);
  return sql.value<{ readonly deletedAt: string | null }>`
    SELECT deleted_at AS "deletedAt"
    FROM projection_projects
    WHERE project_id = ${projectId}
      AND (${forMutation ? 1 : 0} = 0 OR deleting_at IS NULL)
    LIMIT 1
  `.pipe(
    Effect.map((rows) => rows[0]?.deletedAt === null),
    Effect.mapError(
      (cause) =>
        new PersistenceSqlError({
          operation: "projectLifecycle",
          detail: "Failed to read project lifecycle",
          cause,
        }),
    ),
  );
}

export function ensureActiveProject(
  sql: Option.Option<SqlClient.SqlClient>,
  projectId: ProjectId,
  forMutation = false,
): Effect.Effect<void, PersistenceSqlError> {
  return isActiveProject(sql, projectId, forMutation).pipe(
    Effect.flatMap((active) =>
      active
        ? Effect.void
        : Effect.fail(
            new PersistenceSqlError({
              operation: "projectLifecycle",
              detail: "Project is not active",
            }),
          ),
    ),
  );
}
