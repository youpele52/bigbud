import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  ThreadOrganizationNativeOperation as OrganizationOperation,
  ThreadOrganizationNativeOutcome as OrganizationOperationOutcome,
} from "@bigbud/contracts/orchestration/orchestration.organization.native.ts";
import type { PreparedOrganizationOperation } from "../Services/ThreadOrganizationOperations.ts";

type Row = {
  payload_json: string;
  payload_digest: string;
  outcome_json: string | null;
  attempt: number;
  operation_id: string;
};
const canonicalOperation = (operation: OrganizationOperation) =>
  JSON.stringify([
    operation.operationId,
    operation.occurrenceId,
    operation.attempt,
    operation.threadId,
    operation.backendNonce,
    operation.generation,
    operation.policyVersion,
    operation.factVersion,
    operation.expectedRevision,
    operation.from,
    operation.destination,
    operation.reason,
    operation.snoozeId,
    operation.inactivityCutoffMs,
    operation.createdAtMs,
    operation.batchId ?? null,
  ]);
const decode = (row: Row) =>
  Effect.gen(function* () {
    const operation = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(OrganizationOperation),
    )(row.payload_json);
    const outcome =
      row.outcome_json === null
        ? null
        : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OrganizationOperationOutcome))(
            row.outcome_json,
          );
    return { operation, outcome } satisfies PreparedOrganizationOperation;
  });

/** Settled rows are needed only briefly: identical retransmissions within one native session
 * (seconds), a not-due chain until its retry, and the thread's current Undo target. Anything
 * older is history. Prepared rows are never pruned; recovery resolves them.
 */
export const ORGANIZATION_OPERATION_RETENTION = {
  ageMs: 7 * 24 * 60 * 60 * 1000,
  batch: 500,
} as const;

/** No scheduler or dispatch side effects. Call settle in the canonical command transaction,
 * after reading its receipt. A failed transport does NOT authorize a new operation ID.
 */
