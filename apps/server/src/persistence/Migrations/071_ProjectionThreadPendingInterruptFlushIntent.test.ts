import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./071_ProjectionThreadPendingInterruptFlushIntent.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "071_ProjectionThreadPendingInterruptFlushIntent",
  (it) => {
    it.effect("adds nullable durable Send now intent for legacy projections", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 70 });
        yield* migration;
        const columns = yield* sql<{ readonly name: string; readonly defaultValue: string | null }>`
          SELECT name, dflt_value AS "defaultValue"
          FROM pragma_table_info('projection_threads')
          WHERE name = 'pending_interrupt_flush_intent_json'
        `;
        assert.deepEqual(columns, [
          { name: "pending_interrupt_flush_intent_json", defaultValue: null },
        ]);
      }),
    );
  },
);
