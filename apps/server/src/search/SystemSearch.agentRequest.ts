import { randomUUID } from "node:crypto";

import type { SystemSearchHit, SystemSearchTier } from "@bigbud/contracts/search/systemSearch.ts";

import {
  AGENT_SEARCH_BUSY,
  retryWhileAgentSearchBusy,
  type AgentContentSearchInput,
} from "../remote-agent/agentWorkspaceContentSearch.ts";
import type { RemoteAgentConnection } from "../remote-agent/remoteAgentConnection.ts";
import type { RemoteAgentDirectoryEntry } from "../remote-agent/remoteAgentProtocol.ts";
import {
  REMOTE_AGENT_SEARCH_MODE,
  type RemoteAgentWorkspaceSearchBatch,
} from "../remote-agent/remoteAgentProtocol.search.ts";
import { streamRemoteAgentWorkspaceSearch } from "../remote-agent/remoteAgentWorkspaceSearch.ts";
import type { SystemSearchEmitter } from "./SystemSearch.emitter.ts";
import { contentHitToRow, nameHitToRow } from "./SystemSearch.hits.ts";
import type { SearchRootEntry } from "./SystemSearch.roots.ts";

/** The agent refuses more roots than this in one request (`MAX_SEARCH_ROOTS`). */
export const MAX_ROOTS_PER_AGENT_REQUEST = 128;
/** Old agents answer one folder per legacy request; only the first few are asked. */
export const MAX_LEGACY_ROOTS = 8;
export const LEGACY_NAME_RESULTS_PER_ROOT = 20;

export type SearchAgentConnection = Pick<
  RemoteAgentConnection,
  "request" | "nextFrame" | "supportsCapability"
>;

export interface AgentRequestInput {
  readonly sourceId: string;
  readonly roots: ReadonlyArray<SearchRootEntry>;
  readonly query: string;
  readonly mode: "names" | "both";
  readonly budget: AgentContentSearchInput["budget"];
  readonly maxResults: number;
  readonly maxResultsPerRoot: number;
  readonly emitter: SystemSearchEmitter;
  readonly signal: AbortSignal;
  readonly wait?: AgentContentSearchInput["wait"];
}

function tiersOf(roots: ReadonlyArray<SearchRootEntry>): SystemSearchTier[] {
  return [...new Set(roots.map((root) => root.tier))];
}

function batchRows(
  batch: RemoteAgentWorkspaceSearchBatch,
  roots: ReadonlyMap<string, SearchRootEntry>,
): Map<SystemSearchTier, SystemSearchHit[]> {
  const byTier = new Map<SystemSearchTier, SystemSearchHit[]>();
  const push = (root: SearchRootEntry | undefined, row: SystemSearchHit | null) => {
    if (!root || !row) return;
    const rows = byTier.get(root.tier) ?? [];
    rows.push(row);
    byTier.set(root.tier, rows);
  };
  for (const hit of batch.names) {
    const root = roots.get(hit.rootId);
    push(root, root ? nameHitToRow(root, hit) : null);
  }
  for (const hit of batch.contents) {
    const root = roots.get(hit.rootId);
    push(root, root ? contentHitToRow(root, hit) : null);
  }
  return byTier;
}

/**
 * One streaming agent request (`workspace.search-stream`) over every root of one source. Rows are
 * forwarded per tier as batches arrive; the source ends `done` when the walk completed, `partial`
 * when it was cut short (deadline, limits, unreadable roots), or `unavailable` on refusal.
 * Aborting `signal` sends `CancelRequest` and drops the rest.
 */
