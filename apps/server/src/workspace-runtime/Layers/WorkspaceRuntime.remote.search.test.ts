import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import type { RemoteAgentFrame } from "../../remote-agent/remoteAgentProtocol.ts";
import {
  REMOTE_AGENT_SEARCH_STREAM_CAPABILITY,
  type RemoteAgentWorkspaceSearchRequest,
} from "../../remote-agent/remoteAgentProtocol.search.ts";
import type { RemoteAgentWorkspaceClient } from "../../remote-agent/remoteAgentWorkspaceClient.ts";
import { makeRemoteWorkspaceContentSearch } from "./WorkspaceRuntime.remote.search.ts";

const INPUT = {
  executionTargetId: "ssh:example",
  cwd: "/srv/project",
  query: "needle",
  limit: 2,
} as const;

function completed(request: RemoteAgentWorkspaceSearchRequest, stopReason = "complete") {
  return {
    type: "workspaceSearchCompleted",
    value: {
      requestId: request.requestId,
      operationId: request.operationId,
      stopReason,
      truncated: stopReason === "limit",
      filesScanned: 1,
      rootErrors: [],
      errorCode: "",
      errorMessage: "",
      batches: 1,
    },
  } as RemoteAgentFrame;
}

/** A client whose connection answers a streaming search with one batch of `hits` hits. */
function streamingClient(input: { readonly capable: boolean; readonly hits: number }) {
  const sent: RemoteAgentFrame[] = [];
  const legacyCalls: unknown[] = [];
  let pending: RemoteAgentFrame[] = [];
  const connection = {
    supportsCapability: (name: string) =>
      input.capable && name === REMOTE_AGENT_SEARCH_STREAM_CAPABILITY,
    request: async (frame: RemoteAgentFrame) => {
      sent.push(frame);
      if (frame.type !== "workspaceSearchRequest") throw new Error(`unexpected ${frame.type}`);
      const request = frame.value;
      const contents = Array.from({ length: input.hits }, (_, index) => ({
        rootId: request.roots[0]!.rootId,
        path: `src/file-${index}.ts`,
        line: index + 1,
        column: 3,
        excerpt: `a needle ${index}`,
      }));
      pending = [completed(request, input.hits >= request.maxResults ? "limit" : "complete")];
      return {
        type: "workspaceSearchBatch",
        value: {
          requestId: request.requestId,
          operationId: request.operationId,
          sequence: 1,
          names: [],
          contents,
        },
      } as RemoteAgentFrame;
    },
    nextFrame: async () => pending.shift()!,
  };
  const client = {
    connection,
    openWorkspace: async () => ({}),
    searchContent: async (request: unknown) => {
      legacyCalls.push(request);
      return {
        requestId: "legacy",
        operationId: "legacy",
        terminal: true,
        matches: [{ path: "README.md", line: 1, column: 1, excerpt: "legacy needle" }],
        truncated: false,
        errorCode: "",
        errorMessage: "",
      };
    },
  } as unknown as RemoteAgentWorkspaceClient;
  return { client, sent, legacyCalls };
}

function searchWith(client: RemoteAgentWorkspaceClient) {
  return makeRemoteWorkspaceContentSearch({
    resolver: { resolve: async () => client },
    remoteTarget: (target) => target ?? "local",
    open: async () => "workspace",
  });
}

describe("remote workspace content search routing", () => {
  it("streams through the engine when the agent advertises workspace.search-stream", async () => {
    const { client, sent, legacyCalls } = streamingClient({ capable: true, hits: 1 });
    const result = await Effect.runPromise(searchWith(client)(INPUT));

    expect(legacyCalls).toHaveLength(0);
    expect(result).toEqual({
      matches: [{ path: "src/file-0.ts", line: 1, column: 3, lineText: "a needle 0" }],
      truncated: false,
    });
    expect(sent[0]).toMatchObject({
      type: "workspaceSearchRequest",
      value: {
        roots: [{ root: "/srv/project", relativePath: "" }],
        query: "needle",
        mode: 2,
        maxResults: 3,
        maxResultsPerRoot: 3,
        deadlineMs: 3_000,
        priority: 2,
      },
    });
  });

  it("keeps the limit and reports truncation from the one extra hit", async () => {
    const { client } = streamingClient({ capable: true, hits: 3 });
    const result = await Effect.runPromise(searchWith(client)(INPUT));
    expect(result.matches).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("falls back to the legacy frame with the update notice for older agents", async () => {
    const { client, sent, legacyCalls } = streamingClient({ capable: false, hits: 1 });
    const result = await Effect.runPromise(searchWith(client)(INPUT));

    expect(sent).toHaveLength(0);
    expect(legacyCalls).toEqual([
      expect.objectContaining({ workspaceHandle: "workspace", query: "needle", maxResults: 2 }),
    ]);
    expect(result).toEqual({
      matches: [{ path: "README.md", line: 1, column: 1, lineText: "legacy needle" }],
      truncated: false,
      notice: "agent-update-available",
    });
  });

  it("sends CancelRequest when the search is interrupted", async () => {
    const sent: RemoteAgentFrame[] = [];
    let release: ((frame: RemoteAgentFrame) => void) | undefined;
    let request: RemoteAgentWorkspaceSearchRequest | undefined;
    const searchSent = Promise.withResolvers<void>();
    const client = {
      connection: {
        supportsCapability: () => true,
        request: (frame: RemoteAgentFrame) => {
          sent.push(frame);
          if (frame.type === "workspaceSearchRequest") {
            request = frame.value;
            searchSent.resolve();
            return new Promise<RemoteAgentFrame>((resolve) => {
              release = resolve;
            });
          }
          release?.(completed(request!, "cancelled"));
          return Promise.resolve({
            type: "cancelResponse",
            value: {
              requestId: "cancel",
              operationId: "",
              cancelled: true,
              terminal: false,
              detail: "",
            },
          } as RemoteAgentFrame);
        },
        nextFrame: async () => {
          throw new Error("no further frames");
        },
      },
    } as unknown as RemoteAgentWorkspaceClient;

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(searchWith(client)(INPUT));
        yield* Effect.promise(() => searchSent.promise);
        yield* Fiber.interrupt(fiber);
      }),
    );

    expect(sent.map((frame) => frame.type)).toEqual(["workspaceSearchRequest", "cancelRequest"]);
    expect(sent[1]).toMatchObject({ value: { operationId: request!.operationId } });
  });
});
