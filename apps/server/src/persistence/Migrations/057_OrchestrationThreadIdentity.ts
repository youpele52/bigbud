import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { forEachEventSequenceChunk } from "./EventSequenceChunks.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_thread_identity (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      created_sequence INTEGER NOT NULL
    )
  `;
  // Ascending sequence chunks keep the earliest `thread.created` per thread, as one full scan did.
  yield* forEachEventSequenceChunk(
    ({ from, to }) => sql`
      INSERT INTO orchestration_thread_identity (thread_id, project_id, created_sequence)
      SELECT stream_id, json_extract(payload_json, '$.projectId'), sequence
      FROM orchestration_events
      WHERE sequence BETWEEN ${from} AND ${to}
        AND aggregate_kind = 'thread'
        AND event_type = 'thread.created'
        AND json_extract(payload_json, '$.projectId') IS NOT NULL
      ORDER BY sequence
      ON CONFLICT (thread_id) DO NOTHING
    `,
  );
});
