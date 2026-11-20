import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import type {
  ProjectEntry,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@bigbud/contracts/workspace/project.ts";

import { AGENT_CONTENT_SEARCH_BUDGETS } from "../../remote-agent/agentWorkspaceContentSearch.ts";
import { searchAgentWorkspaceNames } from "../../remote-agent/agentWorkspaceNameSearch.ts";
import type { RemoteAgentDirectoryEntry } from "../../remote-agent/remoteAgentProtocol.ts";
import { REMOTE_AGENT_SEARCH_STREAM_CAPABILITY } from "../../remote-agent/remoteAgentProtocol.search.ts";
import { remoteAgentRequestDigest } from "../../remote-agent/remoteAgentRequestDigest.ts";
import type { RemoteAgentWorkspaceClient } from "../../remote-agent/remoteAgentWorkspaceClient.ts";
import { WorkspaceEntriesError } from "../../workspace/Services/WorkspaceEntries.ts";
import type { WorkspaceSearchShape } from "../Services/WorkspaceSearch.ts";
import {
  withRemoteReadReconnect,
  type RemoteWorkspaceReadResolver,
} from "./WorkspaceRuntime.remote.reconnect.ts";

function projectEntry(entry: RemoteAgentDirectoryEntry): ProjectEntry {
  const separator = entry.path.lastIndexOf("/");
  const parentPath = separator > 0 ? entry.path.slice(0, separator) : undefined;
  return {
    path: entry.path,
    kind: entry.isDirectory ? "directory" : "file",
    ...(parentPath ? { parentPath } : {}),
  };
}

/** Legacy filename walker for agents without `workspace.search-stream`, with the update notice. */
async function searchLegacy(
  client: RemoteAgentWorkspaceClient,
  handle: string,
  input: ProjectSearchEntriesInput,
  operationId: string,
): Promise<ProjectSearchEntriesResult> {
  const entries = await client.searchFilenames({
    workspaceHandle: handle,
    path: ".",
    query: input.query,
    maxResults: input.limit,
    operationId,
    requestDigest: remoteAgentRequestDigest(input),
  });
  return {
    entries: entries.map(projectEntry),
    truncated: entries.length >= input.limit,
    notice: "agent-update-available",
  };
}

/**
 * Managed-agent file-name search (`projects.searchEntries` on remotes, used by the composer's
 * path suggestions): the engine's names mode when the agent advertises `workspace.search-stream`,
 * ranked like the local list, otherwise the legacy walker with `agent-update-available`.
 * Interrupting the Effect aborts the stream, which sends `CancelRequest`.
 */
export function makeRemoteWorkspaceEntrySearch(input: {
  readonly resolver: RemoteWorkspaceReadResolver;
  readonly remoteTarget: (executionTargetId: string | undefined) => string;
  readonly open: (
    client: RemoteAgentWorkspaceClient,
    target: string,
    cwd: string,
  ) => Promise<string>;
}): WorkspaceSearchShape["searchEntries"] {
  return Effect.fn("RemoteWorkspaceSearch.searchEntries")(function* (
    search: ProjectSearchEntriesInput,
  ) {
    const target = input.remoteTarget(search.executionTargetId);
    const legacyOperationId = `search-entries-${randomUUID()}`;
    return yield* Effect.tryPromise({
      try: (signal) =>
        withRemoteReadReconnect({
          resolver: input.resolver,
          target,
          operation: async (client): Promise<ProjectSearchEntriesResult> => {
            if (!client.connection.supportsCapability(REMOTE_AGENT_SEARCH_STREAM_CAPABILITY)) {
              const handle = await input.open(client, target, search.cwd);
              return searchLegacy(client, handle, search, legacyOperationId);
            }
            const result = await searchAgentWorkspaceNames(client.connection, {
              root: search.cwd,
              query: search.query,
              limit: search.limit,
              budget: AGENT_CONTENT_SEARCH_BUDGETS.remote,
              signal,
            });
            return { entries: result.entries.map(projectEntry), truncated: result.truncated };
          },
        }),
      catch: (cause) =>
        new WorkspaceEntriesError({
          cwd: search.cwd,
          operation: "remoteWorkspace.searchEntries",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
  });
}
