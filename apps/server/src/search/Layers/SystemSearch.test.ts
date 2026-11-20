import type { SystemSearchTierUpdate } from "@bigbud/contracts/search/systemSearch.ts";
import type { DeepPartial } from "@bigbud/shared/Struct";
import type { ServerSettings } from "@bigbud/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it, vi } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { RemoteAgentConnection } from "../../remote-agent/remoteAgentConnection.ts";
import { LocalWorkspaceAgent } from "../../workspace-runtime/Services/LocalWorkspaceAgent.ts";
import {
  WorkspaceRuntime,
  type WorkspaceRuntimeShape,
} from "../../workspace-runtime/Services/WorkspaceRuntime.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { SearchAgentConnections } from "../Services/SearchAgentConnections.ts";
import { SystemSearch } from "../Services/SystemSearch.ts";
import { fakeSearchAgent } from "../SystemSearch.test.helpers.ts";
import { makeSystemSearchLayer } from "./SystemSearch.ts";

const REMOTE = "ssh:host=box&transport=agent";
const NOW = "2026-11-19T00:00:00.000Z";

function harness(settings: DeepPartial<ServerSettings>, hold = false, mode?: "desktop" | "remote") {
  const local = fakeSearchAgent({ hold });
  const remote = fakeSearchAgent({ hold });
  const layer = makeSystemSearchLayer.pipe(
    Layer.provide(
      Layer.succeed(SearchAgentConnections, {
        remote: () => remote.connection as unknown as RemoteAgentConnection,
        isManagedAgentTarget: (target) => target === REMOTE,
      }),
    ),
    Layer.provide(
      Layer.succeed(LocalWorkspaceAgent, {
        getConnection: async () => local.connection as unknown as RemoteAgentConnection,
        getWorkspaceClient: async () => {
          throw new Error("unused");
        },
      }),
    ),
    Layer.provide(Layer.succeed(WorkspaceRuntime, {} as WorkspaceRuntimeShape)),
    Layer.provide(ServerSettingsService.layerTest(settings)),
    Layer.provide(mode ? Layer.succeed(ServerConfig, { mode } as never) : Layer.empty),
    Layer.provideMerge(SqlitePersistenceMemory),
  );
  const seed = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const project = (id: string, root: string, target: string) => sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, workspace_execution_target_id, scripts_json,
        created_at, updated_at
      ) VALUES (${id}, ${id}, ${root}, ${target}, '[]', ${NOW}, ${NOW})
    `;
    yield* project("current", "/work/current", "local");
    yield* project("other", "/work/other", "local");
    yield* project("remote", "/srv/app", REMOTE);
  });
  return { local, remote, layer, seed };
}

describe("SystemSearchLive", () => {
  it("streams T2 and T4 from the shared local agent and skips remotes when remote search is off", async () => {
    const { local, remote, layer, seed } = harness({ search: { connectedRemoteBackends: false } });
    const updates = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed;
        const search = yield* SystemSearch;
        return yield* Stream.runCollect(
          search.query({
            queryId: "q1",
            query: "match",
            currentProjectId: "current" as never,
            tiers: ["currentProject", "otherProjectFiles", "remoteOutsideProjects"],
          }),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(local.requests.map((request) => request.roots.map((root) => root.root))).toEqual([
      ["/work/current"],
      ["/work/other"],
    ]);
    expect(remote.requests).toHaveLength(0);
    const rows = [...updates].flatMap((update: SystemSearchTierUpdate) => update.items);
    expect(rows.every((row) => row.executionTargetId === "local")).toBe(true);
    expect([...updates].every((update) => update.queryId === "q1")).toBe(true);
  });

  it("searches connected remotes by default", async () => {
    const { remote, layer, seed } = harness({});
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed;
        const search = yield* SystemSearch;
        yield* Stream.runDrain(
          search.query({ queryId: "q1", query: "match", tiers: ["otherProjectFiles"] }),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(remote.requests.map((request) => request.roots.map((root) => root.root))).toEqual([
      ["/srv/app"],
    ]);
  });

  it("sends CancelRequest for every agent operation when the subscription is interrupted", async () => {
    const { local, remote, layer, seed } = harness({}, true);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed;
        const search = yield* SystemSearch;
        const fiber = yield* Stream.runDrain(
          search.query({
            queryId: "q1",
            query: "match",
            currentProjectId: "current" as never,
            tiers: ["currentProject", "otherProjectFiles"],
          }),
        ).pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(local.inFlight.size + remote.inFlight.size).toBe(3)),
        );
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(layer)),
    );
    await vi.waitFor(() => expect(local.inFlight.size + remote.inFlight.size).toBe(0));
    expect(local.cancels).toHaveLength(2);
    expect(remote.cancels).toHaveLength(1);
  });

  it("keeps this computer gated by File Access by default and absent outside the desktop backend", async () => {
    const thisComputer = async (mode?: "desktop" | "remote") => {
      const { layer } = harness({}, false, mode);
      return Effect.runPromise(
        Effect.gen(function* () {
          const search = yield* SystemSearch;
          return [
            ...(yield* Stream.runCollect(
              search.query({ queryId: "q1", query: "invoice", tiers: ["thisComputer"] }),
            )),
          ];
        }).pipe(Effect.provide(layer)),
      );
    };
    expect(await thisComputer("desktop")).toEqual([
      // On by default (plan Q1, revised); File Access still starts at "No access".
      expect.objectContaining({
        tier: "thisComputer",
        state: "unavailable",
        reason: "file-access-none",
      }),
    ]);
    expect(await thisComputer("remote")).toEqual([]);
    expect(await thisComputer()).toEqual([]);
  });
});
