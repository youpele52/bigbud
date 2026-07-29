import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_ProviderSelectionQuarantine", (it) => {
  it.effect("creates empty inventory and quarantine tables without backfilling provider rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });

      const inventory = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM provider_selection_inventory
      `;
      const quarantine = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM provider_selection_quarantine
      `;

      assert.deepStrictEqual(inventory, [{ count: 0 }]);
      assert.deepStrictEqual(quarantine, [{ count: 0 }]);
    }),
  );
});
