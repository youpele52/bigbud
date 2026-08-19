import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { insertProjectionThreadParent } from "../Layers/ProjectionThread.test.helpers.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("092_AutomationThreadOwnership", (it) => {
  it.effect("cascades schedules and runs owned by a thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 90 });
      for (const threadId of ["delete", "keep"]) {
        yield* insertProjectionThreadParent({ sql, threadId: ThreadId.makeUnsafe(threadId) });
      }
      yield* sql`
        INSERT INTO automation_schedules
          (automation_id, project_id, target_thread_id, title, prompt, cron_expression, timezone, created_at, updated_at)
        VALUES ('delete-automation', 'project', 'delete', 'Delete', 'prompt', '* * * * *', 'UTC', 'now', 'now'),
          ('keep-automation', 'project', 'keep', 'Keep', 'prompt', '* * * * *', 'UTC', 'now', 'now'),
          ('orphan-automation', 'project', 'missing', 'Orphan', 'prompt', '* * * * *', 'UTC', 'now', 'now')
      `;
      yield* sql`
        INSERT INTO automation_runs
          (run_id, automation_id, thread_id, message_id, command_id, status, started_at)
        VALUES ('delete-run', 'delete-automation', 'delete', 'message', 'command', 'completed', 'now'),
          ('keep-run', 'keep-automation', 'keep', 'message', 'command', 'completed', 'now')
      `;
      yield* runMigrations();
      yield* sql`DELETE FROM projection_threads WHERE thread_id = 'delete'`;
      assert.deepEqual(yield* sql`SELECT automation_id FROM automation_schedules`, [
        { automation_id: "keep-automation" },
      ]);
      assert.deepEqual(yield* sql`SELECT run_id FROM automation_runs`, [{ run_id: "keep-run" }]);
      assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
    }),
  );
});
