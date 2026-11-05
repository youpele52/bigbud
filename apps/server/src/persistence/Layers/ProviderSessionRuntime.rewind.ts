import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../Errors.ts";
import type { ProviderSessionRuntimeRepositoryShape } from "../Services/ProviderSessionRuntime.ts";
import {
  inspectionPending,
  preserveInspectionPayload,
} from "./ProviderSessionRuntime.inspection.ts";
import {
  makeRecordCodexCompaction,
  preserveCodexCompactions,
} from "./ProviderSessionRuntime.compaction.ts";

/** Ordinary replacement writers cannot erase a marker or resurrect a cleared stale copy. */
export function preserveCodexRewindPayload(sql: SqlClient.SqlClient) {
  const rewind = sql`CASE WHEN json_extract(provider_session_runtime.runtime_payload_json, '$."bigbud.codex.rewind"') IS NOT NULL
    THEN json_set(CASE WHEN json_type(excluded.runtime_payload_json) = 'object'
      THEN excluded.runtime_payload_json ELSE '{}' END, '$."bigbud.codex.rewind"',
      json_extract(provider_session_runtime.runtime_payload_json, '$."bigbud.codex.rewind"'))
    ELSE json_remove(excluded.runtime_payload_json, '$."bigbud.codex.rewind"') END`;
  return preserveCodexCompactions(sql, preserveInspectionPayload(sql, rewind));
}

/** Reserved Codex payload writers share the existing repository composition boundary. */
export function codexMaintenanceStore(sql: SqlClient.SqlClient) {
  return {
    setCodexRewind: makeSetCodexRewind(sql),
    recordCodexCompaction: makeRecordCodexCompaction(sql),
  };
}

export function codexRewindAbsent(sql: SqlClient.SqlClient) {
  return sql`json_extract(runtime_payload_json, '$."bigbud.codex.rewind"') IS NULL AND NOT (${inspectionPending(sql)})`;
}

/** SQL CAS survives concurrent directory instances and lifecycle payload replacements. */
export function makeSetCodexRewind(
  sql: SqlClient.SqlClient,
): NonNullable<ProviderSessionRuntimeRepositoryShape["setCodexRewind"]> {
  return (threadId, marker, operationId) =>
    sql<{ threadId: string }>`
    UPDATE provider_session_runtime SET runtime_payload_json =
      CASE WHEN ${marker === null ? 1 : 0} = 1
        THEN json_remove(runtime_payload_json, '$."bigbud.codex.rewind"')
        ELSE json_set(CASE WHEN json_type(runtime_payload_json) = 'object' THEN runtime_payload_json ELSE '{}' END,
          '$."bigbud.codex.rewind"', json(${JSON.stringify(marker)})) END
    WHERE thread_id = ${threadId} AND provider_name = 'codex'
      AND (json_extract(runtime_payload_json, '$."bigbud.codex.rewind"') IS NULL
        OR json_extract(runtime_payload_json, '$."bigbud.codex.rewind".operationId') = ${operationId})
      AND (${marker === null ? 1 : 0} = 0
        OR json_extract(runtime_payload_json, '$."bigbud.codex.rewind".stage') = 'canonical-complete')
    RETURNING thread_id AS "threadId"
  `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(toPersistenceSqlError("ProviderSessionRuntimeRepository.setCodexRewind")),
    );
}
