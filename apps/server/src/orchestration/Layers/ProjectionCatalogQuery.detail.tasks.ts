import type { OrchestrationTask } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { compareTaskOrder } from "@bigbud/shared/providerRuntime";
import { Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ThreadDetailTaskDbRow } from "./ProjectionCatalogQuery.schemas.ts";
import { demotePersistedTaskActivity } from "./ProviderRuntimeIngestion.tasks.identity.ts";

const ThreadTaskPageRequest = Schema.Struct({
  threadId: Schema.String,
  limit: Schema.Number,
});

export function makeThreadDetailTaskReaders(sql: SqlClient.SqlClient) {
  const readActiveTasks = SqlSchema.findAll({
    Request: ThreadTaskPageRequest,
    Result: ThreadDetailTaskDbRow,
    execute: ({ threadId, limit }) => sql`
      SELECT task_json AS task
      FROM projection_thread_tasks
      WHERE thread_id = ${threadId}
        AND COALESCE(json_extract(task_json, '$.kind'), 'task') = 'task'
        AND json_extract(task_json, '$.status') IN ('pending', 'inProgress')
      ORDER BY created_at ASC, task_id ASC
      LIMIT ${limit}
    `,
  });
  const readRecentAgents = SqlSchema.findAll({
    Request: ThreadTaskPageRequest,
    Result: ThreadDetailTaskDbRow,
    execute: ({ threadId, limit }) => sql`
      SELECT task_json AS task
      FROM projection_thread_tasks
      WHERE thread_id = ${threadId}
        AND json_extract(task_json, '$.kind') = 'providerSubagent'
      ORDER BY updated_at DESC, task_id ASC
      LIMIT ${limit}
    `,
  });
  return { readActiveTasks, readRecentAgents };
}

export function normalizeRecentAgents(
  rows: ReadonlyArray<{ readonly task: OrchestrationTask }>,
  limit: number,
) {
  return rows
    .slice(0, limit)
    .map(({ task }) => demotePersistedTaskActivity(task))
    .toSorted(compareTaskOrder);
}
