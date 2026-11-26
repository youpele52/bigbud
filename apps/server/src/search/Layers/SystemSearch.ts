import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import {
  SYSTEM_SEARCH_MAX_ROWS,
  SystemSearchError,
  type SystemSearchTierUpdate,
} from "@bigbud/contracts/search/systemSearch.ts";
import { Effect, Layer, Option, Queue, Stream } from "effect";

import type { RemoteAgentConnection } from "../../remote-agent/remoteAgentConnection.ts";
import { RemoteAgentWorkspaceClient } from "../../remote-agent/remoteAgentWorkspaceClient.ts";
import { remoteAgentRequestDigest } from "../../remote-agent/remoteAgentRequestDigest.ts";
import { workspaceHandle } from "../../workspace-runtime/Layers/WorkspaceRuntime.remote.ts";
import { LocalWorkspaceAgent } from "../../workspace-runtime/Services/LocalWorkspaceAgent.ts";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { SearchAgentConnections } from "../Services/SearchAgentConnections.ts";
import { SystemSearch } from "../Services/SystemSearch.ts";
import { SearchAgentConnectionsLive } from "./SearchAgentConnections.ts";
import { SystemSearchEmitter } from "../SystemSearch.emitter.ts";
import { osIndexMaxResults, runOsIndexSearch } from "../SystemSearch.osIndex.ts";
import { isThisComputerSearchAllowedByPolicy } from "../SystemSearch.policy.ts";
import { planSearchRoots } from "../SystemSearch.roots.ts";
import { makeSearchRootsQuery } from "../SystemSearch.rootsQuery.ts";
import {
  runWorkspaceFileSearch,
  type WorkspaceFileSearchDeps,
} from "../SystemSearch.workspaceFiles.ts";

function searchError(message: string) {
  return (cause: unknown) => new SystemSearchError({ message, cause });
}

export const makeSystemSearchLayer = Layer.effect(
  SystemSearch,
  Effect.gen(function* () {
    const roots = yield* makeSearchRootsQuery;
    const settings = yield* ServerSettingsService;
    const localAgent = yield* LocalWorkspaceAgent;
    const connections = yield* SearchAgentConnections;
    const config = yield* Effect.serviceOption(ServerConfig);
    // Only the desktop-embedded backend searches "this computer"; remote backends never do.
    const desktopEmbedded = Option.isSome(config) && config.value.mode === "desktop";

    const deps: WorkspaceFileSearchDeps<RemoteAgentConnection> = {
      localConnection: () => localAgent.getConnection(),
      remoteConnection: connections.remote,
      isManagedAgentTarget: connections.isManagedAgentTarget,
      legacyFolderSearch: async (connection, root, query, maxResults, signal) => {
        const client = new RemoteAgentWorkspaceClient(connection);
        const handle = workspaceHandle(root.executionTargetId, root.root);
        await client.openWorkspace(handle, root.root);
        signal.throwIfAborted();
        return client.searchFilenames({
          workspaceHandle: handle,
          path: ".",
          query,
          maxResults,
          operationId: `search-names-${randomUUID()}`,
          requestDigest: remoteAgentRequestDigest({ root: root.root, query, maxResults }),
        });
      },
    };

    return {
      query: (input) =>
        Stream.callback<SystemSearchTierUpdate, SystemSearchError>((queue) =>
          Effect.gen(function* () {
            const current = yield* settings.getSettings.pipe(
              Effect.mapError(searchError("Search settings are unavailable.")),
            );
            const known = yield* roots
              .read()
              .pipe(Effect.mapError(searchError("Project folders could not be read.")));
            const currentWorktree = input.currentThreadId
              ? (known.worktrees.find((root) => root.threadId === input.currentThreadId) ?? null)
              : null;
            const plan = planSearchRoots({
              tiers: input.tiers,
              currentProjectId: input.currentProjectId ?? null,
              currentWorktree,
              projects: known.projects,
              worktrees: known.worktrees,
              includeRemote: current.search.connectedRemoteBackends,
            });
            const controller = new AbortController();
            // Interrupting the stream aborts every agent request (each sends CancelRequest).
            yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
            const page = input.page ?? 0;
            const emitter = new SystemSearchEmitter(
              input.queryId,
              controller.signal,
              (update) => Queue.offerUnsafe(queue, update),
              SYSTEM_SEARCH_MAX_ROWS * (page + 1),
              input.mode === "fileNames",
              { thisComputer: osIndexMaxResults(page) },
            );
            const signal = controller.signal;
            yield* Effect.promise(() =>
              Promise.all([
                runWorkspaceFileSearch(deps, {
                  plan,
                  query: input.query,
                  emitter,
                  signal,
                  mode: input.mode,
                  page,
                }),
                input.tiers.includes("thisComputer")
                  ? runOsIndexSearch({
                      gate: {
                        desktopEmbedded,
                        allowedByPolicy: isThisComputerSearchAllowedByPolicy(),
                        thisComputer: current.search.thisComputer,
                        fileAccessLevel: current.search.fileAccessLevel,
                      },
                      localConnection: deps.localConnection,
                      home: homedir(),
                      projectRoots: [...known.projects, ...known.worktrees]
                        .filter((root) => isLocalExecutionTarget(root.executionTargetId))
                        .map((root) => root.root),
                      query: input.query,
                      emitter,
                      signal,
                      page,
                    })
                  : undefined,
              ]),
            );
            Queue.endUnsafe(queue);
          }),
        ),
    };
  }),
);

export const SystemSearchLive = makeSystemSearchLayer.pipe(
  Layer.provide(SearchAgentConnectionsLive),
);
