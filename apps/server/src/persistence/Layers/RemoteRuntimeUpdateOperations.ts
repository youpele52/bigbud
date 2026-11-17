import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import { toPersistenceDecodeCauseError, toPersistenceSqlError } from "../Errors.ts";
import {
  RemoteRuntimeUpdateLiveConflict,
  RemoteRuntimeUpdateOperations,
  RemoteRuntimeUpdateRecord,
  type RemoteRuntimeUpdateOperationsShape,
} from "../Services/RemoteRuntimeUpdateOperations.ts";

type Row = Omit<RemoteRuntimeUpdateRecord, "interruptRequested"> & { interruptRequested: number };

const TERMINAL = new Set(["activated", "failed", "cancelled"]);

const columns = (sql: SqlClient.SqlClient) => sql`operation_id AS "operationId",
  request_id AS "requestId", version, source, state,
  interrupt_requested AS "interruptRequested", archive_key AS "archiveKey",
  consent_state AS "consentState", consent_digest AS "consentDigest", failure,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decode = (row: Row) =>
    Effect.try({
      try: () =>
        Schema.decodeUnknownSync(RemoteRuntimeUpdateRecord)({
          ...row,
          interruptRequested: row.interruptRequested === 1,
        }),
      catch: toPersistenceDecodeCauseError("RemoteRuntimeUpdateOperations.decode"),
    });
  const one = (rows: ReadonlyArray<Row>) => (rows[0] ? decode(rows[0]) : Effect.undefined);
  const query = (
    operation: string,
    statement: Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError>,
  ) =>
    statement.pipe(
      Effect.mapError(toPersistenceSqlError(`RemoteRuntimeUpdateOperations.${operation}`)),
      Effect.flatMap(one),
    );

  const get: RemoteRuntimeUpdateOperationsShape["get"] = (operationId) =>
    query(
      "get",
      sql<Row>`SELECT ${columns(sql)} FROM remote_runtime_update_operations
        WHERE operation_id = ${operationId}`,
    );

  return {
    get,
    findByRequestId: (requestId) =>
      query(
        "findByRequestId",
        sql<Row>`SELECT ${columns(sql)} FROM remote_runtime_update_operations
          WHERE request_id = ${requestId}`,
      ),
    findLive: () =>
      query(
        "findLive",
        sql<Row>`SELECT ${columns(sql)} FROM remote_runtime_update_operations WHERE live = 1`,
      ),
    findLatest: () =>
      query(
        "findLatest",
        sql<Row>`SELECT ${columns(sql)} FROM remote_runtime_update_operations
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      ),
    insert: Effect.fn("RemoteRuntimeUpdateOperations.insert")(function* (input) {
      const r = yield* Effect.try({
        try: () => Schema.decodeUnknownSync(RemoteRuntimeUpdateRecord)(input),
        catch: toPersistenceDecodeCauseError("RemoteRuntimeUpdateOperations.insert"),
      });
      if (TERMINAL.has(r.state))
        return yield* new RemoteRuntimeUpdateLiveConflict({
          detail: "A new update operation must start live.",
        });
      yield* sql`INSERT INTO remote_runtime_update_operations (
          operation_id, request_id, version, source, state, live, interrupt_requested,
          archive_key, consent_state, consent_digest, failure, created_at, updated_at
        ) VALUES (${r.operationId}, ${r.requestId}, ${r.version}, ${r.source}, ${r.state}, 1,
          ${r.interruptRequested ? 1 : 0}, ${r.archiveKey}, ${r.consentState},
          ${r.consentDigest}, ${r.failure}, ${r.createdAt}, ${r.updatedAt})
        ON CONFLICT DO NOTHING`.pipe(
        Effect.mapError(toPersistenceSqlError("RemoteRuntimeUpdateOperations.insert")),
      );
      const stored = yield* get(r.operationId);
      if (!stored || stored.requestId !== r.requestId)
        return yield* new RemoteRuntimeUpdateLiveConflict({
          detail: "Another runtime update operation already holds the single-flight slot.",
        });
      return stored;
    }),
    compareAndSet: Effect.fn("RemoteRuntimeUpdateOperations.compareAndSet")(
      function* (operationId, expect, patch) {
        if (expect.states.length === 0) return undefined;
        const set = (column: string, value: unknown) =>
          value === undefined
            ? sql``
            : sql`, ${sql(column)} = ${typeof value === "boolean" ? (value ? 1 : 0) : (value as string | null)}`;
        const live =
          patch.state === undefined ? sql`` : sql`, live = ${TERMINAL.has(patch.state) ? null : 1}`;
        const consentGuard =
          expect.consentState === undefined
            ? sql``
            : sql` AND consent_state = ${expect.consentState}`;
        const rows = yield* sql<{ operationId: string }>`UPDATE remote_runtime_update_operations
          SET updated_at = ${patch.updatedAt}${set("state", patch.state)}${live}
            ${set("interrupt_requested", patch.interruptRequested)}
            ${set("archive_key", patch.archiveKey)}${set("consent_state", patch.consentState)}
            ${set("consent_digest", patch.consentDigest)}${set("failure", patch.failure)}
          WHERE operation_id = ${operationId} AND state IN ${sql.in(expect.states)}${consentGuard}
          RETURNING operation_id AS "operationId"`.pipe(
          Effect.mapError(toPersistenceSqlError("RemoteRuntimeUpdateOperations.compareAndSet")),
        );
        return rows.length === 0 ? undefined : yield* get(operationId);
      },
    ),
  } satisfies RemoteRuntimeUpdateOperationsShape;
});

export const RemoteRuntimeUpdateOperationsLive = Layer.effect(RemoteRuntimeUpdateOperations, make);
