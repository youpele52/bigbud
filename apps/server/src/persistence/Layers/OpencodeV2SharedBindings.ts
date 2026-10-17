import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError, toPersistenceDecodeCauseError } from "../Errors.ts";
import {
  OpencodeV2SharedBindings,
  OpencodeV2SharedBinding,
  OpencodeV2SharedBindingConflict,
  V2_SHARED_BINDING_CONFLICT_DETAILS,
} from "../Services/OpencodeV2SharedBindings.ts";

/** Immutable material plus SQL CAS; neither a TTL nor runtime deletion releases intent. */
export const OpencodeV2SharedBindingsLive = Layer.effect(
  OpencodeV2SharedBindings,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    type Row = { materialJson: string; state: OpencodeV2SharedBinding["state"]; revision: number };
    const decode = (row: Row) =>
      Effect.try({
        try: () =>
          Schema.decodeUnknownSync(OpencodeV2SharedBinding)({
            ...JSON.parse(row.materialJson),
            state: row.state,
            revision: row.revision,
          }),
        catch: toPersistenceDecodeCauseError("OpencodeV2SharedBindings.decode"),
      });
    const find = Effect.fn("OpencodeV2SharedBindings.find")(function* (threadId: string) {
      const rows = yield* sql<Row>`SELECT material_json AS "materialJson", state, revision
      FROM opencode_v2_shared_bindings WHERE thread_id = ${threadId}`.pipe(
        Effect.mapError(toPersistenceSqlError("OpencodeV2SharedBindings.find")),
      );
      return rows[0] ? yield* decode(rows[0]) : undefined;
    });
    const conflict = (reason: keyof typeof V2_SHARED_BINDING_CONFLICT_DETAILS) =>
      new OpencodeV2SharedBindingConflict({
        detail: V2_SHARED_BINDING_CONFLICT_DETAILS[reason],
      });
    return {
      find,
      reserve: Effect.fn("OpencodeV2SharedBindings.reserve")(function* (input) {
        const {
          state: _state,
          revision: _revision,
          ...material
        } = yield* Effect.try({
          try: () =>
            Schema.decodeUnknownSync(OpencodeV2SharedBinding)({
              ...input,
              state: "reserved",
              revision: 0,
            }),
          catch: () => conflict("invalidMaterial"),
        });
        const serialized = JSON.stringify(material);
        yield* sql`INSERT INTO opencode_v2_shared_bindings (thread_id, material_json, state, revision)
        VALUES (${material.threadId}, ${serialized}, 'reserved', 0) ON CONFLICT DO NOTHING`.pipe(
          Effect.mapError(toPersistenceSqlError("OpencodeV2SharedBindings.reserve")),
        );
        const row = yield* find(input.threadId);
        if (!row) return yield* conflict("missingReservation");
        const { state: _s, revision: _r, ...existing } = row;
        if (JSON.stringify(existing) !== serialized) return yield* conflict("materialMismatch");
        return row;
      }),
      transition: Effect.fn("OpencodeV2SharedBindings.transition")(function* (row, state) {
        if (row.state === state || (state === "dispatch-intent" && row.state !== "reserved"))
          return yield* conflict("invalidTransition");
        const { state: _state, revision: _revision, ...material } = row;
        const updated =
          yield* sql<Row>`UPDATE opencode_v2_shared_bindings SET state = ${state}, revision = revision + 1
        WHERE thread_id = ${row.threadId} AND state = ${row.state} AND revision = ${row.revision}
        AND material_json = ${JSON.stringify(material)}
        RETURNING material_json AS "materialJson", state, revision`.pipe(
            Effect.mapError(toPersistenceSqlError("OpencodeV2SharedBindings.transition")),
          );
        if (!updated[0]) return yield* conflict("staleTransition");
        return yield* decode(updated[0]);
      }),
      hasRecords: sql<{
        present: number;
      }>`SELECT 1 AS present FROM opencode_v2_shared_bindings LIMIT 1`.pipe(
        Effect.map((rows) => rows.length !== 0),
        Effect.mapError(toPersistenceSqlError("OpencodeV2SharedBindings.hasRecords")),
      ),
    };
  }),
);
