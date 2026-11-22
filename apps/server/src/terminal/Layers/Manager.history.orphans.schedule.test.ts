import { it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  projectionMissingThreadIds,
  runOrphanedHistorySweep,
} from "./Manager.history.orphans.schedule.ts";

const NOW = "2026-11-22T00:00:00.000Z";

it.layer(SqlitePersistenceMemory)("orphaned terminal history projection check", (it) => {
  it.effect("reports only threads with no projection row as gone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project', 'Project', '/project', '[]', ${NOW}, ${NOW})`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title,
          model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
        VALUES ('thread-present', 'project', 'Thread', '{"provider":"codex","model":"test"}',
          'full-access', 'default', ${NOW}, ${NOW})`;
      const missing = yield* projectionMissingThreadIds(sql)(["thread-present", "thread-gone"]);
      expect([...missing]).toEqual(["thread-gone"]);
    }),
  );

  it.effect("reports nothing gone when the projection cannot be read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE projection_threads RENAME TO projection_threads_unavailable`;
      const missing = yield* projectionMissingThreadIds(sql)(["thread-gone"]);
      expect(missing.size).toBe(0);
      yield* sql`ALTER TABLE projection_threads_unavailable RENAME TO projection_threads`;
    }),
  );

  it.effect("passes the projection check to the manager's sweep", () =>
    Effect.gen(function* () {
      const seen: Array<ReadonlyArray<string>> = [];
      yield* runOrphanedHistorySweep(
        {
          sweepOrphanedHistory: (missingThreadIds) =>
            missingThreadIds(["a"]).pipe(
              Effect.map((missing) => {
                seen.push([...missing]);
                return { removed: 0, kept: 0 };
              }),
            ),
        },
        (threadIds) => Effect.succeed(new Set(threadIds)),
      );
      expect(seen).toEqual([["a"]]);
    }),
  );
});
