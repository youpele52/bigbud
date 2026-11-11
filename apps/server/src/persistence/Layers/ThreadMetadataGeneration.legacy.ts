import { CommandId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { OrchestrationThreadActivity } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { commandPayloadDigestMatches } from "../../orchestration/commandDigest.ts";
import { toPersistenceSqlError } from "../Errors.ts";

const PAGE_SIZE = 100;
interface LegacyRow {
  readonly key: string;
  readonly commandId: string;
  readonly activityId: string | null;
  readonly kind: string | null;
  readonly tone: string | null;
  readonly summary: string | null;
  readonly payloadJson: string | null;
  readonly eventPayloadJson: string | null;
  readonly turnId: string | null;
  readonly createdAt: string | null;
  readonly commandCreatedAt: string | null;
  readonly activitySequence: number | null;
  readonly sequence: number | null;
  readonly aggregateKind: string | null;
  readonly aggregateId: string | null;
  readonly status: string | null;
  readonly resultSequence: number | null;
  readonly digestVersion: string | null;
  readonly digest: string | null;
}

export interface LegacyMetadataEvidence {
  readonly key: string;
  readonly commandId: string;
  /** Unknown includes absent/legacy digests, malformed projections, and orphan receipts/claims. */
  readonly witness: "accepted" | "unknown";
  readonly activity: OrchestrationThreadActivity | null;
  readonly sequence: number | null;
}

const CanonicalActivityPayload = Schema.fromJsonString(
  Schema.Struct({
    threadId: ThreadId,
    activity: OrchestrationThreadActivity,
  }),
);

function readEvidence(threadId: ThreadId, row: LegacyRow): LegacyMetadataEvidence {
  const payload = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(
    row.payloadJson,
  );
  const activity = Option.isSome(payload)
    ? Schema.decodeUnknownOption(OrchestrationThreadActivity)({
        id: row.activityId,
        kind: row.kind,
        tone: row.tone,
        summary: row.summary,
        payload: payload.value,
        turnId: row.turnId,
        createdAt: row.createdAt,
        ...(row.activitySequence !== null ? { sequence: row.activitySequence } : {}),
      })
    : Option.none();
  const retained = Option.getOrNull(activity);
  const canonical = Schema.decodeUnknownOption(CanonicalActivityPayload)(row.eventPayloadJson);
  const accepted =
    retained !== null &&
    Option.isSome(canonical) &&
    canonical.value.threadId === threadId &&
    row.commandCreatedAt !== null &&
    row.status === "accepted" &&
    row.aggregateKind === "thread" &&
    row.aggregateId === threadId &&
    row.sequence !== null &&
    row.sequence === row.resultSequence &&
    row.digestVersion !== null &&
    row.digest !== null &&
    commandPayloadDigestMatches(
      {
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(row.commandId),
        threadId,
        createdAt: row.commandCreatedAt,
        activity: retained,
      },
      { version: row.digestVersion, digest: row.digest },
    ) &&
    commandPayloadDigestMatches(
      {
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(row.commandId),
        threadId,
        createdAt: row.commandCreatedAt,
        activity: canonical.value.activity,
      },
      { version: row.digestVersion, digest: row.digest },
    );
  return {
    key: row.key,
    commandId: row.commandId,
    witness: accepted ? "accepted" : "unknown",
    activity: retained,
    sequence: row.sequence,
  };
}

/** Read-only, bounded pages of full SQL history, never the runtime's 500-activity tail.
 * Consumers must retain unknown work; even an accepted status is not provider-terminal evidence.
 * No receipt is modified, and a missing digest is never upgraded by guessing a command payload.
 */
export const makeLegacyMetadataEvidenceReader = Effect.fn("makeLegacyMetadataEvidenceReader")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return Effect.fn("legacyMetadata.readPage")(function* (input: {
      readonly threadId: ThreadId;
      readonly afterKey?: string;
    }) {
      const rows = yield* legacyMetadataEvidenceQuery(sql, input).pipe(
        Effect.mapError(toPersistenceSqlError("ThreadMetadataGeneration.legacy.readPage")),
      );
      return {
        evidence: rows.map((row) => readEvidence(input.threadId, row)),
        nextKey: rows.length === PAGE_SIZE ? rows.at(-1)!.key : null,
      };
    });
  },
);

