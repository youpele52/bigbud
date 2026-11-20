import { randomUUID } from "node:crypto";

import {
  assertAgentSearchUsable,
  retryWhileAgentSearchBusy,
  type AgentContentSearchConnection,
  type AgentContentSearchInput,
} from "./agentWorkspaceContentSearch.ts";
import type { RemoteAgentDirectoryEntry } from "./remoteAgentProtocol.ts";
import { REMOTE_AGENT_SEARCH_MODE } from "./remoteAgentProtocol.search.ts";
import { streamRemoteAgentWorkspaceSearch } from "./remoteAgentWorkspaceSearch.ts";

const ROOT_ID = "project";

/**
 * One project's file-name search over the agent's streaming engine (`workspace.search-stream`,
 * names mode), best match first. It ranks like `@bigbud/shared/search/nameRank` (shared fixtures),
 * replacing the legacy `FilenameSearchRequest` walker on agents that have the engine. A full page
 * is reported as truncated, as the legacy result was.
 */
export async function searchAgentWorkspaceNames(
  connection: AgentContentSearchConnection,
  input: AgentContentSearchInput,
): Promise<{ readonly entries: RemoteAgentDirectoryEntry[]; readonly truncated: boolean }> {
  const limit = Math.max(0, Math.floor(input.limit));
  let entries: RemoteAgentDirectoryEntry[] = [];
  const completed = await retryWhileAgentSearchBusy(
    () => {
      entries = [];
      return streamRemoteAgentWorkspaceSearch(
        connection,
        {
          operationId: `search-names-${randomUUID()}`,
          roots: [{ rootId: ROOT_ID, root: input.root, relativePath: "" }],
          query: input.query,
          mode: REMOTE_AGENT_SEARCH_MODE.names,
          maxResults: limit,
          maxResultsPerRoot: limit,
          deadlineMs: input.budget.deadlineMs,
          maxThreads: 0,
          priority: input.budget.priority,
        },
        {
          onBatch: (batch) => {
            for (const hit of batch.names) {
              if (!hit.path) continue;
              entries.push({
                path: hit.path,
                isDirectory: hit.isDirectory,
                isFile: !hit.isDirectory,
                sizeBytes: hit.sizeBytes,
                modifiedUnixMs: hit.modifiedUnixMs,
              });
            }
          },
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
    },
    { deadlineMs: input.budget.deadlineMs, signal: input.signal, wait: input.wait },
  );
  input.signal?.throwIfAborted();
  assertAgentSearchUsable(completed);
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length >= limit || completed.truncated,
  };
}
