import { describe, expect, it } from "vitest";

import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type { RemoteAgentWorkspaceSearchCompleted } from "./remoteAgentProtocol.search.ts";
import {
  RemoteAgentSearchSequenceError,
  streamRemoteAgentWorkspaceSearch,
} from "./remoteAgentWorkspaceSearch.ts";

const REQUEST = {
  operationId: "op-1",
  roots: [{ rootId: "a", root: "/work/a", relativePath: "" }],
  query: "needle",
  mode: 2,
  maxResults: 200,
  maxResultsPerRoot: 20,
  deadlineMs: 2_000,
  maxThreads: 0,
  priority: 1,
} as const;

function batch(sequence: number): RemoteAgentFrame {
  return {
    type: "workspaceSearchBatch",
    value: { requestId: "r", operationId: "op-1", sequence, names: [], contents: [] },
  };
}

function completed(stopReason: string): RemoteAgentFrame {
  const value: RemoteAgentWorkspaceSearchCompleted = {
    requestId: "r",
    operationId: "op-1",
    stopReason,
    truncated: false,
    filesScanned: 3,
    rootErrors: [],
    errorCode: "",
    errorMessage: "",
    batches: 2,
  };
  return { type: "workspaceSearchCompleted", value };
}

/** Fake connection: the request answers with the first frame, `nextFrame` with the rest. */
function fakeConnection(frames: RemoteAgentFrame[], onBeforeNext?: () => void) {
  const sent: RemoteAgentFrame[] = [];
  return {
    sent,
    connection: {
      request: async (frame: RemoteAgentFrame) => {
        sent.push(frame);
        if (frame.type === "cancelRequest") {
          return {
            type: "cancelResponse",
            value: {
              requestId: frame.value.requestId,
              operationId: "op-1",
              cancelled: true,
              terminal: false,
              detail: "",
            },
          } as RemoteAgentFrame;
        }
        return frames.shift()!;
      },
      nextFrame: async () => {
        onBeforeNext?.();
        return frames.shift()!;
      },
    },
  };
}

describe("streamRemoteAgentWorkspaceSearch", () => {
  it("delivers batches in order and returns the single completion", async () => {
    const { connection, sent } = fakeConnection([batch(1), batch(2), completed("complete")]);
    const seen: number[] = [];
    const result = await streamRemoteAgentWorkspaceSearch(connection, REQUEST, {
      requestId: "r",
      onBatch: (value) => seen.push(value.sequence),
    });
    expect(seen).toEqual([1, 2]);
    expect(result.stopReason).toBe("complete");
    expect(sent[0]).toMatchObject({ type: "workspaceSearchRequest", value: { requestId: "r" } });
  });

  it("sends CancelRequest on abort, stops delivering batches, and drains to completion", async () => {
    const controller = new AbortController();
    const { connection, sent } = fakeConnection([batch(1), batch(2), completed("cancelled")], () =>
      controller.abort(),
    );
    const seen: number[] = [];
    const result = await streamRemoteAgentWorkspaceSearch(connection, REQUEST, {
      requestId: "r",
      signal: controller.signal,
      onBatch: (value) => seen.push(value.sequence),
    });
    expect(seen).toEqual([1]);
    expect(result.stopReason).toBe("cancelled");
    expect(sent.filter((frame) => frame.type === "cancelRequest")).toEqual([
      { type: "cancelRequest", value: { requestId: "cancel-r", operationId: "op-1" } },
    ]);
  });

  it("rejects a sequence gap", async () => {
    const { connection } = fakeConnection([batch(1), batch(3), completed("complete")]);
    await expect(
      streamRemoteAgentWorkspaceSearch(connection, REQUEST, { requestId: "r", onBatch: () => {} }),
    ).rejects.toBeInstanceOf(RemoteAgentSearchSequenceError);
  });
});
