import { Effect } from "effect";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  REMOTE_AGENT_CREATE_ONLY_WRITE_CAPABILITY,
  RemoteAgentWorkspaceError,
  type RemoteAgentWorkspaceClient,
} from "../../remote-agent/remoteAgentWorkspaceClient.ts";
import { RemoteAgentConnectionError } from "../../remote-agent/remoteAgentConnection.ts";
import {
  WORKSPACE_FILE_ALREADY_EXISTS,
  WORKSPACE_WRITE_CREATE_ONLY_OPERATION,
} from "../../workspace/Services/WorkspaceFileSystem.ts";
import { makeRemoteWorkspaceRuntime } from "./WorkspaceRuntime.remote.ts";

function fakeClient(): RemoteAgentWorkspaceClient {
  return {
    connection: { supportsCapability: () => false },
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
    expect(read.sha256).toBe(createHash("sha256").update("remote contents").digest("hex"));
    // The fake agent advertises no capabilities, so it cannot save: read only.
    expect(read.edit).toEqual({ mode: "readOnly", maxBytes: 0, reason: "agentTooOld" });

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
    expect(matches.notice).toBe("agent-update-available");
  });

  it("does not accept local targets through the remote adapter", async () => {
    const runtime = makeRemoteWorkspaceRuntime({ resolve: async () => fakeClient() });
    await expect(
      Effect.runPromise(runtime.files.listDirectory({ cwd: "/local", executionTargetId: "local" })),
    ).rejects.toThrow("requires an SSH execution target");
  });

  it("reports resolution failure as undispatched rather than a native write failure", async () => {
    const runtime = makeRemoteWorkspaceRuntime({
      resolve: async () => {
        throw new Error("unavailable");
      },
    });
    const error = await Effect.runPromise(
      Effect.flip(
        runtime.files.writeFile({
          executionTargetId: "ssh:example",
          cwd: "/remote/project",
          relativePath: "README.md",
          contents: "updated",
        }),
      ),
    );
    expect(error).toMatchObject({ writeDisposition: "not-dispatched" });
  });

  it("reopens a read operation once after transport loss without rerunning writes", async () => {
    const replacement = fakeClient();
    const lost = Object.assign(fakeClient(), { reconnect: async () => replacement });
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
    expect(resolves).toBe(1);
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

  const createOnlyInput = {
    executionTargetId: "ssh:example",
    cwd: "/remote/project",
    relativePath: "settings.json",
    contents: "{}",
    createOnly: true,
  } as const;

  function createOnlyClient(capabilities: ReadonlyArray<string>, errorCode = "") {
    const client = fakeClient();
    const requests: Array<Parameters<RemoteAgentWorkspaceClient["writeFile"]>[0]> = [];
    Object.assign(client, {
      connection: { supportsCapability: (name: string) => capabilities.includes(name) },
    });
    client.writeFile = async (input) => {
      requests.push(input);
      if (errorCode) throw new RemoteAgentWorkspaceError(errorCode, "exists", "terminal");
      return fakeClient().writeFile(input);
    };
    return { client, requests };
  }

  it("refuses create-only writes for agents without exclusive create, before dispatch", async () => {
    const { client, requests } = createOnlyClient(["workspace.write"]);
    const runtime = makeRemoteWorkspaceRuntime({ resolve: async () => client });
    const error = await Effect.runPromise(Effect.flip(runtime.files.writeFile(createOnlyInput)));

    expect(error).toMatchObject({
      writeDisposition: "not-dispatched",
      detail: "Create-only writes need a newer remote agent; update it and retry.",
    });
    expect(requests).toHaveLength(0);
  });

  it("forwards create-only writes to capable agents and maps an existing file", async () => {
    const capable = createOnlyClient([REMOTE_AGENT_CREATE_ONLY_WRITE_CAPABILITY]);
    const runtime = makeRemoteWorkspaceRuntime({ resolve: async () => capable.client });
    await Effect.runPromise(runtime.files.writeFile(createOnlyInput));
    expect(capable.requests[0]).toMatchObject({ path: "settings.json", createOnly: true });

    const existing = createOnlyClient(
      [REMOTE_AGENT_CREATE_ONLY_WRITE_CAPABILITY],
      "ALREADY_EXISTS",
    );
    const refused = makeRemoteWorkspaceRuntime({ resolve: async () => existing.client });
    const error = await Effect.runPromise(Effect.flip(refused.files.writeFile(createOnlyInput)));
    expect(error).toMatchObject({
      operation: WORKSPACE_WRITE_CREATE_ONLY_OPERATION,
      detail: WORKSPACE_FILE_ALREADY_EXISTS,
      writeDisposition: "terminal",
    });
  });

  it("refuses create-only writes that also carry an expected hash", async () => {
    const { client, requests } = createOnlyClient([REMOTE_AGENT_CREATE_ONLY_WRITE_CAPABILITY]);
    const runtime = makeRemoteWorkspaceRuntime({ resolve: async () => client });
    const error = await Effect.runPromise(
      Effect.flip(runtime.files.writeFile({ ...createOnlyInput, expectedSha256: "a".repeat(64) })),
    );
    expect(error).toMatchObject({ writeDisposition: "not-dispatched" });
    expect(requests).toHaveLength(0);
  });
});

describe("remote workspace guarded writes", () => {
  const write = (client: RemoteAgentWorkspaceClient) =>
    makeRemoteWorkspaceRuntime({ resolve: async () => client }).files.writeFile({
      executionTargetId: "ssh:example",
      cwd: "/remote/project",
      relativePath: "README.md",
      contents: "updated",
      expectedSha256: "a".repeat(64),
    });

  it("returns the hash a workspace.write 1.1 agent reports and omits it for older agents", async () => {
    const reporting = fakeClient();
    reporting.writeFile = async () => ({
      ...(await fakeClient().writeFile({} as never)),
      currentSha256: "c".repeat(64),
    });
    expect(await Effect.runPromise(write(reporting))).toEqual({
      relativePath: "README.md",
      resultSha256: "c".repeat(64),
    });
    expect(await Effect.runPromise(write(fakeClient()))).toEqual({ relativePath: "README.md" });
  });

  it("maps an agent WRITE_CONFLICT to a typed conflict carrying the disk hash", async () => {
    const client = fakeClient();
    client.writeFile = async () => {
      throw new RemoteAgentWorkspaceError(
        "WRITE_CONFLICT",
        "workspace file changed since it was read",
        "terminal",
        "d".repeat(64),
      );
    };
    const error = await Effect.runPromise(Effect.flip(write(client)));
    expect(error).toMatchObject({
      conflict: true,
      currentSha256: "d".repeat(64),
      writeDisposition: "terminal",
    });
  });
});

describe("remote workspace edit capability", () => {
  it("reports guarded saves only when the agent advertises workspace.write", async () => {
    const client = fakeClient();
    Object.assign(client, {
      connection: { supportsCapability: (name: string) => name === "workspace.write" },
    });
    const read = await Effect.runPromise(
      makeRemoteWorkspaceRuntime({ resolve: async () => client }).files.readFilePreview({
        executionTargetId: "ssh:example",
        cwd: "/remote/project",
        relativePath: "README.md",
      }),
    );
    expect(read.edit).toEqual({ mode: "guarded", maxBytes: 512 * 1024 });
  });
});
