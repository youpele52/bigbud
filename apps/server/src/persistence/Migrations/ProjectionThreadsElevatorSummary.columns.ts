import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export const ensureProjectionThreadsElevatorSummaryColumns = Effect.fn(
  "ensureProjectionThreadsElevatorSummaryColumns",
)(function* (sql: SqlClient.SqlClient) {
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (columns.length === 0) {
    return;
  }

  if (!columns.some((column) => column.name === "elevator_summary")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN elevator_summary TEXT
    `;
  }

  if (!columns.some((column) => column.name === "elevator_summary_message_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN elevator_summary_message_count INTEGER NOT NULL DEFAULT 0
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET
      elevator_summary = COALESCE(NULLIF(TRIM(elevator_summary), ''), title),
      elevator_summary_message_count = COALESCE(elevator_summary_message_count, 0)
  `;
});
