import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS projection_message_search
    USING fts5(text, content='projection_thread_messages', content_rowid='rowid', tokenize='trigram')
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_message_search_insert
    AFTER INSERT ON projection_thread_messages WHEN new.is_streaming = 0 BEGIN
      INSERT INTO projection_message_search(rowid, text) VALUES (new.rowid, new.text);
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_message_search_delete
    AFTER DELETE ON projection_thread_messages WHEN old.is_streaming = 0 BEGIN
      INSERT INTO projection_message_search(projection_message_search, rowid, text)
      VALUES ('delete', old.rowid, old.text);
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS projection_message_search_update
    AFTER UPDATE OF text, is_streaming ON projection_thread_messages BEGIN
      INSERT INTO projection_message_search(projection_message_search, rowid, text)
      SELECT 'delete', old.rowid, old.text WHERE old.is_streaming = 0;
      INSERT INTO projection_message_search(rowid, text)
      SELECT new.rowid, new.text WHERE new.is_streaming = 0;
    END
  `;
  yield* sql`
    INSERT INTO projection_message_search(rowid, text)
    SELECT rowid, text FROM projection_thread_messages WHERE is_streaming = 0
  `;
});
