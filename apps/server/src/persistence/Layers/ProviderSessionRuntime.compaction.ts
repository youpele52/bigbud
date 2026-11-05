import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Fragment } from "effect/unstable/sql/Statement";
import { toPersistenceSqlError } from "../Errors.ts";
import type { ProviderSessionRuntimeRepositoryShape } from "../Services/ProviderSessionRuntime.ts";
import { inspectionPending } from "./ProviderSessionRuntime.inspection.ts";

const PATH = '$."bigbud.codex.compactions"';

/** Ordinary replacements cannot erase, inject or overwrite the append-only proof namespace. */
export function preserveCodexCompactions(sql: SqlClient.SqlClient, payload: Fragment) {
  return sql`CASE WHEN json_extract(provider_session_runtime.runtime_payload_json, ${PATH}) IS NOT NULL
    THEN json_set(CASE WHEN json_type(${payload}) = 'object' THEN ${payload} ELSE '{}' END,
      ${PATH}, json_extract(provider_session_runtime.runtime_payload_json, ${PATH}))
    ELSE json_remove(${payload}, ${PATH}) END`;
}

/** SQL CAS preserves other payload namespaces and serializes concurrent proof/lifecycle writers. */
export function makeRecordCodexCompaction(
  sql: SqlClient.SqlClient,
): NonNullable<ProviderSessionRuntimeRepositoryShape["recordCodexCompaction"]> {
  return (input) => {
    const threadPath = `${PATH}.threads.${JSON.stringify(input.nativeThreadId)}`;
    const proofPath = `${threadPath}.${JSON.stringify(input.turnId)}`;
    return sql<{ threadId: string }>`UPDATE provider_session_runtime SET runtime_payload_json =
      json_set(CASE WHEN json_type(runtime_payload_json) = 'object' THEN runtime_payload_json ELSE '{}' END,
        ${PATH}, json_set(COALESCE(json_extract(runtime_payload_json, ${PATH}), '{"version":1,"threads":{}}'),
          ${`$.threads.${JSON.stringify(input.nativeThreadId)}.${JSON.stringify(input.turnId)}`}, ${input.itemId}))
      WHERE thread_id = ${input.threadId} AND provider_name = 'codex'
        AND json_extract(runtime_payload_json, '$.sessionEpoch') = ${input.sessionEpoch}
        AND json_extract(resume_cursor_json, '$.threadId') = ${input.nativeThreadId}
        AND json_extract(runtime_payload_json, '$."bigbud.codex.rewind"') IS NULL
        AND NOT (${inspectionPending(sql)})
        AND (json_extract(runtime_payload_json, ${PATH}) IS NULL OR
          (json_extract(runtime_payload_json, ${`${PATH}.version`}) = 1 AND
           json_type(runtime_payload_json, ${`${PATH}.threads`}) = 'object'))
        AND (json_extract(runtime_payload_json, ${proofPath}) IS NULL OR
          json_extract(runtime_payload_json, ${proofPath}) = ${input.itemId})
        AND (json_extract(runtime_payload_json, ${threadPath}) IS NULL OR
          json_type(runtime_payload_json, ${threadPath}) = 'object')
      RETURNING thread_id AS "threadId"`.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toPersistenceSqlError("ProviderSessionRuntimeRepository.recordCodexCompaction"),
      ),
    );
  };
}
