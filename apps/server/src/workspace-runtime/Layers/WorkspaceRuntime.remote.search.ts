import { randomUUID } from "node:crypto";

import { Effect } from "effect";
import type {
  ProjectSearchFileContentsInput,
  ProjectSearchFileContentsResult,
} from "@bigbud/contracts/workspace/project.ts";

import {
  AGENT_CONTENT_SEARCH_BUDGETS,
  searchAgentWorkspaceContents,
} from "../../remote-agent/agentWorkspaceContentSearch.ts";
import { REMOTE_AGENT_SEARCH_STREAM_CAPABILITY } from "../../remote-agent/remoteAgentProtocol.search.ts";
import { remoteAgentRequestDigest } from "../../remote-agent/remoteAgentRequestDigest.ts";
import type { RemoteAgentWorkspaceClient } from "../../remote-agent/remoteAgentWorkspaceClient.ts";
import { WorkspaceFileSystemError } from "../../workspace/Services/WorkspaceFileSystem.ts";
import type { WorkspaceSearchShape } from "../Services/WorkspaceSearch.ts";
import {
  withRemoteReadReconnect,
  type RemoteWorkspaceReadResolver,
} from "./WorkspaceRuntime.remote.reconnect.ts";

/** Legacy single-response content search for agents without `workspace.search-stream`. */
async function searchLegacy(
  client: RemoteAgentWorkspaceClient,
  handle: string,
  input: ProjectSearchFileContentsInput,
  operationId: string,
): Promise<ProjectSearchFileContentsResult> {
  const response = await client.searchContent({
    workspaceHandle: handle,
    path: ".",
    query: input.query,
    maxResults: input.limit,
    operationId,
    requestDigest: remoteAgentRequestDigest(input),
  });
  return {
    matches: response.matches.map((match) => ({
      path: match.path,
      line: match.line,
      column: match.column,
      lineText: match.excerpt,
    })),
    truncated: response.truncated,
    notice: "agent-update-available",
  };
}

/**
 * Managed-agent content search: the streaming engine when the agent advertises
 * `workspace.search-stream`, otherwise the legacy frame with the `agent-update-available` notice.
 * Interrupting the Effect aborts the stream, which sends `CancelRequest`.
 */
export function makeRemoteWorkspaceContentSearch(input: {
  readonly resolver: RemoteWorkspaceReadResolver;
  readonly remoteTarget: (executionTargetId: string | undefined) => string;
  readonly open: (
    client: RemoteAgentWorkspaceClient,
    target: string,
    cwd: string,
  ) => Promise<string>;
}): WorkspaceSearchShape["searchFileContents"] {
  return Effect.fn("RemoteWorkspaceSearch.searchFileContents")(function* (
    search: ProjectSearchFileContentsInput,
  ) {
    const target = input.remoteTarget(search.executionTargetId);
    const legacyOperationId = `search-content-${randomUUID()}`;
    return yield* Effect.tryPromise({
      try: (signal) =>
        withRemoteReadReconnect({
          resolver: input.resolver,
          target,
          operation: async (client) => {
            if (!client.connection.supportsCapability(REMOTE_AGENT_SEARCH_STREAM_CAPABILITY)) {
              const handle = await input.open(client, target, search.cwd);
              return searchLegacy(client, handle, search, legacyOperationId);
            }
            return searchAgentWorkspaceContents(client.connection, {
              root: search.cwd,
              query: search.query,
              limit: search.limit,
              budget: AGENT_CONTENT_SEARCH_BUDGETS.remote,
              signal,
            });
          },
        }),
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd: search.cwd,
          operation: "remoteWorkspace.searchFileContents",
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    });
  });
}
