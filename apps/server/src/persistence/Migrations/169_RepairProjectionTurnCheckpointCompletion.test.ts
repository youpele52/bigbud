import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeThreadOperationalStateSql } from "../../orchestration/Layers/ProjectionOperationalStateQuery.threadSql.ts";
import { insertProjectionThreadParent } from "../Layers/ProjectionThread.test.helpers.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

for (const missingColumn of [true, false]) {
  it.effect(
    `repairs previously applied 168 without resetting turn evidence, missing=${missingColumn}`,
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 168 });
        // Model an installation that already recorded the earlier terminal-only 168.
        if (missingColumn)
          yield* sql`ALTER TABLE projection_turns DROP COLUMN checkpoint_completed_at`;
        const threadId = ThreadId.makeUnsafe("checkpoint-migration-recovery");
        yield* insertProjectionThreadParent({ sql, threadId });
        const at = "2026-11-11T00:00:00.000Z";
        const checkpointAt = "2026-11-11T00:00:01.000Z";
        yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, state, requested_at, completed_at, checkpoint_turn_count,
         checkpoint_ref, checkpoint_status, checkpoint_files_json, terminal_outcome)
        VALUES (${threadId}, 'checkpoint-turn', 'completed', ${at}, ${at}, 1,
          'checkpoint-ref', 'ready', '[]', NULL),
          (${threadId}, 'native-turn', 'completed', ${at}, ${at}, NULL,
          NULL, NULL, '[]', 'completed')`;
        if (!missingColumn) {
          yield* sql`UPDATE projection_turns SET checkpoint_completed_at = ${checkpointAt}
          WHERE turn_id = 'checkpoint-turn'`;
        }
        const queries = makeThreadOperationalStateSql(sql);
        if (missingColumn) {
          // A failed prepare is cached by this connection. Use a separate probe so
          // the post-upgrade production query models a clean runtime connection.
          const before = yield* Effect.exit(
            sql`SELECT checkpoint_completed_at FROM projection_turns LIMIT 0`,
          );
          assert.isTrue(Exit.isFailure(before));
        }
        yield* runMigrations();
        const checkpoints = yield* queries.listCheckpointRows({ threadId });
        assert.strictEqual(checkpoints.length, 1);
        assert.strictEqual(checkpoints[0]?.completedAt, missingColumn ? at : checkpointAt);
        assert.deepStrictEqual(
          yield* sql`SELECT turn_id, state, terminal_outcome, completed_at, checkpoint_completed_at
          FROM projection_turns ORDER BY turn_id`,
          [
            {
              turn_id: "checkpoint-turn",
              state: "completed",
              terminal_outcome: null,
              completed_at: at,
              checkpoint_completed_at: missingColumn ? at : checkpointAt,
            },
            {
              turn_id: "native-turn",
              state: "completed",
              terminal_outcome: "completed",
              completed_at: at,
              checkpoint_completed_at: null,
            },
          ],
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}
