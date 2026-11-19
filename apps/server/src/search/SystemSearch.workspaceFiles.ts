import type { ProjectSearchFileContentsResult } from "@bigbud/contracts/workspace/project.ts";
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
import { contentHitToRow } from "./SystemSearch.hits.ts";
import type { SearchRootEntry, SearchRootPlan } from "./SystemSearch.roots.ts";

/** Per-request caps (plan §4): the current project gets more rows; others 20 per project. */
export const SYSTEM_SEARCH_LIMITS = {
  current: { maxResults: 80, maxResultsPerRoot: 80 },
  local: { maxResults: 120, maxResultsPerRoot: 20 },
  remote: { maxResults: 60, maxResultsPerRoot: 20 },
} as const;
/** Short-query rules (plan §1): current-project names from 1, other names 2, contents 3. */
export const SYSTEM_SEARCH_MIN_CHARS = { currentNames: 1, otherNames: 2, contents: 3 } as const;
export const LOCAL_SOURCE_ID = "local";

export interface WorkspaceFileSearchDeps<C extends SearchAgentConnection = SearchAgentConnection> {
  readonly localConnection: () => Promise<C>;
  /** Live managed-agent connection, or null when the remote is not connected. Never dials. */
  readonly remoteConnection: (executionTargetId: string) => C | null;
  readonly isManagedAgentTarget: (executionTargetId: string) => boolean;
  /** Current-project content search on SSH-only hosts (`rg` on the host, plan Q5). */
  readonly searchDirectSsh: (input: {
    readonly executionTargetId: string;
    readonly root: string;
    readonly query: string;
    readonly signal: AbortSignal;
  }) => Promise<ProjectSearchFileContentsResult>;
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
  readonly limits: (typeof SYSTEM_SEARCH_LIMITS)[keyof typeof SYSTEM_SEARCH_LIMITS];
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

async function searchDirectSsh<C extends SearchAgentConnection>(
  deps: WorkspaceFileSearchDeps<C>,
  input: SourceInput,
): Promise<void> {
  const sourceId = input.executionTargetId;
  const current = input.roots.find((root) => root.tier === "currentProject");
  const contents = countUnicodeCodePoints(input.query) >= SYSTEM_SEARCH_MIN_CHARS.contents;
  if (!current || !contents) return unavailable(input, sourceId, "use-managed-agent");
  unavailable(
    { ...input, roots: input.roots.filter((root) => root !== current) },
    sourceId,
    "use-managed-agent",
  );
  input.emitter.state({ tier: current.tier, sourceId, state: "searching" });
  try {
    const result = await deps.searchDirectSsh({
      executionTargetId: input.executionTargetId,
      root: current.root,
      query: input.query,
      signal: input.signal,
    });
    if (input.signal.aborted) return;
    const items = result.matches.flatMap(
      (match) =>
        contentHitToRow(current, {
          path: match.path,
          line: match.line,
          column: match.column ?? 0,
          excerpt: match.lineText,
        }) ?? [],
    );
    const complete = input.emitter.rowsFor({ tier: current.tier, sourceId, items });
    input.emitter.state({
      tier: current.tier,
      sourceId,
      state: "partial",
      reason: "use-managed-agent",
      truncated: result.truncated || !complete,
    });
  } catch {
    if (!input.signal.aborted) unavailable({ ...input, roots: [current] }, sourceId, "error");
  }
}

async function searchSource<C extends SearchAgentConnection>(
  deps: WorkspaceFileSearchDeps<C>,
  input: SourceInput,
): Promise<void> {
  const local = isLocalExecutionTarget(input.executionTargetId);
  const sourceId = local ? LOCAL_SOURCE_ID : input.executionTargetId;
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
    if (!deps.isManagedAgentTarget(input.executionTargetId)) return searchDirectSsh(deps, input);
    connection = deps.remoteConnection(input.executionTargetId);
    if (!connection) return unavailable(input, sourceId, "not-connected");
    if (!connection.supportsCapability(REMOTE_AGENT_SEARCH_STREAM_CAPABILITY)) {
      const legacy = connection;
      return searchRootsLegacy({
        sourceId,
        roots: input.roots,
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
 * connected report `not-connected` at once and never delay the other sources.
 */
export async function runWorkspaceFileSearch<C extends SearchAgentConnection>(
  deps: WorkspaceFileSearchDeps<C>,
  input: {
    readonly plan: SearchRootPlan;
    readonly query: string;
    readonly emitter: SystemSearchEmitter;
    readonly signal: AbortSignal;
  },
): Promise<void> {
  const length = countUnicodeCodePoints(input.query);
  const mode = length >= SYSTEM_SEARCH_MIN_CHARS.contents ? "both" : "names";
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
        limits: SYSTEM_SEARCH_LIMITS.current,
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
          limits: local ? SYSTEM_SEARCH_LIMITS.local : SYSTEM_SEARCH_LIMITS.remote,
        }),
      );
    }
  }
  await Promise.all(sources);
}
