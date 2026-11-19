import { describe, expect, it } from "vitest";

import {
  AGENT_CONTENT_SEARCH_BUDGETS,
  AGENT_SEARCH_BUSY,
  searchAgentWorkspaceContents,
} from "./agentWorkspaceContentSearch.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type {
  RemoteAgentWorkspaceSearchCompleted,
  RemoteAgentWorkspaceSearchRequest,
} from "./remoteAgentProtocol.search.ts";
import { RemoteAgentWorkspaceError } from "./remoteAgentWorkspaceClient.ts";

type Completion = Partial<Omit<RemoteAgentWorkspaceSearchCompleted, "requestId" | "operationId">>;

/** Each request is answered with the next scripted completion (no batches unless `hits`). */
function scriptedConnection(script: ReadonlyArray<Completion & { readonly hits?: number }>) {
  const requests: RemoteAgentWorkspaceSearchRequest[] = [];
  let pending: RemoteAgentFrame | undefined;
  const complete = (request: RemoteAgentWorkspaceSearchRequest, value: Completion) =>
    ({
      type: "workspaceSearchCompleted",
      value: {
        requestId: request.requestId,
        operationId: request.operationId,
        stopReason: "complete",
        truncated: false,
        filesScanned: 0,
        rootErrors: [],
        errorCode: "",
        errorMessage: "",
        batches: 0,
        ...value,
      },
    }) as RemoteAgentFrame;
  return {
    requests,
    connection: {
      request: async (frame: RemoteAgentFrame) => {
        if (frame.type !== "workspaceSearchRequest") throw new Error(`unexpected ${frame.type}`);
        const request = frame.value;
        requests.push(request);
        const { hits = 0, ...value } = script[requests.length - 1] ?? {};
        if (hits === 0) return complete(request, value);
        pending = complete(request, value);
        return {
          type: "workspaceSearchBatch",
          value: {
            requestId: request.requestId,
            operationId: request.operationId,
            sequence: 1,
            names: [],
            contents: Array.from({ length: hits }, (_, index) => ({
              rootId: "project",
              path: `f${index}.txt`,
              line: 1,
              column: index === 0 ? 0 : 4,
              excerpt: "needle",
            })),
          },
        } as RemoteAgentFrame;
      },
      nextFrame: async () => pending!,
    },
  };
}

const base = {
  root: "/work",
  query: "needle",
  limit: 5,
  budget: AGENT_CONTENT_SEARCH_BUDGETS.local,
};

describe("searchAgentWorkspaceContents", () => {
  it("maps hits, omits a zero column, and asks for one extra hit", async () => {
    const { connection, requests } = scriptedConnection([{ hits: 2 }]);
    const result = await searchAgentWorkspaceContents(connection, base);
    expect(result).toEqual({
      matches: [
        { path: "f0.txt", line: 1, lineText: "needle" },
        { path: "f1.txt", line: 1, column: 4, lineText: "needle" },
      ],
      truncated: false,
    });
    expect(requests[0]).toMatchObject({ maxResults: 6, deadlineMs: 2_000, priority: 1 });
  });

  it("returns partial hits marked truncated when the deadline stops the walk", async () => {
    const { connection } = scriptedConnection([
      { hits: 1, stopReason: "deadline", truncated: true },
    ]);
    const result = await searchAgentWorkspaceContents(connection, base);
    expect(result).toMatchObject({ truncated: true });
    expect(result.matches).toHaveLength(1);
  });

  it("retries a busy agent with backoff, then succeeds", async () => {
    const { connection, requests } = scriptedConnection([
      { stopReason: "error", errorCode: AGENT_SEARCH_BUSY },
      { stopReason: "error", errorCode: AGENT_SEARCH_BUSY },
      { hits: 1 },
    ]);
    const waits: number[] = [];
    const result = await searchAgentWorkspaceContents(connection, {
      ...base,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    expect(waits).toEqual([50, 100]);
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((request) => request.operationId)).size).toBe(3);
    expect(result.matches).toHaveLength(1);
  });

  it("gives up on a busy agent once the waits would pass the deadline", async () => {
    const { connection, requests } = scriptedConnection(
      Array.from({ length: 20 }, () => ({ stopReason: "error", errorCode: AGENT_SEARCH_BUSY })),
    );
    const error = await searchAgentWorkspaceContents(connection, {
      ...base,
      wait: async () => {},
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RemoteAgentWorkspaceError);
    expect(error).toMatchObject({ code: AGENT_SEARCH_BUSY });
    // 50 + 100 + 200 + 400 × 4 = 1 950 ms of waiting fits a 2 s deadline; one more would not.
    expect(requests).toHaveLength(8);
  });

  it("fails clearly for refusals, unreadable roots and stopped searches", async () => {
    for (const [completion, code] of [
      [
        { stopReason: "error", errorCode: "INVALID_ARGUMENT", errorMessage: "bad" },
        "INVALID_ARGUMENT",
      ],
      [{ rootErrors: [{ rootId: "project", errorCode: "ROOT_MISSING" }] }, "ROOT_MISSING"],
      [{ stopReason: "disconnected" }, "SEARCH_INCOMPLETE"],
    ] as const) {
      const { connection } = scriptedConnection([completion]);
      await expect(searchAgentWorkspaceContents(connection, base)).rejects.toMatchObject({ code });
    }
  });
});
