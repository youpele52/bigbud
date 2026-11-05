import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceDecodeCauseError, toPersistenceSqlError } from "../Errors.ts";
import {
  MuseSessionBinding,
  MuseSessionBindingConflict,
  MuseSessionBindings,
  type MuseSessionBindingsShape,
} from "../Services/MuseSessionBindings.ts";

type Row = Omit<MuseSessionBinding, "revision"> & { revision: number };

const columns = (sql: SqlClient.SqlClient) => sql`thread_id AS "threadId",
  native_session_id AS "nativeSessionId", creation_command_id AS "creationCommandId",
  workspace, storage_identity AS "storageIdentity",
  selection_fingerprint AS "selectionFingerprint", created_at AS "createdAt", phase, revision`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decode = (row: Row) =>
    Effect.try({
      try: () => Schema.decodeUnknownSync(MuseSessionBinding)(row),
      catch: toPersistenceDecodeCauseError("MuseSessionBindings.decode"),
    });
  const find: MuseSessionBindingsShape["find"] = Effect.fn("MuseSessionBindings.find")(
    function* (threadId) {
      const rows = yield* sql<Row>`SELECT ${columns(sql)} FROM muse_session_bindings
        WHERE thread_id = ${threadId}`.pipe(
        Effect.mapError(toPersistenceSqlError("MuseSessionBindings.find")),
      );
      return rows[0] ? yield* decode(rows[0]) : undefined;
    },
  );
  return {
    find,
    reserve: Effect.fn("MuseSessionBindings.reserve")(function* (input) {
      const row = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(MuseSessionBinding)({
            ...input,
            phase: "reserved",
            revision: 0,
          }),
        catch: toPersistenceDecodeCauseError("MuseSessionBindings.reserve"),
      });
      yield* sql`INSERT INTO muse_session_bindings (
          thread_id, native_session_id, creation_command_id, workspace, storage_identity,
          selection_fingerprint, created_at, phase, revision
        ) VALUES (${row.threadId}, ${row.nativeSessionId}, ${row.creationCommandId}, ${row.workspace},
          ${row.storageIdentity}, ${row.selectionFingerprint}, ${row.createdAt}, 'reserved', 0)
        ON CONFLICT(thread_id) DO NOTHING`.pipe(
        Effect.mapError(toPersistenceSqlError("MuseSessionBindings.reserve")),
      );
      const existing = yield* find(row.threadId);
      if (!existing) {
        return yield* new MuseSessionBindingConflict({
          detail: "Muse session binding reservation did not persist.",
        });
      }
      const sameMaterial =
        existing.nativeSessionId === row.nativeSessionId &&
        existing.creationCommandId === row.creationCommandId &&
        existing.workspace === row.workspace &&
        existing.storageIdentity === row.storageIdentity &&
        existing.selectionFingerprint === row.selectionFingerprint;
      if (!sameMaterial) {
        return yield* new MuseSessionBindingConflict({
          detail:
            "Thread is already bound to different Muse session material; no replacement session may be created.",
        });
      }
      return existing;
    }),
    transition: Effect.fn("MuseSessionBindings.transition")(function* (current, phase) {
      if (current.phase !== "reserved") {
        return yield* new MuseSessionBindingConflict({
          detail: `Muse session binding cannot move from ${current.phase} to ${phase}.`,
        });
      }
      const rows = yield* sql<Row>`UPDATE muse_session_bindings
        SET phase = ${phase}, revision = revision + 1
        WHERE thread_id = ${current.threadId} AND phase = ${current.phase}
          AND revision = ${current.revision} AND native_session_id = ${current.nativeSessionId}
          AND creation_command_id = ${current.creationCommandId}
        RETURNING ${columns(sql)}`.pipe(
        Effect.mapError(toPersistenceSqlError("MuseSessionBindings.transition")),
      );
      if (!rows[0]) {
        return yield* new MuseSessionBindingConflict({
          detail: "Stale Muse session binding fence; re-read before retrying.",
        });
      }
      return yield* decode(rows[0]);
    }),
  } satisfies MuseSessionBindingsShape;
});

export const MuseSessionBindingsLive = Layer.effect(MuseSessionBindings, make);
