import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { operation } from "./ThreadOrganizationOperations.test.helpers.ts";
import { makeThreadOrganizationOperations } from "./ThreadOrganizationOperations.ts";

const setup = Effect.gen(function* () {
  yield* runMigrations();
  return yield* makeThreadOrganizationOperations;
});

it.effect("retries identical immutable payloads and refuses forked uncertain outcomes", () =>
  Effect.gen(function* () {
    const repository = yield* setup;
    assert.equal((yield* repository.prepare(operation)).status, "prepared");
    assert.equal((yield* repository.prepare(operation)).status, "duplicate");
    assert.equal(
      (yield* repository.prepare({ ...operation, createdAtMs: 1001 })).status,
      "conflict",
    );
    assert.equal(
      (yield* repository.prepare({ ...operation, operationId: "fork", occurrenceId: "fork" }))
        .status,
      "conflict",
    );
    assert.equal(
      (yield* repository.prepare({ ...operation, operationId: "retry", attempt: 1 })).status,
      "conflict",
    );
    assert.deepEqual((yield* repository.read(operation.operationId))?.operation, operation);
    assert.equal((yield* repository.pending()).length, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("confirmed early no-op allows a paced new attempt without a new fact version", () =>
  Effect.gen(function* () {
    const repository = yield* setup;
    yield* repository.prepare(operation);
    assert.equal(
      yield* repository.settle(operation.operationId, {
        status: "not-due",
        retryNotBeforeMs: 1999,
      }),
      "conflict",
    );
    const early = { status: "not-due" as const, retryNotBeforeMs: 5000 };
    assert.equal(yield* repository.settle(operation.operationId, early), "applied");
    assert.equal(yield* repository.settle(operation.operationId, early), "duplicate");
    assert.equal(yield* repository.settle(operation.operationId, { status: "stale" }), "conflict");
    const retry = { ...operation, operationId: "retry", attempt: 1, createdAtMs: 4999 };
    assert.equal((yield* repository.prepare(retry)).status, "conflict");
    assert.equal((yield* repository.prepare({ ...retry, createdAtMs: 5000 })).status, "prepared");
    const applied = { status: "applied" as const, resultRevision: 2, resultSequence: 100 };
    assert.equal(yield* repository.settle("retry", applied), "applied");
    assert.equal(
      (yield* repository.prepare({
        ...retry,
        operationId: "again",
        attempt: 2,
        createdAtMs: 10000,
      })).status,
      "conflict",
    );
    assert.equal((yield* repository.pending()).length, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("bounded pending ledger and caller rollback cannot leave half-accepted proposals", () =>
  Effect.gen(function* () {
    const repository = yield* setup;
    const sql = yield* SqlClient.SqlClient;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* repository.prepare(operation);
          return yield* Effect.fail("rollback");
        }),
      )
      .pipe(Effect.flip);
    assert.equal(yield* repository.read(operation.operationId), undefined);
    for (let i = 0; i < 32; i++)
      assert.equal(
        (yield* repository.prepare({
          ...operation,
          operationId: `operation${i}`,
          occurrenceId: `occurrence${i}`,
          threadId: `thread${i}`,
        })).status,
        "prepared",
      );
    assert.equal((yield* repository.pending()).length, 32);
    assert.equal(
      (yield* repository.prepare({
        ...operation,
        operationId: "overflow",
        occurrenceId: "overflow",
        threadId: "overflow",
      })).status,
      "capacity",
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
