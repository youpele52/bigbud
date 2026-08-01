import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./062_ProjectionThreadQueuedPrompts.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "062_ProjectionThreadQueuedPrompts",
  (it) => {
    it.effect("adds durable queued prompt JSON with an empty legacy default", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 61 });
        yield* migration;
        const columns = yield* sql<{ readonly name: string; readonly defaultValue: string | null }>`
          SELECT name, dflt_value AS "defaultValue"
          FROM pragma_table_info('projection_threads')
          WHERE name = 'queued_prompts_json'
        `;
        assert.deepEqual(columns, [{ name: "queued_prompts_json", defaultValue: "'[]'" }]);
      }),
    );
  },
);
