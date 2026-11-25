import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE recovered_queue_drafts (
    claim_id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL,
    prompt_json TEXT NOT NULL
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX recovered_queue_drafts_thread ON recovered_queue_drafts(thread_id)`;
  yield* sql`CREATE TABLE recovered_queue_draft_attachments (
    attachment_id TEXT NOT NULL,
    claim_id TEXT NOT NULL REFERENCES recovered_queue_drafts(claim_id) ON DELETE CASCADE,
    PRIMARY KEY (attachment_id, claim_id)
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX recovered_queue_draft_attachments_claim ON recovered_queue_draft_attachments(claim_id)`;
});
