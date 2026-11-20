import type { SystemSearchTierUpdate } from "@bigbud/contracts/search/systemSearch.ts";
import { Effect, Layer, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it, vi } from "vitest";

/** Every pool member search touched; any member except `liveConnection` would dial. */
const touched = vi.hoisted(() => ({ pool: [] as string[], ssh: 0 }));

vi.mock("../../remote-agent/remoteAgentDefault.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../remote-agent/remoteAgentDefault.ts")>();
  const pool = new Proxy(
    {},
    {
      get: (_target, property) => {
        touched.pool.push(String(property));
        if (property === "liveConnection") return () => null;
        return () => {
          throw new Error(`search must not call pool.${String(property)}`);
        };
      },
    },
  );
  return { ...actual, getConfiguredRemoteAgentComposition: () => ({ pool }) };
});
vi.mock("../../ssh/sshProcess.ts", () => ({
  runSshCommand: async () => {
    touched.ssh += 1;
    throw new Error("search must not spawn ssh");
  },
}));

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { RemoteAgentConnection } from "../../remote-agent/remoteAgentConnection.ts";
import { LocalWorkspaceAgent } from "../../workspace-runtime/Services/LocalWorkspaceAgent.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { SystemSearch } from "../Services/SystemSearch.ts";
import { fakeSearchAgent } from "../SystemSearch.test.helpers.ts";
import { SystemSearchLive } from "./SystemSearch.ts";

const AGENT_REMOTE = "ssh:host=box&transport=agent";
const SSH_ONLY = "ssh:host=old&transport=direct-ssh";
const NOW = "2026-11-20T00:00:00.000Z";

function layer() {
  const local = fakeSearchAgent();
  return {
    local,
    layer: SystemSearchLive.pipe(
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
    ),
  };
}

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const project = (id: string, root: string, target: string) => sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, workspace_execution_target_id, scripts_json,
      created_at, updated_at
    ) VALUES (${id}, ${id}, ${root}, ${target}, '[]', ${NOW}, ${NOW})
  `;
  yield* project("remote-current", "/srv/current", AGENT_REMOTE);
  yield* project("remote-other", "/srv/other", AGENT_REMOTE);
  yield* project("ssh-only", "/srv/ssh", SSH_ONLY);
  yield* project("local-other", "/work/other", "local");
});

describe("search never connects to a remote just to search", () => {
  it.each([
    ["Mod+F", { mode: "all" as const, query: "match" }],
    ["Mod+P", { mode: "fileNames" as const, query: "match" }],
  ])(
    "%s skips disconnected remotes with a notice and dials or spawns nothing",
    async (_, input) => {
      touched.pool.length = 0;
      touched.ssh = 0;
      const { local, layer: searchLayer } = layer();
      const updates = await Effect.runPromise(
        Effect.gen(function* () {
          yield* seed;
          const search = yield* SystemSearch;
          return [
            ...(yield* Stream.runCollect(
              search.query({
                queryId: "q1",
                ...input,
                currentProjectId: "remote-current" as never,
                tiers: ["currentProject", "otherProjectFiles", "remoteOutsideProjects"],
              }),
            )),
          ];
        }).pipe(Effect.provide(searchLayer)),
      );
      const remote = updates.filter((u: SystemSearchTierUpdate) => u.sourceId === AGENT_REMOTE);
      expect(remote.map((u) => [u.tier, u.state, u.reason])).toEqual([
        ["currentProject", "unavailable", "not-connected"],
        ["otherProjectFiles", "unavailable", "not-connected"],
      ]);
      expect(updates.filter((u) => u.sourceId === SSH_ONLY)).toEqual([
        expect.objectContaining({ state: "unavailable", reason: "use-managed-agent" }),
      ]);
      expect(remote.flatMap((u) => u.items)).toEqual([]);
      // Only the non-dialing lookup was used, ssh was never spawned, and local search still ran.
      expect(new Set(touched.pool)).toEqual(new Set(["liveConnection"]));
      expect(touched.ssh).toBe(0);
      expect(local.requests.map((request) => request.roots.map((root) => root.root))).toEqual([
        ["/work/other"],
      ]);
    },
  );
});
