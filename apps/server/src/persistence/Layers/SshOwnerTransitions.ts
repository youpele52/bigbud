import { createHash, randomUUID } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import type { SqlError } from "effect/unstable/sql/SqlError";

interface WriterRow {
  readonly writerEpoch: string;
}

interface TargetSequence {
  readonly targetId: string;
  readonly seq: number;
}

interface DisconnectFlag {
  readonly targetId: string;
  readonly disconnectedAt: number;
}

export interface SshOwnerTransition {
  readonly writerEpoch: string;
  readonly targetId: string;
  readonly expectedSeq: number;
  readonly requestId: string;
  readonly desiredState: "connected" | "disconnected";
}

type Hydration =
  | { readonly kind: "epochMismatch" }
  | {
      readonly kind: "hydrated";
      readonly writerEpoch: string;
      readonly disconnectedTargets: ReadonlyArray<DisconnectFlag>;
      /** Targets without metadata have sequence zero, even when disconnected. */
      readonly sequences: ReadonlyArray<TargetSequence>;
    };

type TransitionResult =
  | { readonly kind: "epochMismatch" | "requestConflict" | "staleSequence" | "invalidSequence" }
  | { readonly kind: "committed" | "receipt"; readonly seq: number };

const execute = <Row>(
  connection: Connection,
  statement: string,
  params: ReadonlyArray<unknown> = [],
) =>
  Effect.suspend(() => connection.execute(statement, params, undefined)) as Effect.Effect<
    ReadonlyArray<Row>,
    SqlError
  >;

const withImmediateTransaction = <A, E>(
  sql: SqlClient.SqlClient,
  operation: (connection: Connection) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const connection = yield* restore(sql.reserve);
        yield* execute(connection, "BEGIN IMMEDIATE");
        // Do not interrupt an in-flight worker statement or release the reservation before settlement.
        return yield* Effect.suspend(() => operation(connection)).pipe(
          Effect.tap(() => execute(connection, "COMMIT")),
          Effect.onError(() => execute(connection, "ROLLBACK").pipe(Effect.orDie)),
        );
      }),
    ),
  ).pipe(Effect.provideService(SqlClient.SafeIntegers, false));

const isSequence = (seq: number) => Number.isSafeInteger(seq) && seq >= 0;

const transitionDigest = (input: SshOwnerTransition) => {
  const target = Buffer.from(input.targetId, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(target.length);
  const suffix = Buffer.alloc(9);
  suffix.writeBigUInt64BE(BigInt(input.expectedSeq));
  suffix[8] = input.desiredState === "connected" ? 0 : 1;
  return createHash("sha256")
    .update("bigbud.ssh_owner.v1/sqlite-transition\0", "ascii")
    .update(length)
    .update(target)
    .update(suffix)
    .digest("hex");
};

/** Privileged operation: only the external ownership-lock holder may call this, with admission closed. */
export const rotateSshOwnerWriterAndHydrate = Effect.fn("rotateSshOwnerWriterAndHydrate")(
  function* (sql: SqlClient.SqlClient, expectedPreviousEpoch: string | null) {
    return yield* withImmediateTransaction(sql, (connection) =>
      Effect.gen(function* (): Effect.fn.Return<Hydration, Error | SqlError> {
        const writerEpoch = randomUUID();
        const [installed] = yield* expectedPreviousEpoch === null
          ? execute<WriterRow>(
              connection,
              `INSERT INTO ssh_owner_writer (singleton, writer_epoch) VALUES (1, ?)
               ON CONFLICT(singleton) DO NOTHING RETURNING writer_epoch AS writerEpoch`,
              [writerEpoch],
            )
          : execute<WriterRow>(
              connection,
              `UPDATE ssh_owner_writer SET writer_epoch = ? WHERE singleton = 1 AND writer_epoch = ?
               RETURNING writer_epoch AS writerEpoch`,
              [writerEpoch, expectedPreviousEpoch],
            );
        if (!installed) return { kind: "epochMismatch" };

        const disconnectedTargets = yield* execute<DisconnectFlag>(
          connection,
          `SELECT target_id AS targetId, disconnected_at AS disconnectedAt
           FROM remote_execution_target_disconnects ORDER BY target_id`,
        );
        const sequences = yield* execute<TargetSequence>(
          connection,
          "SELECT target_id AS targetId, seq FROM ssh_target_transition ORDER BY target_id",
        );
        if (sequences.some(({ seq }) => seq === 0 || !isSequence(seq))) {
          return yield* Effect.fail(new Error("Invalid stored SSH owner transition sequence"));
        }
        return {
          kind: "hydrated",
          writerEpoch: installed.writerEpoch,
          disconnectedTargets,
          sequences,
        };
      }),
    );
  },
);

/** Private persistence adapter; callers must only publish effects for a newly committed transition. */
export const applySshOwnerTransition = Effect.fn("applySshOwnerTransition")(function* (
  sql: SqlClient.SqlClient,
  input: SshOwnerTransition,
) {
  return yield* withImmediateTransaction(sql, (connection) =>
    Effect.gen(function* (): Effect.fn.Return<TransitionResult, SqlError> {
      const [writer] = yield* execute<WriterRow>(
        connection,
        "SELECT writer_epoch AS writerEpoch FROM ssh_owner_writer WHERE singleton = 1",
      );
      if (!writer || writer.writerEpoch !== input.writerEpoch) return { kind: "epochMismatch" };
      if (!isSequence(input.expectedSeq) || input.expectedSeq === Number.MAX_SAFE_INTEGER) {
        return { kind: "invalidSequence" };
      }

      const [previous] = yield* execute<{
        readonly seq: number;
        readonly requestId: string;
        readonly digest: string;
      }>(
        connection,
        `SELECT seq, last_request_id AS requestId, last_digest AS digest
         FROM ssh_target_transition WHERE target_id = ?`,
        [input.targetId],
      );
      const seq = previous?.seq ?? 0;
      if (!isSequence(seq) || (previous && seq === 0)) return { kind: "invalidSequence" };
      const digest = transitionDigest(input);
      if (previous?.requestId === input.requestId) {
        return previous.digest === digest ? { kind: "receipt", seq } : { kind: "requestConflict" };
      }
      if (seq !== input.expectedSeq) return { kind: "staleSequence" };
      const nextSeq = seq + 1;

      if (input.desiredState === "disconnected") {
        const disconnectedAt = yield* Clock.currentTimeMillis;
        yield* execute(
          connection,
          `INSERT INTO remote_execution_target_disconnects (target_id, disconnected_at) VALUES (?, ?)
           ON CONFLICT(target_id) DO NOTHING`,
          [input.targetId, disconnectedAt],
        );
      } else {
        yield* execute(
          connection,
          "DELETE FROM remote_execution_target_disconnects WHERE target_id = ?",
          [input.targetId],
        );
      }
      yield* execute(
        connection,
        `INSERT INTO ssh_target_transition (target_id, seq, last_request_id, last_digest) VALUES (?, ?, ?, ?)
         ON CONFLICT(target_id) DO UPDATE SET seq = excluded.seq, last_request_id = excluded.last_request_id,
           last_digest = excluded.last_digest`,
        [input.targetId, nextSeq, input.requestId, digest],
      );
      return { kind: "committed", seq: nextSeq };
    }),
  );
});