/** Keep correlated lookups on exact identities, not whole thread histories. Unary + on
 * activity_id removes column affinity so SQLite can use the JSON expression index.
 * Explicit indexes also avoid quadratic plans before SQLite has collected statistics.
 */
export function legacyMetadataEvidenceQuery(
  sql: SqlClient.SqlClient,
  input: { readonly threadId: ThreadId; readonly afterKey?: string },
) {
  const titlePrefix = `server:text-generation-title-stage:${input.threadId}:`;
  return sql<LegacyRow>`
        SELECT * FROM (
          SELECT 'activity:' || a.activity_id AS key,
            COALESCE(e.command_id, 'server:' || a.activity_id) AS commandId,
            a.activity_id AS activityId, a.kind, a.tone, a.summary,
            a.payload_json AS payloadJson, e.payload_json AS eventPayloadJson,
            a.turn_id AS turnId, a.created_at AS createdAt,
            e.occurred_at AS commandCreatedAt, a.sequence AS activitySequence,
            e.sequence AS sequence,
            r.aggregate_kind AS aggregateKind, r.aggregate_id AS aggregateId,
            r.status, r.result_sequence AS resultSequence,
            r.payload_digest_version AS digestVersion, r.payload_digest AS digest
          FROM projection_thread_activities a
          LEFT JOIN orchestration_events e ON e.sequence = (
            SELECT sequence FROM orchestration_events INDEXED BY idx_orch_events_thread_activity_identity
            WHERE aggregate_kind = 'thread' AND stream_id = a.thread_id
              AND event_type = 'thread.activity-appended'
              AND CASE WHEN json_valid(payload_json)
                THEN json_extract(payload_json, '$.activity.id') END = +a.activity_id
            ORDER BY sequence DESC LIMIT 1
          )
          LEFT JOIN orchestration_command_receipts r
            ON r.command_id = COALESCE(e.command_id, 'server:' || a.activity_id)
            AND (e.sequence IS NULL OR (
              e.aggregate_kind = 'thread' AND e.stream_id = a.thread_id
              AND e.event_type = 'thread.activity-appended'
              AND CASE WHEN json_valid(e.payload_json)
                THEN json_extract(e.payload_json, '$.activity.id') = a.activity_id
                  AND json_extract(e.payload_json, '$.threadId') = a.thread_id
                ELSE 0 END
            ))
          WHERE a.thread_id = ${input.threadId} AND a.kind LIKE 'text-generation.%'
          UNION ALL
          SELECT 'receipt:' || r.command_id, r.command_id, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, r.aggregate_kind, r.aggregate_id, r.status,
            r.result_sequence, r.payload_digest_version, r.payload_digest
          FROM orchestration_command_receipts r
          WHERE r.aggregate_kind = 'thread' AND r.aggregate_id = ${input.threadId}
            AND (r.command_id LIKE 'server:text-generation%' OR EXISTS (
              SELECT 1 FROM orchestration_events e INDEXED BY idx_orch_events_command_id
              WHERE e.command_id = r.command_id
                AND e.aggregate_kind = 'thread' AND e.stream_id = ${input.threadId}
                AND e.event_type = 'thread.activity-appended'
                AND CASE WHEN json_valid(e.payload_json)
                  THEN COALESCE(json_extract(e.payload_json, '$.activity.kind') LIKE 'text-generation.%', 1)
                  ELSE 1 END
            ))
            AND NOT EXISTS (SELECT 1 FROM projection_thread_activities a
              WHERE a.activity_id = substr(r.command_id, 8)
                AND a.thread_id = ${input.threadId} AND a.kind LIKE 'text-generation.%')
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_events e INDEXED BY idx_orch_events_command_id
              JOIN projection_thread_activities a ON a.activity_id = CASE WHEN json_valid(e.payload_json)
                THEN json_extract(e.payload_json, '$.activity.id') END
              WHERE e.command_id = r.command_id AND e.aggregate_kind = 'thread'
                AND e.stream_id = ${input.threadId} AND e.event_type = 'thread.activity-appended'
                AND a.thread_id = ${input.threadId} AND a.kind LIKE 'text-generation.%'
                AND e.sequence = (
                  SELECT sequence FROM orchestration_events INDEXED BY idx_orch_events_thread_activity_identity
                  WHERE aggregate_kind = 'thread' AND stream_id = a.thread_id
                    AND event_type = 'thread.activity-appended'
                    AND CASE WHEN json_valid(payload_json)
                      THEN json_extract(payload_json, '$.activity.id') END = +a.activity_id
                  ORDER BY sequence DESC LIMIT 1
                ))
          UNION ALL
          SELECT 'claim:' || c.command_id, c.command_id, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            c.payload_digest_version, c.payload_digest
          FROM orchestration_command_receipt_claims c
          WHERE (
              substr(c.command_id, 1, length(${titlePrefix})) = ${titlePrefix}
              OR (c.command_id LIKE 'server:text-generation-request-started:%' AND (
                EXISTS (SELECT 1 FROM projection_thread_activities request
                  WHERE request.thread_id = ${input.threadId}
                    AND request.activity_id = substr(c.command_id, length('server:text-generation-request-started:') + 1))
                OR NOT EXISTS (SELECT 1 FROM projection_thread_activities request
                  WHERE request.activity_id = substr(c.command_id, length('server:text-generation-request-started:') + 1))
              ))
              OR c.command_id LIKE 'server:text-generation-status:%'
            )
            AND NOT EXISTS (SELECT 1 FROM orchestration_command_receipts r
              WHERE r.command_id = c.command_id)
            AND NOT EXISTS (SELECT 1 FROM projection_thread_activities a
              WHERE a.activity_id = substr(c.command_id, 8)
                AND a.kind LIKE 'text-generation.%')
          UNION ALL
          SELECT 'event:' || e.sequence, e.command_id, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, e.sequence, NULL, NULL, NULL, NULL, NULL, NULL
          FROM orchestration_events e
          WHERE e.aggregate_kind = 'thread' AND e.stream_id = ${input.threadId}
            AND e.event_type = 'thread.activity-appended'
            AND CASE WHEN json_valid(e.payload_json)
              THEN COALESCE(json_extract(e.payload_json, '$.activity.kind') LIKE 'text-generation.%', 1)
              ELSE 1 END
            AND NOT EXISTS (SELECT 1 FROM projection_thread_activities a
              WHERE a.thread_id = ${input.threadId} AND a.kind LIKE 'text-generation.%'
                AND a.activity_id = CASE WHEN json_valid(e.payload_json)
                  THEN json_extract(e.payload_json, '$.activity.id') END
                AND e.sequence = (
                  SELECT sequence FROM orchestration_events INDEXED BY idx_orch_events_thread_activity_identity
                  WHERE aggregate_kind = 'thread' AND stream_id = a.thread_id
                    AND event_type = 'thread.activity-appended'
                    AND CASE WHEN json_valid(payload_json)
                      THEN json_extract(payload_json, '$.activity.id') END = +a.activity_id
                  ORDER BY sequence DESC LIMIT 1
                ))
            AND NOT EXISTS (SELECT 1 FROM orchestration_command_receipts r
              WHERE r.command_id = e.command_id)
        ) WHERE key > ${input.afterKey ?? ""} ORDER BY key LIMIT ${PAGE_SIZE}
      `;
}
