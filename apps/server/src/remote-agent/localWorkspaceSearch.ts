import { Effect } from "effect";
import type { ProjectSearchFileContentsInput } from "@bigbud/contracts/workspace/project.ts";

import { isLocalExecutionTarget } from "../executionTargets.ts";
import { WorkspaceFileSystemError } from "../workspace/Services/WorkspaceFileSystem.ts";
import type { WorkspacePathsShape } from "../workspace/Services/WorkspacePaths.ts";
import type { LocalWorkspaceAgentShape } from "../workspace-runtime/Services/LocalWorkspaceAgent.ts";
import type { WorkspaceSearchShape } from "../workspace-runtime/Services/WorkspaceSearch.ts";
import {
  AGENT_CONTENT_SEARCH_BUDGETS,
  searchAgentWorkspaceContents,
} from "./agentWorkspaceContentSearch.ts";
import { LocalWorkspaceWatchAgentUnavailableError } from "./localWorkspaceWatchAgent.binary.ts";
import { RemoteAgentConnectionError } from "./remoteAgentConnection.ts";
import { REMOTE_AGENT_SEARCH_STREAM_CAPABILITY } from "./remoteAgentProtocol.search.ts";

const OPERATION = "localWorkspace.searchFileContents";

function searchError(cwd: string, detail: string, cause?: unknown): WorkspaceFileSystemError {
  return new WorkspaceFileSystemError({
    cwd,
    operation: OPERATION,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

/**
 * Local project content search through the shared local agent's streaming search. There is no
 * `rg` or in-process fallback: when the agent is unavailable the search fails with that reason.
 * A transport loss mid-search is retried once on the restarted agent, since search is
 * read-only and never journalled.
 */
export function makeLocalWorkspaceContentSearch(
  agent: Pick<LocalWorkspaceAgentShape, "getConnection">,
  workspacePaths: Pick<WorkspacePathsShape, "normalizeWorkspaceRoot">,
): WorkspaceSearchShape["searchFileContents"] {
  const searchOnce = async (
    root: string,
    input: ProjectSearchFileContentsInput,
    signal: AbortSignal,
  ) => {
    const connection = await agent.getConnection();
    if (!connection.supportsCapability(REMOTE_AGENT_SEARCH_STREAM_CAPABILITY)) {
      throw new LocalWorkspaceWatchAgentUnavailableError(
        "The local workspace agent is out of date and cannot search file contents. " +
          "Rebuild it with cargo build --locked --package bigbud-remote-agent.",
      );
    }
    return searchAgentWorkspaceContents(connection, {
      root,
      query: input.query,
      limit: input.limit,
      budget: AGENT_CONTENT_SEARCH_BUDGETS.local,
      signal,
    });
  };

  return Effect.fn("LocalWorkspaceSearch.searchFileContents")(function* (
    input: ProjectSearchFileContentsInput,
  ) {
    if (!isLocalExecutionTarget(input.executionTargetId)) {
      return yield* searchError(
        input.cwd,
        "Local content search requires a local execution target.",
      );
    }
    if (input.cwd.includes("\0")) {
      return yield* searchError(input.cwd, "Workspace root cannot contain NUL bytes.");
    }
    const root = yield* workspacePaths
      .normalizeWorkspaceRoot(input.cwd)
      .pipe(Effect.mapError((cause) => searchError(input.cwd, cause.message, cause)));
    return yield* Effect.tryPromise({
      try: async (signal) => {
        try {
          return await searchOnce(root, input, signal);
        } catch (cause) {
          if (!(cause instanceof RemoteAgentConnectionError) || signal.aborted) throw cause;
          return searchOnce(root, input, signal);
        }
      },
      catch: (cause) =>
        searchError(input.cwd, cause instanceof Error ? cause.message : String(cause), cause),
    });
  });
}
