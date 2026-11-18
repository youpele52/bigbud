import { Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { operationalThreadPredicateSql } from "./ProjectionOperationalStateQuery.sql.ts";

const ThreadRequest = Schema.Struct({ threadId: Schema.String });

/**
 * Per-thread reads for read-model residency: the eviction check and subtree hydration. Both are
 * keyed by one thread id, so a sweep or a deletion never scans every projected thread.
 */
export function makeThreadResidencySql(sql: SqlClient.SqlClient) {
  /**
   * One row when the thread is operational by the startup predicate, holds a worktree runtime
   * lease (terminal, shell, provider) or a browser / computer-use activity lease, or has a
   * provider turn admission that is not terminal.
   */
  const findOperationalThread = SqlSchema.findAll({
    Request: ThreadRequest,
    Result: Schema.Struct({ threadId: Schema.String }),
    execute: ({ threadId }) => sql`
      SELECT t.thread_id AS "threadId"
      FROM projection_threads t
      WHERE t.thread_id = ${threadId}
        AND (
          (${operationalThreadPredicateSql(sql)})
          OR EXISTS (SELECT 1 FROM worktree_runtime_leases l WHERE l.thread_id = t.thread_id)
          OR EXISTS (SELECT 1 FROM thread_activity_leases a WHERE a.thread_id = t.thread_id)
          OR EXISTS (
            SELECT 1 FROM provider_turn_admissions pa
            WHERE pa.owner_thread_id = t.thread_id AND pa.state <> 'terminal'
          )
        )
      LIMIT 1
    `,
  });

  /** The root and every descendant that is not deleted, following `parent_thread_id`. */
  const listThreadSubtreeIds = SqlSchema.findAll({
    Request: ThreadRequest,
    Result: Schema.Struct({ threadId: Schema.String }),
    execute: ({ threadId }) => sql`
      WITH RECURSIVE subtree(thread_id) AS (
        SELECT thread_id FROM projection_threads
        WHERE thread_id = ${threadId} AND deleted_at IS NULL
        UNION
        SELECT child.thread_id FROM projection_threads child
        JOIN subtree parent ON child.parent_thread_id = parent.thread_id
        WHERE child.deleted_at IS NULL
      )
      SELECT thread_id AS "threadId" FROM subtree
    `,
  });

  return { findOperationalThread, listThreadSubtreeIds };
}
