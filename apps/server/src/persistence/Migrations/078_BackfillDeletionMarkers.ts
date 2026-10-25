import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { forEachEventSequenceChunk } from "./EventSequenceChunks.ts";

/**
 * Older databases can contain projected deleted threads whose deletion marker
 * was introduced after the original event was persisted. Purge jobs require
 * that marker before they can safely finalize, so rebuild only the missing
 * markers from canonical deletion events.
 *
 * The scan runs in sequence chunks with progress. Entities that already had a
 * marker are snapshotted first, so a marker this migration inserts in one
 * chunk is raised to the later maximum by the next chunk, while pre-existing
 * markers are never touched. The result equals one `GROUP BY` over all events.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TABLE IF EXISTS temp.migration_078_existing_markers`;
  yield* sql`
    CREATE TEMP TABLE migration_078_existing_markers (
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      PRIMARY KEY (entity_kind, entity_id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    INSERT INTO migration_078_existing_markers (entity_kind, entity_id)
    SELECT entity_kind, entity_id FROM orchestration_deletion_markers
  `;

  yield* forEachEventSequenceChunk(
    ({ from, to }) => sql`
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
      WHERE sequence BETWEEN ${from} AND ${to}
        AND event_type IN ('thread.deleted', 'project.deleted')
        AND NOT EXISTS (
          SELECT 1
          FROM migration_078_existing_markers AS existing
          WHERE existing.entity_kind = orchestration_events.aggregate_kind
            AND existing.entity_id = orchestration_events.stream_id
        )
      GROUP BY aggregate_kind, stream_id
      ON CONFLICT (entity_kind, entity_id) DO UPDATE SET
        deletion_sequence = MAX(deletion_sequence, excluded.deletion_sequence),
        deleted_at = MAX(deleted_at, excluded.deleted_at)
    `,
  );

  yield* sql`DROP TABLE temp.migration_078_existing_markers`;
});
