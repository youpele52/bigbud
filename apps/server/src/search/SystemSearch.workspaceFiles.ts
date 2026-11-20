import {
  SYSTEM_SEARCH_LOCAL_SOURCE_ID,
  type SystemSearchMode,
} from "@bigbud/contracts/search/systemSearch.ts";
import { countUnicodeCodePoints } from "@bigbud/shared/String";

import { isLocalExecutionTarget } from "../executionTargets.ts";
import {
  AGENT_CONTENT_SEARCH_BUDGETS,
  type AgentContentSearchInput,
} from "../remote-agent/agentWorkspaceContentSearch.ts";
import type { RemoteAgentDirectoryEntry } from "../remote-agent/remoteAgentProtocol.ts";
import { REMOTE_AGENT_SEARCH_STREAM_CAPABILITY } from "../remote-agent/remoteAgentProtocol.search.ts";
import {
  searchRootsLegacy,
  searchRootsOnAgent,
  type SearchAgentConnection,
} from "./SystemSearch.agentRequest.ts";
import type { SystemSearchEmitter } from "./SystemSearch.emitter.ts";
import type { SearchRootEntry, SearchRootPlan } from "./SystemSearch.roots.ts";

/** Per-request caps (plan §4): the current project gets more rows; others 20 per project. */
export const SYSTEM_SEARCH_LIMITS = {
  current: { maxResults: 80, maxResultsPerRoot: 80 },
  local: { maxResults: 120, maxResultsPerRoot: 20 },
  remote: { maxResults: 60, maxResultsPerRoot: 20 },
} as const;
/** Short-query rules (plan §1): current-project names from 1, other names 2, contents 3. */
export const SYSTEM_SEARCH_MIN_CHARS = { currentNames: 1, otherNames: 2, contents: 3 } as const;

type SearchLimits = (typeof SYSTEM_SEARCH_LIMITS)[keyof typeof SYSTEM_SEARCH_LIMITS];

/** Page `n` asks for `n + 1` first pages; ranking is deterministic, so earlier rows lead. */
export function pageLimits(limits: SearchLimits, page: number) {
  const pages = page + 1;
  return {
    maxResults: limits.maxResults * pages,
    maxResultsPerRoot: limits.maxResultsPerRoot * pages,
  };
}

export interface WorkspaceFileSearchDeps<C extends SearchAgentConnection = SearchAgentConnection> {
  readonly localConnection: () => Promise<C>;
  /** Live managed-agent connection, or null when the remote is not connected. Never dials. */
  readonly remoteConnection: (executionTargetId: string) => C | null;
  readonly isManagedAgentTarget: (executionTargetId: string) => boolean;
  /** Legacy filename search in one folder for agents without `workspace.search-stream`. */
  readonly legacyFolderSearch: (
    connection: C,
    root: SearchRootEntry,
    query: string,
    maxResults: number,
    signal: AbortSignal,
  ) => Promise<ReadonlyArray<RemoteAgentDirectoryEntry>>;
  readonly wait?: AgentContentSearchInput["wait"];
}

interface SourceInput {
  readonly executionTargetId: string;
  readonly roots: ReadonlyArray<SearchRootEntry>;
  readonly query: string;
  readonly mode: "names" | "both";
  readonly limits: { readonly maxResults: number; readonly maxResultsPerRoot: number };
  readonly emitter: SystemSearchEmitter;
  readonly signal: AbortSignal;
}

function unavailable(
  input: SourceInput,
  sourceId: string,
  reason: "not-connected" | "agent-unavailable" | "use-managed-agent" | "error",
): void {
  for (const tier of new Set(input.roots.map((root) => root.tier))) {
    input.emitter.state({ tier, sourceId, state: "unavailable", reason });
  }
}

