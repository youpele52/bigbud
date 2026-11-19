import { randomUUID } from "node:crypto";

import type {
  ProjectFileContentMatch,
  ProjectSearchFileContentsResult,
} from "@bigbud/contracts/workspace/project.ts";

import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import {
  REMOTE_AGENT_SEARCH_MODE,
  REMOTE_AGENT_SEARCH_PRIORITY,
  type RemoteAgentWorkspaceSearchCompleted,
} from "./remoteAgentProtocol.search.ts";
import { RemoteAgentWorkspaceError } from "./remoteAgentWorkspaceClient.ts";
import { streamRemoteAgentWorkspaceSearch } from "./remoteAgentWorkspaceSearch.ts";

/** Plan §2 budgets: local searches are interactive (2 s), remote ones background (3 s). */
export const AGENT_CONTENT_SEARCH_BUDGETS = {
  local: { deadlineMs: 2_000, priority: REMOTE_AGENT_SEARCH_PRIORITY.interactive },
  remote: { deadlineMs: 3_000, priority: REMOTE_AGENT_SEARCH_PRIORITY.background },
} as const;

/** Agent refusal code when its per-session search slots (2) are all in use. */
export const AGENT_SEARCH_BUSY = "SEARCH_BUSY";
const BUSY_RETRY_INITIAL_DELAY_MS = 50;
const BUSY_RETRY_MAX_DELAY_MS = 400;
const ROOT_ID = "project";

export type AgentContentSearchConnection = Pick<RemoteAgentConnection, "request" | "nextFrame">;

export interface AgentContentSearchInput {
  /** Absolute project folder on the agent's host. */
  readonly root: string;
  readonly query: string;
  readonly limit: number;
  readonly budget: (typeof AGENT_CONTENT_SEARCH_BUDGETS)[keyof typeof AGENT_CONTENT_SEARCH_BUDGETS];
  readonly signal?: AbortSignal;
  /** Test seam for the busy-slot backoff. */
  readonly wait?: (milliseconds: number, signal: AbortSignal | undefined) => Promise<void>;
}

function wait(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function toMatch(hit: {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly excerpt: string;
}): ProjectFileContentMatch | null {
  if (!hit.path || hit.line <= 0) return null;
  return {
    path: hit.path,
    line: hit.line,
    ...(hit.column > 0 ? { column: hit.column } : {}),
    lineText: hit.excerpt,
  };
}

function assertUsable(completed: RemoteAgentWorkspaceSearchCompleted): void {
  if (completed.errorCode) {
    throw new RemoteAgentWorkspaceError(
      completed.errorCode,
      completed.errorMessage || `Workspace search failed (${completed.errorCode}).`,
    );
  }
  const rootError = completed.rootErrors[0];
  if (rootError) {
    throw new RemoteAgentWorkspaceError(
      rootError.errorCode,
      `Workspace search could not read the project folder (${rootError.errorCode}).`,
    );
  }
  if (completed.stopReason !== "complete" && completed.stopReason !== "limit") {
    if (completed.stopReason === "deadline") return;
    throw new RemoteAgentWorkspaceError(
      "SEARCH_INCOMPLETE",
      `Workspace search stopped early (${completed.stopReason}).`,
    );
  }
}

/**
 * Runs `attempt` until it is not refused with `SEARCH_BUSY` or the busy backoff would pass
 * `deadlineMs`. Every running agent search ends by its own deadline, so a slot frees up soon.
 */
export async function retryWhileAgentSearchBusy(
  attempt: () => Promise<RemoteAgentWorkspaceSearchCompleted>,
  input: {
    readonly deadlineMs: number;
    readonly signal?: AbortSignal | undefined;
    readonly wait?: AgentContentSearchInput["wait"];
  },
): Promise<RemoteAgentWorkspaceSearchCompleted> {
  const sleep = input.wait ?? wait;
  let waited = 0;
  let delay = BUSY_RETRY_INITIAL_DELAY_MS;
  for (;;) {
    input.signal?.throwIfAborted();
    const completed = await attempt();
    if (completed.errorCode !== AGENT_SEARCH_BUSY || waited + delay > input.deadlineMs) {
      return completed;
    }
    await sleep(delay, input.signal);
    waited += delay;
    delay = Math.min(delay * 2, BUSY_RETRY_MAX_DELAY_MS);
  }
}

/**
 * One project's content search over the agent's streaming search (`workspace.search-stream`),
 * shaped like the `projects.searchFileContents` result. One extra hit is requested so a full page
 * is told apart from a truncated one. A deadline returns the hits so far, marked truncated. When
 * both agent search slots are busy, the request is retried with backoff until the deadline.
 */
export async function searchAgentWorkspaceContents(
  connection: AgentContentSearchConnection,
  input: AgentContentSearchInput,
): Promise<ProjectSearchFileContentsResult> {
  const limit = Math.max(0, Math.floor(input.limit));
  let matches: ProjectFileContentMatch[] = [];
  const completed = await retryWhileAgentSearchBusy(
    () => {
      matches = [];
      return streamRemoteAgentWorkspaceSearch(
        connection,
        {
          operationId: `search-content-${randomUUID()}`,
          roots: [{ rootId: ROOT_ID, root: input.root, relativePath: "" }],
          query: input.query,
          mode: REMOTE_AGENT_SEARCH_MODE.content,
          maxResults: limit + 1,
          maxResultsPerRoot: limit + 1,
          deadlineMs: input.budget.deadlineMs,
          maxThreads: 0,
          priority: input.budget.priority,
        },
        {
          onBatch: (batch) => {
            for (const hit of batch.contents) {
              const match = toMatch(hit);
              if (match) matches.push(match);
            }
          },
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
    },
    { deadlineMs: input.budget.deadlineMs, signal: input.signal, wait: input.wait },
  );
  input.signal?.throwIfAborted();
  assertUsable(completed);
  return {
    matches: matches.slice(0, limit),
    truncated: matches.length > limit || (completed.stopReason !== "limit" && completed.truncated),
  };
}
