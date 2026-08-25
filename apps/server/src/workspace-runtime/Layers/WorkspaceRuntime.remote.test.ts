import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { RemoteAgentWorkspaceClient } from "../../remote-agent/remoteAgentWorkspaceClient.ts";
import { RemoteAgentConnectionError } from "../../remote-agent/remoteAgentConnection.ts";
import { makeRemoteWorkspaceRuntime } from "./WorkspaceRuntime.remote.ts";

function fakeClient(): RemoteAgentWorkspaceClient {
  return {
    openWorkspace: async () => ({
      requestId: "open",
      workspaceHandle: "workspace",
      accepted: true,
      errorCode: "",
      errorMessage: "",
    }),
    readFile: async () => ({
      requestId: "read",
      operationId: "operation",
      terminal: true,
      bytes: new TextEncoder().encode("remote contents"),
      totalBytes: 15,
      truncated: false,
      errorCode: "",
      errorMessage: "",
    }),
    writeFile: async () => ({
      requestId: "write",
      operationId: "write-operation",
      terminal: true,
      writtenBytes: 7,
      errorCode: "",
      errorMessage: "",
      currentSha256: "",
    }),
    listDirectory: async () => [
      { path: "src", isDirectory: true, isFile: false, sizeBytes: 0 },
      { path: "README.md", isDirectory: false, isFile: true, sizeBytes: 10 },
    ],
    searchFilenames: async () => [{ path: "src", isDirectory: true, isFile: false, sizeBytes: 0 }],
    searchContent: async () => ({
      requestId: "search",
      operationId: "operation",
      terminal: true,
      matches: [{ path: "README.md", line: 2, column: 3, excerpt: "remote contents" }],
      truncated: false,
      errorCode: "",
      errorMessage: "",
    }),
  } as unknown as RemoteAgentWorkspaceClient;
}

describe("remote workspace runtime adapter", () => {
  it("maps agent-backed files and search results to local contracts", async () => {
    const client = fakeClient();
    const runtime = makeRemoteWorkspaceRuntime({ resolve: async () => client });
    const read = await Effect.runPromise(
      runtime.files.readFilePreview({
        executionTargetId: "ssh:example",
        cwd: "/remote/project",
        relativePath: "README.md",
      }),
    );
    expect(read.contents).toBe("remote contents");
    expect(read.sizeBytes).toBe(15);

    const written = await Effect.runPromise(
      runtime.files.writeFile({
        executionTargetId: "ssh:example",
        cwd: "/remote/project",
        relativePath: "README.md",
        contents: "updated",
      }),
    );
    expect(written.relativePath).toBe("README.md");

    const listed = await Effect.runPromise(
      runtime.files.listDirectory({
        executionTargetId: "ssh:example",
        cwd: "/remote/project",
      }),
    );
    expect(listed.entries[0]).toEqual({ path: "src", kind: "directory" });

    const matches = await Effect.runPromise(
      runtime.search.searchFileContents({
        executionTargetId: "ssh:example",
        cwd: "/remote/project",
        query: "remote",
        limit: 10,
      }),
    );
    expect(matches.matches[0]?.lineText).toBe("remote contents");
  });

  it("does not accept local targets through the remote adapter", async () => {
    const runtime = makeRemoteWorkspaceRuntime({ resolve: async () => fakeClient() });
    await expect(
      Effect.runPromise(runtime.files.listDirectory({ cwd: "/local", executionTargetId: "local" })),
    ).rejects.toThrow("requires an SSH execution target");
  });

  it("reopens a read operation once after transport loss without rerunning writes", async () => {
    const replacement = fakeClient();
    const lost = fakeClient();
    const operationIds: Array<string> = [];
    lost.readFile = async (input) => {
      operationIds.push(input.operationId);
      throw new RemoteAgentConnectionError("transport lost");
    };
    replacement.readFile = async (input) => {
      operationIds.push(input.operationId);
      return fakeClient().readFile(input);
    };
    let resolves = 0;
    const runtime = makeRemoteWorkspaceRuntime({
      resolve: async () => {
        resolves += 1;
        return resolves === 1 ? lost : replacement;
      },
    });

    const read = await Effect.runPromise(
      runtime.files.readFilePreview({
        executionTargetId: "ssh:example",
        cwd: "/remote/project",
        relativePath: "README.md",
      }),
    );

    expect(read.contents).toBe("remote contents");
    expect(resolves).toBe(2);
    expect(operationIds).toHaveLength(2);
    expect(operationIds[0]).toBe(operationIds[1]);
  });

  it("uses a fresh operation identity for repeated writes with identical contents", async () => {
    const client = fakeClient();
    const operationIds: Array<string> = [];
    client.writeFile = async (input) => {
      operationIds.push(input.operationId);
      return fakeClient().writeFile(input);
    };
    const runtime = makeRemoteWorkspaceRuntime({ resolve: async () => client });
    const input = {
      executionTargetId: "ssh:example",
      cwd: "/remote/project",
      relativePath: "README.md",
      contents: "updated",
    } as const;

    await Effect.runPromise(runtime.files.writeFile(input));
    await Effect.runPromise(runtime.files.writeFile(input));

    expect(operationIds).toHaveLength(2);
    expect(operationIds[0]).not.toBe(operationIds[1]);
  });
});
