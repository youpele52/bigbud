import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Fragment } from "effect/unstable/sql/Statement";
import { toPersistenceSqlError } from "../Errors.ts";
import type { ProviderSessionRuntimeRepositoryShape } from "../Services/ProviderSessionRuntime.ts";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";

/** A retained record is complete only after every normal terminal consumer durably acknowledged it. */
export function inspectionPending(sql: SqlClient.SqlClient) {
  return sql`json_extract(runtime_payload_json, '$."bigbud.codex.inspectionTerminal"') IS NOT NULL AND (
    COALESCE(json_extract(runtime_payload_json, '$."bigbud.codex.inspectionTerminal".version'), 0) != 1 OR NOT (
    COALESCE(json_extract(runtime_payload_json, '$."bigbud.codex.inspectionTerminal".acknowledgements.ingestion'), 0) = 1 AND
    COALESCE(json_extract(runtime_payload_json, '$."bigbud.codex.inspectionTerminal".acknowledgements.checkpoint'), 0) = 1 AND
    COALESCE(json_extract(runtime_payload_json, '$."bigbud.codex.inspectionTerminal".acknowledgements.recovery'), 0) = 1))`;
}

export function preserveInspectionPayload(sql: SqlClient.SqlClient, base: Fragment) {
  return sql`CASE WHEN json_extract(provider_session_runtime.runtime_payload_json, '$."bigbud.codex.inspectionTerminal"') IS NOT NULL
    THEN json_set(CASE WHEN json_type(${base}) = 'object' THEN ${base} ELSE '{}' END,
      '$."bigbud.codex.inspectionTerminal"', json_extract(provider_session_runtime.runtime_payload_json, '$."bigbud.codex.inspectionTerminal"'))
    ELSE json_remove(${base}, '$."bigbud.codex.inspectionTerminal"') END`;
}

/** Namespace-local SQL updates do not race lifecycle payload replacement or acknowledgements. */
export function inspectionStore(
  sql: SqlClient.SqlClient,
): Pick<
  ProviderSessionRuntimeRepositoryShape,
  "storeInspectionTerminal" | "acknowledgeInspectionTerminal" | "listInspectionTerminals"
> {
  return {
    storeInspectionTerminal: (threadId, record, eventId, epoch, nativeThreadId) =>
      sql<{ threadId: string }>`
      UPDATE provider_session_runtime SET runtime_payload_json = CASE
        WHEN json_extract(runtime_payload_json, '$."bigbud.codex.inspectionTerminal".terminal.eventId') = ${eventId}
          THEN runtime_payload_json
        ELSE json_set(CASE WHEN json_type(runtime_payload_json) = 'object' THEN runtime_payload_json ELSE '{}' END,
          '$."bigbud.codex.inspectionTerminal"', json(${JSON.stringify(record)})) END
      WHERE thread_id = ${threadId} AND provider_name = 'codex'
        AND json_extract(runtime_payload_json, '$.sessionEpoch') = ${epoch}
        AND json_extract(resume_cursor_json, '$.threadId') = ${nativeThreadId}
        AND (NOT (${inspectionPending(sql)}) OR json_extract(runtime_payload_json, '$."bigbud.codex.inspectionTerminal".terminal.eventId') = ${eventId})
      RETURNING thread_id AS "threadId"
    `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(toPersistenceSqlError("ProviderSessionRuntime.storeInspectionTerminal")),
      ),
    acknowledgeInspectionTerminal: (threadId, eventId, consumer) => {
      if (!["ingestion", "checkpoint", "recovery"].includes(consumer))
        return Effect.fail(
          toPersistenceSqlError("ProviderSessionRuntime.acknowledgeInspectionTerminal")(
            "Unknown terminal consumer",
          ),
        );
      return sql`UPDATE provider_session_runtime SET runtime_payload_json = json_set(runtime_payload_json,
        ${`$."bigbud.codex.inspectionTerminal".acknowledgements.${consumer}`}, json('true'))
        WHERE thread_id = ${threadId} AND json_extract(runtime_payload_json, '$."bigbud.codex.inspectionTerminal".terminal.eventId') = ${eventId}
          AND json_extract(runtime_payload_json, '$."bigbud.codex.inspectionTerminal".version') = 1
      `.pipe(
        Effect.asVoid,
        Effect.mapError(
          toPersistenceSqlError("ProviderSessionRuntime.acknowledgeInspectionTerminal"),
        ),
      );
    },
    listInspectionTerminals: (after = "") =>
      sql<{ threadId: ThreadId; record: string }>`
      SELECT thread_id AS "threadId", json_extract(runtime_payload_json, '$."bigbud.codex.inspectionTerminal"') AS record
      FROM provider_session_runtime WHERE thread_id > ${after} AND ${inspectionPending(sql)}
      ORDER BY thread_id LIMIT 100
    `.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            threadId: row.threadId,
            record: JSON.parse(row.record) as unknown,
          })),
        ),
        Effect.mapError(toPersistenceSqlError("ProviderSessionRuntime.listInspectionTerminals")),
      ),
  };
}
