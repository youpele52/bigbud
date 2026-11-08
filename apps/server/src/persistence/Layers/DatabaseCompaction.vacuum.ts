/**
 * The one-time rebuild: `auto_vacuum = INCREMENTAL`, a full `VACUUM`, then a WAL truncate.
 *
 * All three run on one reserved write connection, so no other statement runs between them and
 * the pragma reaches the `VACUUM` that makes it take effect. `VACUUM` is atomic: a failure, a
 * crash or a killed worker leaves the previous file intact. In WAL mode the rebuilt pages land
 * in the WAL first; the closing `wal_checkpoint(TRUNCATE)` copies them back and shrinks the
 * file. Readers on other connections can keep that checkpoint from finishing; the steady-state
 * step retries it later.
 *
 * @module DatabaseCompaction.vacuum
 */
import type { DatabaseCompactionPhase } from "@bigbud/contracts/server/databaseCompaction.ts";
import { Cause, Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";

import { toAutoVacuumMode } from "./DatabaseCompaction.policy.ts";

export interface WalCheckpointResult {
  readonly busy: boolean;
  readonly logPages: number;
  readonly checkpointedPages: number;
}

/**
 * Lazy on purpose: the in-process client prepares when the Effect is built, and SQLite applies
 * pragmas such as `busy_timeout` at prepare time, so an eagerly built restore would run early.
 * Unprepared statements also run to completion, which `incremental_vacuum` needs.
 */
export const execute = (connection: Connection, statement: string) =>
  Effect.suspend(() => connection.executeUnprepared(statement, [], undefined));

export const firstValue = (rows: ReadonlyArray<Record<string, unknown>>): number =>
  Number(Object.values(rows[0] ?? {})[0] ?? 0);

/** `PRAGMA wal_checkpoint` returns `busy`, `log` and `checkpointed` (-1 when not in WAL mode). */
export const walCheckpoint = (connection: Connection, mode: "PASSIVE" | "TRUNCATE") =>
  execute(connection, `PRAGMA wal_checkpoint(${mode})`).pipe(
    Effect.map((rows): WalCheckpointResult => {
      const row = (rows[0] ?? {}) as Record<string, unknown>;
      return {
        busy: Number(row.busy ?? 0) !== 0,
        logPages: Math.max(0, Number(row.log ?? 0)),
        checkpointedPages: Math.max(0, Number(row.checkpointed ?? 0)),
      };
    }),
  );

/**
 * `wal_checkpoint(TRUNCATE)` with a temporary `busy_timeout`, so a reader holds the connection
 * for at most `busyTimeoutMs`. The connection must be reserved: the previous timeout is restored
 * however the checkpoint ends, and no other statement sees the temporary one.
 */
export const truncateWalWithBusyTimeout = (connection: Connection, busyTimeoutMs: number) =>
  Effect.gen(function* () {
    const previous = firstValue(yield* execute(connection, "PRAGMA busy_timeout"));
    return yield* Effect.ensuring(
      Effect.andThen(
        execute(connection, `PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`),
        walCheckpoint(connection, "TRUNCATE"),
      ),
      execute(connection, `PRAGMA busy_timeout = ${Math.max(0, Math.floor(previous))}`).pipe(
        Effect.ignore,
      ),
    );
  });

/** How long the post-failure WAL truncate waits for readers before giving up. */
export const FAILURE_WAL_TRUNCATE_BUSY_TIMEOUT_MS = 1_000;

/**
 * Best effort after a failed rebuild: a `VACUUM` that died on a full disk can leave a WAL of
 * several gigabytes behind, and the next truncate would otherwise wait for an idle steady-state
 * step. Null when the statement failed; never fails itself.
 */
export const truncateWalAfterFailure = (sql: SqlClient.SqlClient) =>
  Effect.scoped(
    Effect.flatMap(sql.reserve, (connection) =>
      truncateWalWithBusyTimeout(connection, FAILURE_WAL_TRUNCATE_BUSY_TIMEOUT_MS),
    ),
  ).pipe(
    Effect.map((result): WalCheckpointResult | null => result),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.as(
            Effect.logWarning("WAL truncate after a failed database compaction did not run", {
              cause: Cause.pretty(cause),
            }),
            null,
          ),
    ),
  );

export interface RebuildResult {
  readonly autoVacuum: ReturnType<typeof toAutoVacuumMode>;
  readonly checkpoint: WalCheckpointResult;
}

export const runIncrementalRebuild = (
  sql: SqlClient.SqlClient,
  onPhase: (phase: DatabaseCompactionPhase) => void,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* sql.reserve;
      yield* execute(connection, "PRAGMA auto_vacuum = INCREMENTAL");
      onPhase("vacuuming");
      yield* execute(connection, "VACUUM");
      onPhase("checkpointing");
      const checkpoint = yield* walCheckpoint(connection, "TRUNCATE");
      const autoVacuum = toAutoVacuumMode(
        firstValue(yield* execute(connection, "PRAGMA auto_vacuum")),
      );
      return { autoVacuum, checkpoint } satisfies RebuildResult;
    }),
  );
