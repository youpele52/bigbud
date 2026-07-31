import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_created_stable
    ON projection_thread_messages(thread_id, created_at DESC, message_id ASC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_turn_sequence
    ON projection_thread_activities(thread_id, turn_id, sequence DESC, activity_id ASC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_pending_approvals_thread_status_created
    ON projection_pending_approvals(thread_id, status, created_at ASC, request_id ASC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_checkpoint_stable
    ON projection_turns(thread_id, checkpoint_turn_count DESC, turn_id ASC)
    WHERE checkpoint_turn_count IS NOT NULL
  `;
});
