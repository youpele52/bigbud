import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationActorKind,
  OrchestrationAggregateKind,
  OrchestrationEvent,
  OrchestrationEventType,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Stream } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type OrchestrationEventStoreError,
} from "../Errors.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../Services/OrchestrationEventStore.ts";
import { makeCompactVerifiedPrefix } from "./OrchestrationEventStore.compaction.ts";
import { makeReadByCommandId } from "./OrchestrationEventStore.commandEvents.ts";
import {
  EventMetadataFromJsonString,
  OrchestrationEventPersistedRowSchema,
  UnknownFromJsonString,
} from "./OrchestrationEventStore.schemas.ts";
import {
  decodeEventCompat,
  inferActorKind,
  toPersistenceSqlOrDecodeError,
} from "./OrchestrationEventStore.utils.ts";

const AppendEventRequestSchema = Schema.Struct({
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  streamId: Schema.Union([ProjectId, ThreadId]),
  type: OrchestrationEventType,
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  actorKind: OrchestrationActorKind,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  payloadJson: UnknownFromJsonString,
  metadataJson: EventMetadataFromJsonString,
});

const ReadFromSequenceRequestSchema = Schema.Struct({
  sequenceExclusive: NonNegativeInt,
  limit: Schema.Number,
});
const EventRangeRowSchema = Schema.Struct({
  earliestAvailableSequence: Schema.NullOr(NonNegativeInt),
  latestSequence: NonNegativeInt,
  retainedThroughSequence: NonNegativeInt,
});
const DEFAULT_READ_FROM_SEQUENCE_LIMIT = 1_000,
  READ_PAGE_SIZE = 500;

const makeEventStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const appendEventRow = SqlSchema.findOne({
    Request: AppendEventRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${request.eventId},
          ${request.aggregateKind},
          ${request.streamId},
          COALESCE((
            SELECT last_stream_version + 1
            FROM orchestration_stream_state
            WHERE aggregate_kind = ${request.aggregateKind} AND stream_id = ${request.streamId}
          ), 0),
          ${request.type},
          ${request.occurredAt},
          ${request.commandId},
          ${request.causationEventId},
          ${request.correlationId},
          ${request.actorKind},
          ${request.payloadJson},
          ${request.metadataJson}
        )
        RETURNING
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
      `,
  });

  const readEventRowsFromSequence = SqlSchema.findAll({
    Request: ReadFromSequenceRequestSchema,
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
        WHERE sequence > ${request.sequenceExclusive}
        ORDER BY sequence ASC
        LIMIT ${request.limit}
      `,
  });
  const readEventRange = SqlSchema.findOne({
    Request: Schema.Void,
    Result: EventRangeRowSchema,
    execute: () => sql`
       SELECT
         (SELECT MIN(sequence) FROM orchestration_events) AS "earliestAvailableSequence",
         MAX(
           retention.retained_through_sequence,
           COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0)
         ) AS "latestSequence",
         retention.retained_through_sequence AS "retainedThroughSequence"
       FROM orchestration_retention_state AS retention
       WHERE retention.singleton_id = 1
    `,
  });
  const append: OrchestrationEventStoreShape["append"] = (event) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO orchestration_event_ids (event_id, sequence)
            VALUES (
              ${event.eventId},
              COALESCE((SELECT MAX(sequence) + 1 FROM orchestration_events),
                (SELECT retained_through_sequence + 1 FROM orchestration_retention_state WHERE singleton_id = 1),
                1)
            )
          `;
          const persisted = yield* appendEventRow({
            eventId: event.eventId,
            aggregateKind: event.aggregateKind,
            streamId: event.aggregateId,
            type: event.type,
            causationEventId: event.causationEventId,
            correlationId: event.correlationId,
            actorKind: inferActorKind(event),
            occurredAt: event.occurredAt,
            commandId: event.commandId,
            payloadJson: event.payload,
            metadataJson: event.metadata,
          });
          yield* sql`
        INSERT INTO orchestration_stream_state (
          aggregate_kind, stream_id, last_stream_version, updated_at
        ) VALUES (
          ${event.aggregateKind}, ${event.aggregateId},
          COALESCE((
            SELECT MAX(stream_version) FROM orchestration_events
            WHERE aggregate_kind = ${event.aggregateKind} AND stream_id = ${event.aggregateId}
          ), 0),
          ${event.occurredAt}
        )
        ON CONFLICT (aggregate_kind, stream_id) DO UPDATE SET
          last_stream_version = excluded.last_stream_version,
          updated_at = excluded.updated_at
      `;
          if (persisted.type === "thread.deleted" || persisted.type === "project.deleted") {
            yield* sql`
          INSERT INTO orchestration_deletion_markers (
            entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
          ) VALUES (
            ${persisted.aggregateKind}, ${persisted.aggregateId}, ${persisted.sequence},
            ${persisted.occurredAt}, NULL
          )
          ON CONFLICT (entity_kind, entity_id) DO UPDATE SET
            deletion_sequence = excluded.deletion_sequence,
            deleted_at = excluded.deleted_at,
            covered_by_baseline_sequence = NULL
        `;
          }
          if (event.type === "thread.created" && "projectId" in event.payload) {
            const projectId = (event.payload as { readonly projectId: ProjectId }).projectId;
            yield* sql`
              INSERT INTO orchestration_thread_identity (thread_id, project_id, created_sequence)
              VALUES (${event.aggregateId}, ${projectId}, ${persisted.sequence})
              ON CONFLICT (thread_id) DO NOTHING
            `;
          }
          return persisted;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "OrchestrationEventStore.append:insert",
            "OrchestrationEventStore.append:decodeRow",
          ),
        ),
        Effect.flatMap((row) =>
          decodeEventCompat(row).pipe(
            Effect.mapError(toPersistenceDecodeError("OrchestrationEventStore.append:rowToEvent")),
          ),
        ),
      );

  const readFromSequence: OrchestrationEventStoreShape["readFromSequence"] = (
    sequenceExclusive,
    limit = DEFAULT_READ_FROM_SEQUENCE_LIMIT,
  ) => {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedLimit === 0) {
      return Stream.empty;
    }
    const readPage = (
      cursor: number,
      remaining: number,
    ): Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError> =>
      Stream.fromEffect(
        readEventRowsFromSequence({
          sequenceExclusive: cursor,
          limit: Math.min(remaining, READ_PAGE_SIZE),
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "OrchestrationEventStore.readFromSequence:query",
              "OrchestrationEventStore.readFromSequence:decodeRows",
            ),
          ),
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              decodeEventCompat(row).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("OrchestrationEventStore.readFromSequence:rowToEvent"),
                ),
              ),
            ),
          ),
        ),
      ).pipe(
        Stream.flatMap((events) => {
          if (events.length === 0) {
            return Stream.empty;
          }
          const nextRemaining = remaining - events.length;
          if (nextRemaining <= 0) {
            return Stream.fromIterable(events);
          }
          return Stream.concat(
            Stream.fromIterable(events),
            readPage(events[events.length - 1]!.sequence, nextRemaining),
          );
        }),
      );

    return readPage(sequenceExclusive, normalizedLimit);
  };

  const readReplay: OrchestrationEventStoreShape["readReplay"] = (
    sequenceExclusive,
    limit = DEFAULT_READ_FROM_SEQUENCE_LIMIT,
  ) => {
    const requestedFromSequenceExclusive = Math.max(0, Math.floor(sequenceExclusive));
    const normalizedLimit = Math.max(0, Math.floor(limit));
    return sql
      .withTransaction(
        Effect.all({
          range: readEventRange(undefined),
          rows: readEventRowsFromSequence({
            sequenceExclusive: requestedFromSequenceExclusive,
            limit: normalizedLimit,
          }),
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "OrchestrationEventStore.readReplay:query",
            "OrchestrationEventStore.readReplay:decodeRows",
          ),
        ),
        Effect.flatMap(({ range, rows }) =>
          Effect.forEach(rows, (row) =>
            decodeEventCompat(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError("OrchestrationEventStore.readReplay:rowToEvent"),
              ),
            ),
          ).pipe(Effect.map((events) => ({ range, events }))),
        ),
        Effect.map(({ range, events }) => {
          const earliestAvailableSequence = range.earliestAvailableSequence;
          const latestSequence = range.latestSequence;
          const inferredRetainedThrough =
            earliestAvailableSequence === null
              ? range.retainedThroughSequence
              : Math.max(range.retainedThroughSequence, earliestAvailableSequence - 1);
          const retainedFromSequenceExclusive = inferredRetainedThrough;
          const hasInternalGap = events.some(
            (event, index) =>
              event.sequence !==
              (index === 0
                ? Math.max(requestedFromSequenceExclusive, retainedFromSequenceExclusive) + 1
                : events[index - 1]!.sequence + 1),
          );
          const availability =
            requestedFromSequenceExclusive < retainedFromSequenceExclusive || hasInternalGap
              ? ("gap" as const)
              : ("available" as const);
          const availableEvents = availability === "gap" ? [] : events;
          return {
            requestedFromSequenceExclusive,
            retainedFromSequenceExclusive,
            earliestAvailableSequence,
            latestSequence,
            availability,
            complete:
              availability === "available" &&
              (availableEvents.at(-1)?.sequence ?? requestedFromSequenceExclusive) >=
                latestSequence,
            events: availableEvents,
          };
        }),
      );
  };

  const findThreadProjectId: OrchestrationEventStoreShape["findThreadProjectId"] = (threadId) =>
    sql<{ readonly projectId: ProjectId | null }>`
      SELECT COALESCE(
        (SELECT json_extract(payload_json, '$.projectId')
         FROM orchestration_events
         WHERE aggregate_kind = 'thread'
           AND stream_id = ${threadId}
           AND event_type = 'thread.created'
         ORDER BY sequence DESC LIMIT 1),
        (SELECT project_id FROM orchestration_thread_identity WHERE thread_id = ${threadId})
      ) AS "projectId"
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0]?.projectId)),
      Effect.mapError(toPersistenceSqlError("OrchestrationEventStore.findThreadProjectId:query")),
    );

  const compactVerifiedPrefix = makeCompactVerifiedPrefix(sql);
  const readByCommandId = makeReadByCommandId(sql);

  return {
    append,
    compactVerifiedPrefix,
    readFromSequence,
    readByCommandId,
    readReplay,
    findThreadProjectId,
    readAll: () => readFromSequence(0, Number.MAX_SAFE_INTEGER),
  } satisfies OrchestrationEventStoreShape;
});

export const OrchestrationEventStoreLive = Layer.effect(OrchestrationEventStore, makeEventStore);
