import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { makeThreadOrganizationOperations } from "./ThreadOrganizationOperations.ts";
import { operation } from "./ThreadOrganizationOperations.test.helpers.ts";

it.effect("reopens uncertain/confirmed attempts without recreating IDs or losing outcomes", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "bigbud-organization-operations-"))),
      (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
    );
    const filename = join(directory, "state.sqlite");
    yield* Effect.gen(function* () {
      yield* runMigrations();
      const repository = yield* makeThreadOrganizationOperations;
      assert.equal((yield* repository.prepare(operation)).status, "prepared");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    yield* Effect.gen(function* () {
      const repository = yield* makeThreadOrganizationOperations;
      assert.deepEqual(yield* repository.pending(), [{ operation, outcome: null }]);
      assert.equal((yield* repository.prepare(operation)).status, "duplicate");
      assert.equal(
        (yield* repository.prepare({ ...operation, operationId: "retry", attempt: 1 })).status,
        "conflict",
      );
      assert.equal(
        yield* repository.settle(operation.operationId, {
          status: "not-due",
          retryNotBeforeMs: 5000,
        }),
        "applied",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    const retry = { ...operation, operationId: "retry", attempt: 1, createdAtMs: 5000 };
    yield* Effect.gen(function* () {
      const repository = yield* makeThreadOrganizationOperations;
      assert.deepEqual((yield* repository.read(operation.operationId))?.outcome, {
        status: "not-due",
        retryNotBeforeMs: 5000,
      });
      assert.equal((yield* repository.prepare(retry)).status, "prepared");
      yield* repository.settle(retry.operationId, {
        status: "applied",
        resultRevision: 2,
        resultSequence: 100,
      });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    yield* Effect.gen(function* () {
      const repository = yield* makeThreadOrganizationOperations;
      assert.deepEqual(yield* repository.pending(), []);
      const recovered = yield* repository.prepare(retry);
      assert.equal(recovered.status, "duplicate");
      if (recovered.status === "duplicate")
        assert.deepEqual(recovered.value.outcome, {
          status: "applied",
          resultRevision: 2,
          resultSequence: 100,
        });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
  }),
);
