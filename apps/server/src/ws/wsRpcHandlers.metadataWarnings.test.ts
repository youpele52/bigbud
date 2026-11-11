import { METADATA_WARNING_WS_METHODS as methods } from "@bigbud/contracts/server/metadataWarnings.ts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeWsRpcMetadataWarningHandlers } from "./wsRpcHandlers.metadataWarnings.ts";

const seed = Effect.fn("seedWarningDelivery")(function* (count = 1) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM thread_metadata_generation_warnings`;
  for (let index = 0; index < count; index += 1) {
    const id = `warning-${String(index).padStart(2, "0")}`;
    yield* sql`INSERT INTO thread_metadata_generation_warnings
      (warning_id, config_epoch, thread_id, operation, created_at)
      VALUES (${id}, ${id}, 'thread', 'title', '2026-11-09T00:00:00.000Z')`;
  }
});

it.effect("fails closed without persistence for both delivery operations", () =>
  Effect.gen(function* () {
    const handlers = yield* makeWsRpcMetadataWarningHandlers;
    for (const call of [
      handlers[methods.claim]({ clientId: "main" }).pipe(Effect.asVoid),
      handlers[methods.acknowledge]({ clientId: "main", warningId: "warning-00" }).pipe(
        Effect.asVoid,
      ),
    ]) {
      const error = yield* call.pipe(Effect.flip);
      assert.strictEqual(error.code, "unavailable");
    }
  }),
);

it.layer(SqlitePersistenceMemory)("metadata warning RPC delivery", (it) => {
  it.effect("atomically claims ten rows and skips another renderer's live page", () =>
    Effect.gen(function* () {
      yield* seed(12);
      const handlers = yield* makeWsRpcMetadataWarningHandlers;
      const [main, compact] = yield* Effect.all(
        [
          handlers[methods.claim]({ clientId: "main" }),
          handlers[methods.claim]({ clientId: "compact" }),
        ],
        { concurrency: 2 },
      );
      assert.deepStrictEqual(
        [main.length, compact.length].toSorted((a, b) => a - b),
        [2, 10],
      );
      assert.strictEqual(new Set([...main, ...compact].map((warning) => warning.id)).size, 12);
      assert.isTrue([...main, ...compact].every((warning) => warning.primaryFailures === 3));
    }),
  );

  it.effect("uses server time, renews only the owner, and permits takeover at expiry", () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const handlers = yield* makeWsRpcMetadataWarningHandlers;
      const now = yield* Clock.currentTimeMillis;
      yield* handlers[methods.claim]({ clientId: "main" });
      const [stored] = yield* sql<{ claim_until: string }>`SELECT claim_until
        FROM thread_metadata_generation_warnings`;
      assert.strictEqual(stored!.claim_until, new Date(now + 60_000).toISOString());
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual((yield* handlers[methods.claim]({ clientId: "main" })).length, 1);
      yield* TestClock.adjust("30 seconds");
      assert.deepStrictEqual(yield* handlers[methods.claim]({ clientId: "compact" }), []);
      assert.isFalse(
        yield* handlers[methods.acknowledge]({ clientId: "compact", warningId: "warning-00" }),
      );
      yield* TestClock.adjust("30 seconds");
      assert.isFalse(
        yield* handlers[methods.acknowledge]({ clientId: "main", warningId: "warning-00" }),
      );
      assert.strictEqual((yield* handlers[methods.claim]({ clientId: "compact" })).length, 1);
      assert.isFalse(
        yield* handlers[methods.acknowledge]({ clientId: "main", warningId: "warning-00" }),
      );
      assert.isTrue(
        yield* handlers[methods.acknowledge]({ clientId: "compact", warningId: "warning-00" }),
      );
      assert.deepStrictEqual(yield* handlers[methods.claim]({ clientId: "compact" }), []);
      yield* TestClock.adjust("2 minutes");
      assert.deepStrictEqual(yield* handlers[methods.claim]({ clientId: "reconnected" }), []);
    }),
  );

  it.effect("keeps pending claims across handler reconstruction after disconnect", () =>
    Effect.gen(function* () {
      yield* seed();
      const first = yield* makeWsRpcMetadataWarningHandlers;
      const warnings = yield* first[methods.claim]({ clientId: "main" });
      const reconnected = yield* makeWsRpcMetadataWarningHandlers;
      assert.deepStrictEqual(yield* reconnected[methods.claim]({ clientId: "main" }), warnings);
      assert.deepStrictEqual(yield* reconnected[methods.claim]({ clientId: "other" }), []);
      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(yield* reconnected[methods.claim]({ clientId: "other" }), warnings);
    }),
  );

  it.effect("maps persistence failures to safe delivery errors without SQL details", () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      const handlers = yield* makeWsRpcMetadataWarningHandlers;
      yield* handlers[methods.claim]({ clientId: "main" });
      yield* sql`CREATE TEMP TRIGGER reject_warning_delivery BEFORE UPDATE
        ON thread_metadata_generation_warnings BEGIN SELECT RAISE(ABORT, 'secret-test-value'); END`;
      for (const call of [
        handlers[methods.claim]({ clientId: "main" }).pipe(Effect.asVoid),
        handlers[methods.acknowledge]({ clientId: "main", warningId: "warning-00" }).pipe(
          Effect.asVoid,
        ),
      ]) {
        const error = yield* call.pipe(Effect.flip);
        assert.strictEqual(error.code, "failed");
        assert.notInclude(error.message, "secret-test-value");
        assert.notInclude(JSON.stringify(error), "secret-test-value");
      }
      yield* sql`DROP TRIGGER reject_warning_delivery`;
      assert.strictEqual((yield* handlers[methods.claim]({ clientId: "main" })).length, 1);
    }),
  );
});
