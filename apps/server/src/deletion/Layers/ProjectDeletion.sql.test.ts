import { ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeProjectDeletionSql } from "./ProjectDeletion.sql.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { insertProjectionThreadParent } from "../../persistence/Layers/ProjectionThread.test.helpers.ts";

const layer = it.layer(Layer.fresh(SqlitePersistenceMemory));

layer("ProjectDeletion SQL ownership", (it) => {
  it.effect("aborts before deleting threads referenced by another project's schedule", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.makeUnsafe("project-to-delete");
      const otherProjectId = ProjectId.makeUnsafe("other-project");
      const threadId = ThreadId.makeUnsafe("project-thread");
      yield* insertProjectionThreadParent({ sql, threadId, projectId });
      yield* sql`
        INSERT INTO automation_schedules (
          automation_id, project_id, target_thread_id, title, prompt, cron_expression,
          timezone, created_at, updated_at
        ) VALUES
          ('owned-schedule', ${projectId}, ${threadId}, 'Owned', 'prompt', '* * * * *', 'UTC', 'now', 'now'),
          ('shared-schedule', ${otherProjectId}, ${threadId}, 'Shared', 'prompt', '* * * * *', 'UTC', 'now', 'now')
      `;

      const result = yield* Effect.exit(
        makeProjectDeletionSql(sql).deleteProjectDependents({ projectId }),
      );

      assert.isTrue(Exit.isFailure(result));
      assert.deepEqual(yield* sql`SELECT thread_id FROM projection_threads`, [
        { thread_id: threadId },
      ]);
      assert.deepEqual(
        yield* sql`SELECT automation_id FROM automation_schedules ORDER BY automation_id`,
        [{ automation_id: "owned-schedule" }, { automation_id: "shared-schedule" }],
      );
    }),
  );
});
