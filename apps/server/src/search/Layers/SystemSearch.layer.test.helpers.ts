import type {
  SystemSearchQueryInput,
  SystemSearchTierUpdate,
} from "@bigbud/contracts/search/systemSearch.ts";
import { Effect, Layer, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { RemoteAgentConnection } from "../../remote-agent/remoteAgentConnection.ts";
import { LocalWorkspaceAgent } from "../../workspace-runtime/Services/LocalWorkspaceAgent.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { SystemSearch } from "../Services/SystemSearch.ts";
import { fakeSearchAgent } from "../SystemSearch.test.helpers.ts";
import { SystemSearchLive } from "./SystemSearch.ts";

const NOW = "2026-11-20T00:00:00.000Z";

/** One project row: [projectId, workspace root, execution target]. */
export type SeedProject = readonly [id: string, root: string, target: string];

/**
 * Runs one `search.query` through `SystemSearchLive` over an in-memory database seeded with
 * `projects`, with a fake local agent. Remote connections come from whatever the test mocked
 * `getConfiguredRemoteAgentComposition` to return.
 */
export async function runLiveSearch(
  projects: ReadonlyArray<SeedProject>,
  input: Omit<SystemSearchQueryInput, "queryId">,
) {
  const local = fakeSearchAgent();
  const layer = SystemSearchLive.pipe(
    Layer.provide(
      Layer.succeed(LocalWorkspaceAgent, {
        getConnection: async () => local.connection as unknown as RemoteAgentConnection,
        getWorkspaceClient: async () => {
          throw new Error("unused");
        },
      }),
    ),
    Layer.provide(ServerSettingsService.layerTest({})),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const updates: SystemSearchTierUpdate[] = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const [id, root, target] of projects) {
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, workspace_execution_target_id, scripts_json,
            created_at, updated_at
          ) VALUES (${id}, ${id}, ${root}, ${target}, '[]', ${NOW}, ${NOW})
        `;
      }
      const search = yield* SystemSearch;
      return [...(yield* Stream.runCollect(search.query({ queryId: "q1", ...input })))];
    }).pipe(Effect.provide(layer)),
  );
  return { updates, local };
}
