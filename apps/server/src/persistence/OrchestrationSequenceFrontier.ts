import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** The highest sequence represented by retained events, canonical gaps, or prefix retention. */
export function orchestrationSequenceFrontierSql(sql: SqlClient.SqlClient) {
  return sql.unsafe(`MAX(
    COALESCE((SELECT retained_through_sequence
      FROM orchestration_retention_state WHERE singleton_id = 1), 0),
    COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0),
    COALESCE((SELECT MAX(sequence) FROM orchestration_event_gaps), 0)
  )`);
}
