/**
 * A thread deletion whose canonical cleanup was deferred: its events end in `thread.deleted`,
 * and a deletion marker covered by a verified baseline records it.
 *
 * @module deferredDeletion.test.helpers
 */
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const clearDeferredDeletionRows = Effect.fn("clearDeferredDeletionRows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of [
    "deferred_canonical_cleanup_retries",
    "orchestration_deletion_markers",
    "orchestration_events",
    "projection_baselines",
    "direct_resource_cleanup_intents",
  ]) {
    yield* sql.unsafe(`DELETE FROM ${table}`);
  }
});

const appendEvent = Effect.fn("appendDeferredDeletionEvent")(function* (
  threadId: string,
  eventType: string,
  occurredAt: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ sequence: number }>`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
    ) VALUES (${`${threadId}:${eventType}:${crypto.randomUUID()}`}, 'thread', ${threadId},
      (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = ${threadId}), ${eventType},
      ${occurredAt}, ${`command:${crypto.randomUUID()}`}, NULL, NULL, 'server', '{}', '{}')
    RETURNING sequence
  `;
  return rows[0]!.sequence;
});

/**
 * Writes `thread.created` and `thread.deleted` events, the marker, and a verified baseline at
 * the deletion. `extraEventAfterBaseline` adds a later event for the stream, which the
 * canonical proof rejects (history newer than the baseline).
 */
export const seedDeferredDeletion = Effect.fn("seedDeferredDeletion")(function* (input: {
  readonly threadId: string;
  readonly deletedAt: string;
  readonly extraEventAfterBaseline?: boolean;
  /** Events written before the deletion (default 1, the `thread.created`). */
  readonly historyEvents?: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* appendEvent(input.threadId, "thread.created", input.deletedAt);
  for (let index = 1; index < (input.historyEvents ?? 1); index += 1) {
    yield* appendEvent(input.threadId, "thread.message-sent", input.deletedAt);
  }
  const deletionSequence = yield* appendEvent(input.threadId, "thread.deleted", input.deletedAt);
  yield* sql`
    INSERT INTO projection_baselines (
      sequence, format_version, payload_json, payload_hash, verification_status,
      created_at, verified_at
    ) VALUES (${deletionSequence}, 1, '{}', ${`hash-${input.threadId}`}, 'verified',
      ${input.deletedAt}, ${input.deletedAt})
    ON CONFLICT DO NOTHING
  `;
  yield* sql`
    INSERT INTO orchestration_deletion_markers (
      entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
    ) VALUES ('thread', ${input.threadId}, ${deletionSequence}, ${input.deletedAt},
      ${deletionSequence})
  `;
  if (input.extraEventAfterBaseline === true) {
    yield* appendEvent(input.threadId, "thread.meta-updated", input.deletedAt);
  }
  return deletionSequence;
});

export const countThreadEvents = Effect.fn("countThreadEvents")(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ events: number; markers: number }>`
    SELECT (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = ${threadId}) AS events,
      (SELECT COUNT(*) FROM orchestration_deletion_markers WHERE entity_id = ${threadId}) AS markers
  `;
  return rows[0]!;
});
