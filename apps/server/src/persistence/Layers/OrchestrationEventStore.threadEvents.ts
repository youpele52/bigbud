/**
 * Bounded per-thread reads used to verify cross-project thread coordination confirmations.
 * Split from `OrchestrationEventStore.ts` to keep that layer under the file length limit.
 *
 * @module OrchestrationEventStore.threadEvents
 */
import { NonNegativeInt, ThreadId } from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError } from "../Errors.ts";
import type { OrchestrationEventStoreShape } from "../Services/OrchestrationEventStore.ts";
import {
  decodeEventCompat,
  toPersistenceSqlOrDecodeError,
} from "./OrchestrationEventStore.utils.ts";
import { OrchestrationEventPersistedRowSchema } from "./OrchestrationEventStore.schemas.ts";

/** Hard page bound; callers page with the last returned sequence. */
const MAX_PROOF_EVENTS_PER_PAGE = 500;
/** Hard bound for the recent user-turn window; a turn adds only a handful of these events. */
const MAX_RECENT_USER_TURN_EVENTS = 200;

const ReadThreadProofEventsRequestSchema = Schema.Struct({
  threadId: ThreadId,
  afterSequence: NonNegativeInt,
  limit: NonNegativeInt,
});
const ReadThreadRecentUserTurnEventsRequestSchema = Schema.Struct({
  threadId: ThreadId,
  limit: NonNegativeInt,
});
const ReadThreadMaxSequenceRequestSchema = Schema.Struct({ threadId: ThreadId });
const ThreadMaxSequenceRowSchema = Schema.Struct({ maxSequence: Schema.NullOr(NonNegativeInt) });

export function makeThreadProofEventQueries(sql: SqlClient.SqlClient): {
  readonly readThreadProofEventsAfter: NonNullable<
    OrchestrationEventStoreShape["readThreadProofEventsAfter"]
  >;
  readonly readThreadMaxSequence: NonNullable<
    OrchestrationEventStoreShape["readThreadMaxSequence"]
  >;
  readonly readThreadRecentUserTurnEvents: NonNullable<
    OrchestrationEventStoreShape["readThreadRecentUserTurnEvents"]
  >;
} {
  // The stream/sequence index bounds the scan; the role and activity-kind filters keep streamed
  // assistant chunks and unrelated activities (tool progress, approvals) from filling a page.
  const readRows = SqlSchema.findAll({
    Request: ReadThreadProofEventsRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${request.threadId}
          AND sequence > ${request.afterSequence}
          AND (
            event_type IN ('thread.user-input-response-requested', 'thread.prompt-queued')
            OR (
              event_type = 'thread.activity-appended'
              AND json_extract(payload_json, '$.activity.kind') = 'user-input.requested'
            )
            OR (
              event_type = 'thread.message-sent'
              AND json_extract(payload_json, '$.role') = 'user'
            )
          )
        ORDER BY sequence ASC
        LIMIT ${request.limit}
      `,
  });
  // Newest first through the same stream/sequence index, so the window is the thread's tail.
  const readRecentUserTurnRows = SqlSchema.findAll({
    Request: ReadThreadRecentUserTurnEventsRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${request.threadId}
          AND (
            event_type IN (
              'thread.prompt-queued',
              'thread.queued-prompts-flushed',
              'thread.turn-start-requested'
            )
            OR (
              event_type = 'thread.message-sent'
              AND json_extract(payload_json, '$.role') = 'user'
            )
          )
        ORDER BY sequence DESC
        LIMIT ${request.limit}
      `,
  });
  const readMaxSequence = SqlSchema.findOne({
    Request: ReadThreadMaxSequenceRequestSchema,
    Result: ThreadMaxSequenceRowSchema,
    execute: (request) =>
      sql`
        SELECT MAX(sequence) AS "maxSequence"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${request.threadId}
      `,
  });

  const decodeRows =
    (operation: string) =>
    (rows: ReadonlyArray<typeof OrchestrationEventPersistedRowSchema.Type>) =>
      Effect.forEach(rows, (row) =>
        decodeEventCompat(row).pipe(
          Effect.mapError(
            toPersistenceDecodeError(`OrchestrationEventStore.${operation}:rowToEvent`),
          ),
        ),
      );

  const readThreadProofEventsAfter: NonNullable<
    OrchestrationEventStoreShape["readThreadProofEventsAfter"]
  > = (input) =>
    readRows({
      threadId: input.threadId,
      afterSequence: Math.max(0, Math.floor(input.afterSequence)),
      limit: Math.min(MAX_PROOF_EVENTS_PER_PAGE, Math.max(0, Math.floor(input.limit))),
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.readThreadProofEventsAfter:query",
          "OrchestrationEventStore.readThreadProofEventsAfter:decodeRows",
        ),
      ),
      Effect.flatMap(decodeRows("readThreadProofEventsAfter")),
    );

  const readThreadRecentUserTurnEvents: NonNullable<
    OrchestrationEventStoreShape["readThreadRecentUserTurnEvents"]
  > = (input) =>
    readRecentUserTurnRows({
      threadId: input.threadId,
      limit: Math.min(MAX_RECENT_USER_TURN_EVENTS, Math.max(0, Math.floor(input.limit))),
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.readThreadRecentUserTurnEvents:query",
          "OrchestrationEventStore.readThreadRecentUserTurnEvents:decodeRows",
        ),
      ),
      Effect.flatMap(decodeRows("readThreadRecentUserTurnEvents")),
      Effect.map((events) => events.toReversed()),
    );

  const readThreadMaxSequence: NonNullable<
    OrchestrationEventStoreShape["readThreadMaxSequence"]
  > = (threadId) =>
    readMaxSequence({ threadId }).pipe(
      Effect.map((row) => row.maxSequence ?? 0),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.readThreadMaxSequence:query",
          "OrchestrationEventStore.readThreadMaxSequence:decodeRow",
        ),
      ),
    );

  return { readThreadProofEventsAfter, readThreadMaxSequence, readThreadRecentUserTurnEvents };
}
