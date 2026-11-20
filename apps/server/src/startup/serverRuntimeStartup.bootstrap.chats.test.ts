import { BUILT_IN_CHATS_PROJECT_ID } from "@bigbud/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";

import {
  createRuntime,
  withDatabase,
} from "../orchestration/Layers/OrchestrationEngine.test.runtime.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerConfig } from "./config.ts";
import { autoBootstrapWelcome } from "./serverRuntimeStartup.bootstrap.ts";

/** One backend start over `dbPath`: a fresh engine (startup read model), then the bootstrap. */
async function start(dbPath: string, before?: (sql: SqlClient.SqlClient) => Effect.Effect<void>) {
  const runtime = createRuntime(dbPath);
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        if (before) yield* before(sql);
        const config = yield* ServerConfig;
        yield* autoBootstrapWelcome.pipe(
          Effect.provide(ProjectionProjectRepositoryLive),
          Effect.provideService(ServerConfig, { ...config, autoBootstrapProjectFromCwd: false }),
          Effect.provideService(ProjectionSnapshotQuery, {} as never),
          Effect.provideService(ProviderRegistry, {} as never),
        );
        const rows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_events
          WHERE event_type = 'project.created' AND stream_id = ${BUILT_IN_CHATS_PROJECT_ID}`;
        const projected = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM projection_projects
          WHERE project_id = ${BUILT_IN_CHATS_PROJECT_ID}`;
        return { events: rows[0]?.count ?? -1, projected: projected[0]?.count ?? -1 };
      }),
    );
  } finally {
    await runtime.dispose();
  }
}

it("does not recreate an idle built-in Chats project on every start (O-6)", async () => {
  await withDatabase("bigbud-chats-bootstrap-", async (dbPath) => {
    // Migrations seed the projected row; Chats has no thread, so the engine's startup read model
    // (windowed to projects with an operational thread) never lists it.
    for (let attempt = 0; attempt < 3; attempt++)
      expect(await start(dbPath)).toEqual({ events: 0, projected: 1 });
  });
});

it("creates a missing Chats project once, even when asked again", async () => {
  await withDatabase("bigbud-chats-bootstrap-", async (dbPath) => {
    const dropRow = (sql: SqlClient.SqlClient) =>
      sql`DELETE FROM projection_projects WHERE project_id = ${BUILT_IN_CHATS_PROJECT_ID}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      );
    expect(await start(dbPath, dropRow)).toEqual({ events: 1, projected: 1 });
    // A second start that still finds no row replays the fixed command's receipt.
    expect((await start(dbPath, dropRow)).events).toBe(1);
  });
});
