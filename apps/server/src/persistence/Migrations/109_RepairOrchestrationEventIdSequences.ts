import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    WITH canonical_identity AS (
      SELECT event_id, MIN(sequence) AS sequence
      FROM (
        SELECT event_id, sequence FROM orchestration_events
        UNION ALL
        SELECT event_id, sequence FROM orchestration_event_gaps
      )
      GROUP BY event_id
      HAVING MIN(sequence) = MAX(sequence)
    )
    UPDATE orchestration_event_ids AS ledger
    SET sequence = (
      SELECT canonical.sequence FROM canonical_identity AS canonical
      WHERE canonical.event_id = ledger.event_id
    )
    WHERE EXISTS (
      SELECT 1 FROM canonical_identity AS canonical
      WHERE canonical.event_id = ledger.event_id AND canonical.sequence <> ledger.sequence
    )
  `;
});