export const makeThreadOrganizationOperations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lock = () =>
    sql`UPDATE thread_organization_runtime SET singleton = singleton WHERE singleton = 1`;
  const inspect = (id: string) =>
    sql<Row>`SELECT * FROM thread_organization_operations WHERE operation_id = ${id}`;
  const read = Effect.fn("ThreadOrganizationOperations.read")(
    function* (id: string) {
      const [row] = yield* inspect(id);
      return row ? yield* decode(row) : undefined;
    },
    Effect.mapError(toPersistenceSqlError("ThreadOrganizationOperations.read")),
  );

  const prepare = Effect.fn("ThreadOrganizationOperations.prepare")(
    function* (request: OrganizationOperation) {
      const input = yield* Schema.decodeUnknownEffect(OrganizationOperation)(request);
      const digest = createHash("sha256").update(canonicalOperation(input)).digest("hex");
      const payload = JSON.stringify(input);
      if (
        Buffer.byteLength(payload) > 16_384 ||
        input.generation === 0 ||
        input.policyVersion === 0 ||
        input.factVersion === 0
      )
        return { status: "conflict" as const };
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lock();
          const [existing] = yield* inspect(input.operationId);
          if (existing)
            return existing.payload_digest === digest
              ? { status: "duplicate" as const, value: yield* decode(existing) }
              : { status: "conflict" as const };
          const previous = yield* sql<Row>`SELECT * FROM thread_organization_operations
        WHERE occurrence_id = ${input.occurrenceId} ORDER BY attempt DESC LIMIT 1`;
          const prior = previous[0];
          if (
            input.attempt === 0
              ? prior !== undefined
              : !prior || prior.attempt + 1 !== input.attempt
          )
            return { status: "conflict" as const };
          if (prior) {
            const old = yield* decode(prior);
            if (
              old.outcome?.status !== "not-due" ||
              old.outcome.retryNotBeforeMs > input.createdAtMs ||
              old.operation.threadId !== input.threadId ||
              old.operation.reason !== input.reason ||
              old.operation.factVersion !== input.factVersion ||
              old.operation.expectedRevision !== input.expectedRevision ||
              old.operation.policyVersion !== input.policyVersion ||
              old.operation.destination !== input.destination ||
              old.operation.from !== input.from ||
              old.operation.snoozeId !== input.snoozeId ||
              old.operation.inactivityCutoffMs !== input.inactivityCutoffMs
            )
              return { status: "conflict" as const };
          }
          const [threadPending] = yield* sql`SELECT 1 FROM thread_organization_operations
        WHERE thread_id = ${input.threadId} AND status = 'prepared' LIMIT 1`;
          if (threadPending) return { status: "conflict" as const };
          const [pending] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM thread_organization_operations WHERE status = 'prepared'`;
          if ((pending?.count ?? 32) >= 32) return { status: "capacity" as const };
          yield* sql`INSERT INTO thread_organization_operations
        (operation_id, occurrence_id, attempt, thread_id, payload_digest, payload_json, created_at_ms)
        VALUES (${input.operationId}, ${input.occurrenceId}, ${input.attempt}, ${input.threadId}, ${digest}, ${payload}, ${input.createdAtMs})`;
          return { status: "prepared" as const, value: { operation: input, outcome: null } };
        }),
      );
    },
    Effect.mapError(toPersistenceSqlError("ThreadOrganizationOperations.prepare")),
  );

  const settle = Effect.fn("ThreadOrganizationOperations.settle")(
    function* (id: string, request: OrganizationOperationOutcome) {
      const outcome = yield* Schema.decodeUnknownEffect(OrganizationOperationOutcome)(request);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* lock();
          const [row] = yield* inspect(id);
          if (!row) return "missing" as const;
          const json = JSON.stringify(outcome);
          if (row.outcome_json !== null)
            return row.outcome_json === json ? ("duplicate" as const) : ("conflict" as const);
          const operation = (yield* decode(row)).operation;
          if (
            outcome.status === "not-due" &&
            outcome.retryNotBeforeMs - operation.createdAtMs < 1000
          )
            return "conflict" as const;
          if (
            outcome.status === "applied" &&
            outcome.resultRevision !== operation.expectedRevision + 1
          )
            return "conflict" as const;
          yield* sql`UPDATE thread_organization_operations SET status = ${outcome.status}, outcome_json = ${json}
        WHERE operation_id = ${id} AND status = 'prepared'`;
          return "applied" as const;
        }),
      );
    },
    Effect.mapError(toPersistenceSqlError("ThreadOrganizationOperations.settle")),
  );

  const pending = Effect.fn("ThreadOrganizationOperations.pending")(
    function* () {
      const rows =
        yield* sql<Row>`SELECT * FROM thread_organization_operations WHERE status = 'prepared'
      ORDER BY operation_id LIMIT 32`;
      return yield* Effect.forEach(rows, decode);
    },
    Effect.mapError(toPersistenceSqlError("ThreadOrganizationOperations.pending")),
  );
  /** Deletes settled history older than the retention window in short batches, so canonical
   * commands interleave. A not-due row ages from its retry deadline, and a row that is still
   * some thread's latest automatic move (the Undo target) is kept at any age.
   */
  const prune = Effect.fn("ThreadOrganizationOperations.prune")(
    function* (nowMs: number) {
      const { ageMs, batch } = ORGANIZATION_OPERATION_RETENTION;
      const cutoff = nowMs - ageMs;
      let removed = 0;
      while (true) {
        const deleted = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* lock();
            return yield* sql<{ id: string }>`DELETE FROM thread_organization_operations
        WHERE operation_id IN (SELECT operation_id FROM thread_organization_operations
          WHERE status <> 'prepared'
          AND MAX(created_at_ms, CASE WHEN status = 'not-due'
            THEN COALESCE(json_extract(outcome_json, '$.retryNotBeforeMs'), 9007199254740991)
            ELSE 0 END) < ${cutoff}
          AND operation_id NOT IN (SELECT latest_automatic_move_id
            FROM thread_organization_runtime_threads WHERE latest_automatic_move_id IS NOT NULL)
          LIMIT ${batch})
        RETURNING operation_id AS id`;
          }),
        );
        removed += deleted.length;
        if (deleted.length < batch) return removed;
        yield* Effect.yieldNow;
      }
    },
    Effect.mapError(toPersistenceSqlError("ThreadOrganizationOperations.prune")),
  );
  return { read, prepare, settle, pending, prune };
});
