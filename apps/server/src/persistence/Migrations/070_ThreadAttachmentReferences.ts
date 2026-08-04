import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  extractActivityAttachmentReferences,
  extractMessageAttachmentReferences,
} from "../../attachments/threadAttachmentReferences.ts";

const attachmentRefInsert = `
  INSERT OR IGNORE INTO projection_thread_attachment_refs (
    thread_id, attachment_id, source_kind, source_id, is_unresolved
  ) VALUES (?, ?, ?, ?, ?)
`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE projection_thread_attachment_refs (
      thread_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'activity')),
      source_id TEXT NOT NULL,
      is_unresolved INTEGER NOT NULL CHECK (is_unresolved IN (0, 1)),
      CHECK (
        (is_unresolved = 0 AND attachment_id <> '') OR
        (is_unresolved = 1 AND attachment_id = '')
      ),
      PRIMARY KEY (source_kind, source_id, attachment_id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX idx_projection_thread_attachment_refs_lookup
    ON projection_thread_attachment_refs(attachment_id, thread_id)
  `;

  const messages = yield* sql<{
    readonly attachmentsJson: string | null;
    readonly messageId: string;
    readonly threadId: string;
  }>`SELECT message_id AS "messageId", thread_id AS "threadId", attachments_json AS "attachmentsJson"
    FROM projection_thread_messages`;
  const activities = yield* sql<{
    readonly activityId: string;
    readonly kind: string;
    readonly payloadJson: string;
    readonly threadId: string;
  }>`SELECT activity_id AS "activityId", thread_id AS "threadId", kind, payload_json AS "payloadJson"
    FROM projection_thread_activities`;
  const insert = (input: {
    readonly attachmentId: string;
    readonly sourceId: string;
    readonly sourceKind: "activity" | "message";
    readonly threadId: string;
    readonly unresolved: boolean;
  }) =>
    sql.unsafe(attachmentRefInsert, [
      input.threadId,
      input.attachmentId,
      input.sourceKind,
      input.sourceId,
      input.unresolved ? 1 : 0,
    ]);
  for (const message of messages) {
    const refs = extractMessageAttachmentReferences(message.attachmentsJson);
    for (const attachmentId of refs.attachmentIds) {
      yield* insert({
        attachmentId,
        sourceId: message.messageId,
        sourceKind: "message",
        threadId: message.threadId,
        unresolved: false,
      });
    }
    if (refs.unresolved) {
      yield* insert({
        attachmentId: "",
        sourceId: message.messageId,
        sourceKind: "message",
        threadId: message.threadId,
        unresolved: true,
      });
    }
  }
  for (const activity of activities) {
    const refs = extractActivityAttachmentReferences(activity);
    for (const attachmentId of refs.attachmentIds) {
      yield* insert({
        attachmentId,
        sourceId: activity.activityId,
        sourceKind: "activity",
        threadId: activity.threadId,
        unresolved: false,
      });
    }
    if (refs.unresolved) {
      yield* insert({
        attachmentId: "",
        sourceId: activity.activityId,
        sourceKind: "activity",
        threadId: activity.threadId,
        unresolved: true,
      });
    }
  }

  const messageRefs = `
    INSERT OR IGNORE INTO projection_thread_attachment_refs
      (thread_id, attachment_id, source_kind, source_id, is_unresolved)
    SELECT NEW.thread_id, json_extract(attachment.value, '$.id'), 'message', NEW.message_id, 0
    FROM json_each(NEW.attachments_json) AS attachment
    WHERE json_valid(NEW.attachments_json)
      AND json_type(NEW.attachments_json) = 'array'
      AND json_type(attachment.value) = 'object'
      AND json_extract(attachment.value, '$.type') IN ('image', 'file')
      AND json_type(attachment.value, '$.id') = 'text'
      AND trim(json_extract(attachment.value, '$.id')) <> '';
    INSERT OR IGNORE INTO projection_thread_attachment_refs
      (thread_id, attachment_id, source_kind, source_id, is_unresolved)
    SELECT NEW.thread_id, '', 'message', NEW.message_id, 1
    WHERE NEW.attachments_json IS NOT NULL AND (
      NOT json_valid(NEW.attachments_json) OR json_type(NEW.attachments_json) <> 'array' OR EXISTS (
        SELECT 1 FROM json_each(NEW.attachments_json) AS attachment
        WHERE json_type(attachment.value) <> 'object'
          OR json_extract(attachment.value, '$.type') NOT IN ('image', 'file', 'path', 'thread')
          OR json_type(attachment.value, '$.id') <> 'text'
          OR trim(json_extract(attachment.value, '$.id')) = ''
      )
    );`;
  const activityRefs = `
    INSERT OR IGNORE INTO projection_thread_attachment_refs
      (thread_id, attachment_id, source_kind, source_id, is_unresolved)
    SELECT NEW.thread_id, json_extract(NEW.payload_json, '$.data.result.screenshot.attachmentId'),
      'activity', NEW.activity_id, 0
    WHERE json_valid(NEW.payload_json)
      AND NEW.kind = 'tool.completed'
      AND json_extract(NEW.payload_json, '$.title') = 'computer_use'
      AND json_type(NEW.payload_json, '$.data.result.screenshot.attachmentId') = 'text'
      AND trim(json_extract(NEW.payload_json, '$.data.result.screenshot.attachmentId')) <> ''
      AND json_type(NEW.payload_json, '$.data.result.screenshot.mimeType') = 'text';
    INSERT OR IGNORE INTO projection_thread_attachment_refs
      (thread_id, attachment_id, source_kind, source_id, is_unresolved)
    SELECT NEW.thread_id, '', 'activity', NEW.activity_id, 1
    WHERE NOT json_valid(NEW.payload_json) OR (
      NEW.kind = 'tool.completed' AND json_extract(NEW.payload_json, '$.title') = 'computer_use'
      AND (json_type(NEW.payload_json, '$.data') <> 'object' OR (
        json_type(NEW.payload_json, '$.data.result.screenshot') IS NOT NULL AND (
           json_type(NEW.payload_json, '$.data.result.screenshot') <> 'object' OR
           json_type(NEW.payload_json, '$.data.result.screenshot.attachmentId') <> 'text' OR
           trim(json_extract(NEW.payload_json, '$.data.result.screenshot.attachmentId')) = '' OR
           json_type(NEW.payload_json, '$.data.result.screenshot.mimeType') <> 'text'
        )
      ))
    );`;
  for (const [table, sourceKind, columns, refs] of [
    ["projection_thread_messages", "message", "thread_id, attachments_json", messageRefs],
    ["projection_thread_activities", "activity", "thread_id, payload_json", activityRefs],
  ] as const) {
    yield* sql.unsafe(`
      CREATE TRIGGER projection_thread_attachment_refs_${sourceKind}_insert
      AFTER INSERT ON ${table} BEGIN ${refs} END;
    `);
    yield* sql.unsafe(`
      CREATE TRIGGER projection_thread_attachment_refs_${sourceKind}_update
      AFTER UPDATE OF ${columns} ON ${table} BEGIN
        DELETE FROM projection_thread_attachment_refs
        WHERE source_kind = '${sourceKind}' AND source_id = NEW.${sourceKind}_id;
        ${refs}
      END;
    `);
    yield* sql.unsafe(`
      CREATE TRIGGER projection_thread_attachment_refs_${sourceKind}_delete
      AFTER DELETE ON ${table} BEGIN
        DELETE FROM projection_thread_attachment_refs
        WHERE source_kind = '${sourceKind}' AND source_id = OLD.${sourceKind}_id;
      END;
    `);
  }
});
