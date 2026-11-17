import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { RemoteRuntimeUpdateOperationsLive } from "../Layers/RemoteRuntimeUpdateOperations.ts";
import {
  RemoteRuntimeUpdateOperations,
  type RemoteRuntimeUpdateRecord,
} from "../Services/RemoteRuntimeUpdateOperations.ts";

const record = (n: number): RemoteRuntimeUpdateRecord => ({
  operationId: `00000000-0000-4000-8000-00000000000${n}`,
  requestId: `00000000-0000-4000-9000-00000000000${n}`,
  version: "2.0.0",
  source: "release",
  state: "pending",
  interruptRequested: false,
  archiveKey: null,
  consentState: "none",
  consentDigest: null,
  failure: null,
  createdAt: `2026-11-17T00:00:0${n}.000Z`,
  updatedAt: `2026-11-17T00:00:0${n}.000Z`,
});

it.effect("174 creates the single-flight runtime update operation table on upgrade", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 173 });
    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'remote_runtime_update_operations'`,
      [],
    );
    yield* runMigrations({ toMigrationInclusive: 174 });
    const columns = (yield* sql<{
      name: string;
    }>`PRAGMA table_info(remote_runtime_update_operations)`).map((column) => column.name);
    assert.includeMembers(columns, ["operation_id", "state", "live", "consent_digest"]);

    const operations = yield* RemoteRuntimeUpdateOperations;
    const first = yield* operations.insert(record(1));
    assert.deepStrictEqual(first, record(1));
    // Single flight: a second live operation conflicts.
    const conflict = yield* Effect.flip(operations.insert(record(2)));
    assert.equal(conflict._tag, "RemoteRuntimeUpdateLiveConflict");
    assert.deepStrictEqual(yield* operations.findLive(), first);

    // Compare-and-set only applies from the expected state, and settling frees the slot.
    assert.isUndefined(
      yield* operations.compareAndSet(
        first.operationId,
        { states: ["staged"] },
        {
          state: "failed",
          updatedAt: "x",
        },
      ),
    );
    const failed = yield* operations.compareAndSet(
      first.operationId,
      { states: ["pending"] },
      {
        state: "failed",
        failure: "boom",
        updatedAt: "2026-11-17T00:01:00.000Z",
      },
    );
    assert.equal(failed?.state, "failed");
    assert.isUndefined(yield* operations.findLive());
    assert.equal((yield* operations.insert(record(2))).operationId, record(2).operationId);
    assert.equal((yield* operations.findLatest())?.operationId, record(2).operationId);

    // The table refuses a live terminal row or a non-live pending row.
    const invalid = yield* Effect.flip(
      sql`UPDATE remote_runtime_update_operations SET live = NULL
        WHERE operation_id = ${record(2).operationId}`,
    );
    assert.match(String(invalid), /CHECK|constraint/i);
    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 174 }), []);
  }).pipe(
    Effect.provide(
      RemoteRuntimeUpdateOperationsLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
    ),
  ),
);
