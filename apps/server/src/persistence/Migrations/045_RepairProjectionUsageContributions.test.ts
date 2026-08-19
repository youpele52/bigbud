import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "045_RepairProjectionUsageContributions - current schema",
  (it) => {
    it.effect("does not re-add columns already created by migration 44", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 45 });

        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_usage_contributions)
        `;
        assert.ok(columns.some((column) => column.name === "model"));
        assert.ok(columns.some((column) => column.name === "interaction_mode"));
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "045_RepairProjectionUsageContributions - intermediate schema",
  (it) => {
    it.effect("repairs the intermediate migration 44 schema without losing rows", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 43 });
        yield* sql`
          CREATE TABLE projection_usage_contributions (
            contribution_id TEXT PRIMARY KEY,
            activity_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            turn_id TEXT,
            provider TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            used_tokens INTEGER NOT NULL,
            input_tokens INTEGER NOT NULL,
            cached_input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            reasoning_output_tokens INTEGER NOT NULL,
            finalized INTEGER NOT NULL,
            source_sequence INTEGER,
            updated_at TEXT NOT NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_usage_contributions (
            contribution_id,
            activity_id,
            thread_id,
            turn_id,
            provider,
            occurred_at,
            used_tokens,
            input_tokens,
            cached_input_tokens,
            output_tokens,
            reasoning_output_tokens,
            finalized,
            source_sequence,
            updated_at
          ) VALUES (
            'codex:thread-1:turn-1',
            'activity-1',
            'thread-1',
            'turn-1',
            'codex',
            '2026-07-25T00:00:00.000Z',
            100,
            70,
            10,
            20,
            0,
            1,
            1,
            '2026-07-25T00:00:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (44, 'ProjectionUsageContributions')
        `;

        yield* runMigrations({ toMigrationInclusive: 45 });

        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(projection_usage_contributions)
        `;
        assert.ok(columns.some((column) => column.name === "model"));
        assert.ok(columns.some((column) => column.name === "interaction_mode"));

        const contributionRows = yield* sql<{
          readonly contributionId: string;
          readonly model: string;
          readonly interactionMode: string;
          readonly usedTokens: number;
        }>`
          SELECT
            contribution_id AS "contributionId",
            model,
            interaction_mode AS "interactionMode",
            used_tokens AS "usedTokens"
          FROM projection_usage_contributions
        `;
        assert.deepStrictEqual(contributionRows, [
          {
            contributionId: "codex:thread-1:turn-1",
            model: "unknown",
            interactionMode: "default",
            usedTokens: 100,
          },
        ]);

        const backfillState = yield* sql<{
          readonly lastActivityId: string;
          readonly completed: number;
        }>`
          SELECT last_activity_id AS "lastActivityId", completed
          FROM projection_usage_backfill_state
          WHERE id = 1
        `;
        assert.deepStrictEqual(backfillState, [{ lastActivityId: "", completed: 0 }]);
      }),
    );
  },
);