export async function searchRootsOnAgent(
  connection: SearchAgentConnection,
  input: AgentRequestInput,
): Promise<void> {
  const tiers = tiersOf(input.roots);
  const roots = input.roots.slice(0, MAX_ROOTS_PER_AGENT_REQUEST);
  const byId = new Map(roots.map((root) => [root.rootId, root]));
  const capped = new Set<SystemSearchTier>();
  for (const tier of tiers)
    input.emitter.state({ tier, sourceId: input.sourceId, state: "searching" });
  try {
    const completed = await retryWhileAgentSearchBusy(
      () =>
        streamRemoteAgentWorkspaceSearch(
          connection,
          {
            operationId: `search-query-${randomUUID()}`,
            roots: roots.map((root) => ({
              rootId: root.rootId,
              root: root.root,
              relativePath: "",
            })),
            query: input.query,
            mode:
              input.mode === "both"
                ? REMOTE_AGENT_SEARCH_MODE.both
                : REMOTE_AGENT_SEARCH_MODE.names,
            maxResults: input.maxResults,
            maxResultsPerRoot: input.maxResultsPerRoot,
            deadlineMs: input.budget.deadlineMs,
            maxThreads: 0,
            priority: input.budget.priority,
          },
          {
            onBatch: (batch) => {
              for (const [tier, items] of batchRows(batch, byId)) {
                if (!input.emitter.rowsFor({ tier, sourceId: input.sourceId, items })) {
                  capped.add(tier);
                }
              }
            },
            signal: input.signal,
          },
        ),
      { deadlineMs: input.budget.deadlineMs, signal: input.signal, wait: input.wait },
    );
    if (input.signal.aborted || completed.stopReason === "cancelled") return;
    if (completed.errorCode) {
      const reason = completed.errorCode === AGENT_SEARCH_BUSY ? "busy" : "error";
      for (const tier of tiers) {
        input.emitter.state({ tier, sourceId: input.sourceId, state: "unavailable", reason });
      }
      return;
    }
    const failedRoots = new Set(completed.rootErrors.map((error) => error.rootId));
    const cut = roots.length < input.roots.length;
    for (const tier of tiers) {
      const tierFailed = roots.some((root) => root.tier === tier && failedRoots.has(root.rootId));
      const truncated = completed.truncated || capped.has(tier) || cut;
      const finished = completed.stopReason === "complete" && !truncated && !tierFailed;
      input.emitter.state({
        tier,
        sourceId: input.sourceId,
        state: finished ? "done" : "partial",
        truncated,
      });
    }
  } catch {
    if (input.signal.aborted) return;
    for (const tier of tiers) {
      input.emitter.state({
        tier,
        sourceId: input.sourceId,
        state: "unavailable",
        reason: "error",
      });
    }
  }
}

/**
 * Old agents without `workspace.search-stream`: names only through the legacy filename search,
 * one folder at a time and only the first few folders, ending `partial` with
 * `agent-update-available`. Content search is skipped on that target (plan §4).
 */
export async function searchRootsLegacy(input: {
  readonly sourceId: string;
  readonly roots: ReadonlyArray<SearchRootEntry>;
  readonly searchFolder: (
    root: SearchRootEntry,
    maxResults: number,
  ) => Promise<ReadonlyArray<RemoteAgentDirectoryEntry>>;
  readonly emitter: SystemSearchEmitter;
  readonly signal: AbortSignal;
}): Promise<void> {
  const tiers = tiersOf(input.roots);
  for (const tier of tiers)
    input.emitter.state({ tier, sourceId: input.sourceId, state: "searching" });
  for (const root of input.roots.slice(0, MAX_LEGACY_ROOTS)) {
    if (input.signal.aborted) return;
    try {
      const entries = await input.searchFolder(root, LEGACY_NAME_RESULTS_PER_ROOT);
      if (input.signal.aborted) return;
      const items = entries.flatMap((entry) => nameHitToRow(root, entry) ?? []);
      input.emitter.rowsFor({ tier: root.tier, sourceId: input.sourceId, items });
    } catch {
      // One unreadable folder does not hide the others; the source stays partial below.
    }
  }
  for (const tier of tiers) {
    input.emitter.state({
      tier,
      sourceId: input.sourceId,
      state: "partial",
      reason: "agent-update-available",
      truncated: input.roots.length > MAX_LEGACY_ROOTS,
    });
  }
}
