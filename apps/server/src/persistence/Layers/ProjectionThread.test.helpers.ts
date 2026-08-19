import type { ThreadId } from "@bigbud/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const insertProjectionThreadParent = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly threadId: ThreadId;
  readonly projectId?: string;
  readonly createdAt?: string;
}) => {
  const createdAt = input.createdAt ?? "2026-08-18T00:00:00.000Z";
  const projectId = input.projectId ?? "fixture-project";
  return input.sql`
    INSERT OR IGNORE INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, created_at, updated_at
    ) VALUES (
      ${input.threadId}, ${projectId}, 'Fixture thread',
      '{"provider":"codex","model":"fixture"}', 'full-access',
      'default', ${createdAt}, ${createdAt}
    )
  `;
};
