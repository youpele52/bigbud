import type { ProjectId } from "@bigbud/contracts";
import { Effect, Option } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import type { OrchestrationEventStoreShape } from "../Services/OrchestrationEventStore.ts";

export function makeThreadIdentityQueries(sql: SqlClient.SqlClient) {
  const findThreadProjectId: OrchestrationEventStoreShape["findThreadProjectId"] = (threadId) =>
    sql<{ readonly projectId: ProjectId | null }>`
      SELECT COALESCE(
        (SELECT json_extract(payload_json, '$.projectId')
         FROM orchestration_events
         WHERE aggregate_kind = 'thread'
           AND stream_id = ${threadId}
           AND event_type = 'thread.created'
         ORDER BY sequence DESC LIMIT 1),
        (SELECT project_id FROM orchestration_thread_identity WHERE thread_id = ${threadId})
      ) AS "projectId"
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0]?.projectId)),
      Effect.mapError(toPersistenceSqlError("OrchestrationEventStore.findThreadProjectId:query")),
    );

  const findThreadOwnershipEvidence: OrchestrationEventStoreShape["findThreadOwnershipEvidence"] = (
    threadId,
  ) =>
    sql<{
      readonly projectId: ProjectId | null;
      readonly latestCreatedSequence: number | null;
      readonly deletionSequence: number | null;
      readonly deletedAt: string | null;
    }>`
      WITH ownership_ids AS (
        SELECT thread_id AS thread_id
        FROM orchestration_thread_identity
        WHERE thread_id = ${threadId}
        UNION
        SELECT entity_id AS thread_id
        FROM orchestration_deletion_markers
        WHERE entity_kind = 'thread' AND entity_id = ${threadId}
      )
      SELECT identity.project_id AS "projectId",
        identity.created_sequence AS "latestCreatedSequence",
        marker.deletion_sequence AS "deletionSequence", marker.deleted_at AS "deletedAt"
      FROM ownership_ids AS ownership
      LEFT JOIN orchestration_thread_identity AS identity
        ON identity.thread_id = ownership.thread_id
      LEFT JOIN orchestration_deletion_markers AS marker
        ON marker.entity_kind = 'thread' AND marker.entity_id = ownership.thread_id
      LIMIT 1
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError(
        toPersistenceSqlError("OrchestrationEventStore.findThreadOwnershipEvidence:query"),
      ),
    );

  return { findThreadOwnershipEvidence, findThreadProjectId };
}