async function searchSource<C extends SearchAgentConnection>(
  deps: WorkspaceFileSearchDeps<C>,
  input: SourceInput,
): Promise<void> {
  const local = isLocalExecutionTarget(input.executionTargetId);
  const sourceId = local ? SYSTEM_SEARCH_LOCAL_SOURCE_ID : input.executionTargetId;
  let connection: C | null;
  if (local) {
    try {
      connection = await deps.localConnection();
    } catch {
      if (!input.signal.aborted) unavailable(input, sourceId, "agent-unavailable");
      return;
    }
    if (!connection.supportsCapability(REMOTE_AGENT_SEARCH_STREAM_CAPABILITY)) {
      return unavailable(input, sourceId, "agent-unavailable");
    }
  } else {
    // SSH-only hosts would need a new `ssh` process; search never connects just to search.
    if (!deps.isManagedAgentTarget(input.executionTargetId)) {
      return unavailable(input, sourceId, "use-managed-agent");
    }
    connection = deps.remoteConnection(input.executionTargetId);
    if (!connection) return unavailable(input, sourceId, "not-connected");
    if (!connection.supportsCapability(REMOTE_AGENT_SEARCH_STREAM_CAPABILITY)) {
      const legacy = connection;
      return searchRootsLegacy({
        sourceId,
        roots: input.roots,
        maxResultsPerRoot: input.limits.maxResultsPerRoot,
        searchFolder: (root, maxResults) =>
          deps.legacyFolderSearch(legacy, root, input.query, maxResults, input.signal),
        emitter: input.emitter,
        signal: input.signal,
      });
    }
  }
  if (input.signal.aborted) return;
  return searchRootsOnAgent(connection, {
    sourceId,
    roots: input.roots,
    query: input.query,
    mode: input.mode,
    budget: local ? AGENT_CONTENT_SEARCH_BUDGETS.local : AGENT_CONTENT_SEARCH_BUDGETS.remote,
    maxResults: input.limits.maxResults,
    maxResultsPerRoot: input.limits.maxResultsPerRoot,
    emitter: input.emitter,
    signal: input.signal,
    ...(deps.wait ? { wait: deps.wait } : {}),
  });
}

/**
 * T2, T4 and T6 (plan §4). The current project is requested first and on its own, with a
 * higher cap; every other folder goes in one request per execution target. Remotes that are not
 * connected report `not-connected` at once and never delay the other sources; nothing is dialed,
 * spawned or reconnected. `fileNames` (Mod+P) asks for names only at every length.
 */
export async function runWorkspaceFileSearch<C extends SearchAgentConnection>(
  deps: WorkspaceFileSearchDeps<C>,
  input: {
    readonly plan: SearchRootPlan;
    readonly query: string;
    readonly emitter: SystemSearchEmitter;
    readonly signal: AbortSignal;
    readonly mode?: SystemSearchMode | undefined;
    readonly page?: number | undefined;
  },
): Promise<void> {
  const length = countUnicodeCodePoints(input.query);
  const contents = input.mode !== "fileNames" && length >= SYSTEM_SEARCH_MIN_CHARS.contents;
  const mode = contents ? "both" : "names";
  const page = input.page ?? 0;
  const shared = {
    query: input.query,
    mode,
    emitter: input.emitter,
    signal: input.signal,
  } as const;
  const sources: Promise<void>[] = [];
  const current = input.plan.current;
  if (current && length >= SYSTEM_SEARCH_MIN_CHARS.currentNames) {
    sources.push(
      searchSource(deps, {
        ...shared,
        executionTargetId: current.executionTargetId,
        roots: [current],
        limits: pageLimits(SYSTEM_SEARCH_LIMITS.current, page),
      }),
    );
  }
  if (length >= SYSTEM_SEARCH_MIN_CHARS.otherNames) {
    for (const group of input.plan.others) {
      const local = isLocalExecutionTarget(group.executionTargetId);
      sources.push(
        searchSource(deps, {
          ...shared,
          executionTargetId: group.executionTargetId,
          roots: group.roots,
          limits: pageLimits(
            local ? SYSTEM_SEARCH_LIMITS.local : SYSTEM_SEARCH_LIMITS.remote,
            page,
          ),
        }),
      );
    }
  }
  await Promise.all(sources);
}
