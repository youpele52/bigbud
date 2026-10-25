import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { insertProjectionThreadParent } from "../Layers/ProjectionThread.test.helpers.ts";
import migration from "./135_ProjectionSessionRetainedFamily.ts";

it.effect(
  "upgrades legacy session rows to false and is idempotent without clearing retained true",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 134 });
      const threadId = ThreadId.makeUnsafe("legacy-retained-family");
      yield* insertProjectionThreadParent({ sql, threadId });
      yield* sql`INSERT INTO projection_thread_sessions (thread_id, status, provider_name, runtime_mode, active_turn_id, last_error, updated_at)
    VALUES (${threadId}, 'ready', 'opencodeV2', 'full-access', NULL, NULL, '2026-10-21T00:00:00.000Z')`;
      yield* runMigrations();
      const legacy = yield* sql<{
        retained: number;
      }>`SELECT retained_family AS retained FROM projection_thread_sessions WHERE thread_id = ${threadId}`;
      assert.deepEqual(legacy, [{ retained: 0 }]);
      yield* sql`UPDATE projection_thread_sessions SET retained_family = 1 WHERE thread_id = ${threadId}`;
      yield* migration;
      const retained = yield* sql<{
        retained: number;
      }>`SELECT retained_family AS retained FROM projection_thread_sessions WHERE thread_id = ${threadId}`;
      assert.deepEqual(retained, [{ retained: 1 }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
