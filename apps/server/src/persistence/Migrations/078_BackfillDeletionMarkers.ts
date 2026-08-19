import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Older databases can contain projected deleted threads whose deletion marker
 * was introduced after the original event was persisted. Purge jobs require
 * that marker before they can safely finalize, so rebuild only the missing
 * markers from canonical deletion events.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT INTO orchestration_deletion_markers (
      entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
    )
    SELECT
      aggregate_kind,
      stream_id,
      MAX(sequence),
      MAX(occurred_at),
      NULL
    FROM orchestration_events
    WHERE event_type IN ('thread.deleted', 'project.deleted')
      AND NOT EXISTS (
        SELECT 1
        FROM orchestration_deletion_markers AS marker
        WHERE marker.entity_kind = orchestration_events.aggregate_kind
          AND marker.entity_id = orchestration_events.stream_id
      )
    GROUP BY aggregate_kind, stream_id
  `;
});
