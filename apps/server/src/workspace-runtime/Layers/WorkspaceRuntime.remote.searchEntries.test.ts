import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import type { RemoteAgentFrame } from "../../remote-agent/remoteAgentProtocol.ts";
import {
  REMOTE_AGENT_SEARCH_MODE,
  REMOTE_AGENT_SEARCH_STREAM_CAPABILITY,
  type RemoteAgentWorkspaceSearchRequest,
} from "../../remote-agent/remoteAgentProtocol.search.ts";
import type { RemoteAgentWorkspaceClient } from "../../remote-agent/remoteAgentWorkspaceClient.ts";
import { makeRemoteWorkspaceEntrySearch } from "./WorkspaceRuntime.remote.searchEntries.ts";

const INPUT = {
  executionTargetId: "ssh:example",
  cwd: "/srv/project",
  query: "readme",
  limit: 2,
} as const;

function completed(request: RemoteAgentWorkspaceSearchRequest, stopReason = "complete") {
  return {
    type: "workspaceSearchCompleted",
    value: {
      requestId: request.requestId,
      operationId: request.operationId,
      stopReason,
      truncated: false,
      filesScanned: 3,
      rootErrors: [],
      errorCode: "",
      errorMessage: "",
      batches: 1,
    },
  } as RemoteAgentFrame;
}

function client(input: { readonly capable: boolean; readonly names: readonly string[] }) {
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
      pending = [completed(request)];
      return {
        type: "workspaceSearchBatch",
        value: {
          requestId: request.requestId,
          operationId: request.operationId,
          sequence: 1,
          names: input.names.map((path, index) => ({
            rootId: request.roots[0]!.rootId,
            path,
            isDirectory: path === "docs",
            sizeBytes: 4,
            modifiedUnixMs: 0,
            score: index,
          })),
          contents: [],
        },
      } as RemoteAgentFrame;
    },
    nextFrame: async () => pending.shift()!,
  };
  const fake = {
    connection,
    openWorkspace: async () => ({}),
    searchFilenames: async (request: unknown) => {
      legacyCalls.push(request);
      return [{ path: "README.md", isDirectory: false, isFile: true, sizeBytes: 4 }];
    },
  } as unknown as RemoteAgentWorkspaceClient;
  return { fake, sent, legacyCalls };
}

function searchWith(fake: RemoteAgentWorkspaceClient) {
  return makeRemoteWorkspaceEntrySearch({
    resolver: { resolve: async () => fake },
    remoteTarget: (target) => target ?? "local",
    open: async () => "workspace",
  });
}

describe("remote workspace entry search routing", () => {
  it("uses the engine's names mode, best first, when the agent has workspace.search-stream", async () => {
    const { fake, sent, legacyCalls } = client({ capable: true, names: ["docs/README.md"] });
    const result = await Effect.runPromise(searchWith(fake)(INPUT));
    expect(legacyCalls).toHaveLength(0);
    expect(result).toEqual({
      entries: [{ path: "docs/README.md", kind: "file", parentPath: "docs" }],
      truncated: false,
    });
    expect(sent[0]).toMatchObject({
      type: "workspaceSearchRequest",
      value: {
        roots: [{ root: "/srv/project", relativePath: "" }],
        query: "readme",
        mode: REMOTE_AGENT_SEARCH_MODE.names,
        maxResults: 2,
        maxResultsPerRoot: 2,
      },
    });
  });

  it("reports a full page as truncated, like the legacy result", async () => {
    const { fake } = client({ capable: true, names: ["README.md", "docs"] });
    const result = await Effect.runPromise(searchWith(fake)(INPUT));
    expect(result.entries.map((entry) => entry.kind)).toEqual(["file", "directory"]);
    expect(result.truncated).toBe(true);
  });

  it("keeps the legacy walker with the update notice for older agents", async () => {
    const { fake, sent, legacyCalls } = client({ capable: false, names: [] });
    const result = await Effect.runPromise(searchWith(fake)(INPUT));
    expect(sent).toHaveLength(0);
    expect(legacyCalls).toEqual([
      expect.objectContaining({ workspaceHandle: "workspace", query: "readme", maxResults: 2 }),
    ]);
    expect(result).toEqual({
      entries: [{ path: "README.md", kind: "file" }],
      truncated: false,
      notice: "agent-update-available",
    });
  });

  it("sends CancelRequest when the search is interrupted", async () => {
    const sent: RemoteAgentFrame[] = [];
    let release: ((frame: RemoteAgentFrame) => void) | undefined;
    let request: RemoteAgentWorkspaceSearchRequest | undefined;
    const searchSent = Promise.withResolvers<void>();
    const fake = {
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
              requestId: "c",
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
        const fiber = yield* Effect.forkChild(searchWith(fake)(INPUT));
        yield* Effect.promise(() => searchSent.promise);
        yield* Fiber.interrupt(fiber);
      }),
    );
    expect(sent.map((frame) => frame.type)).toEqual(["workspaceSearchRequest", "cancelRequest"]);
  });
});
