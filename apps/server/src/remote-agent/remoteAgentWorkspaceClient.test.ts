import { describe, expect, it, vi } from "vitest";

import { RemoteAgentConnectionError, RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";

describe("remote agent workspace client", () => {
  it("rechecks queued authorization after durable preparation and never sends a revoked write", async () => {
    const request = vi.fn();
    let enabled = true;
    const mutation = {
      prepare: vi.fn(async () => {
        enabled = false;
      }),
      terminal: vi.fn(),
      unknown: vi.fn(),
    };
    const client = new RemoteAgentWorkspaceClient(
      { request } as unknown as RemoteAgentConnection,
      undefined,
      mutation,
    );
    await expect(
      client.writeFile(
        {
          workspaceHandle: "workspace",
          path: "file.txt",
          operationId: "revoked",
          requestDigest: new Uint8Array([1]),
          bytes: new Uint8Array([2]),
        },
        async () => {
          if (!enabled) throw new Error("revoked");
          return () => {};
        },
      ),
    ).rejects.toMatchObject({ message: "revoked", writeDisposition: "not-dispatched" });
    expect(request).not.toHaveBeenCalled();
    expect(mutation.terminal).toHaveBeenCalledWith("revoked");
    expect(mutation.unknown).not.toHaveBeenCalled();
  });
  it("reports unknown outcome when a write loses transport before its response", async () => {
    const connection = {
      request: async () => {
        throw new RemoteAgentConnectionError("connection lost");
      },
    } as unknown as RemoteAgentConnection;
    const client = new RemoteAgentWorkspaceClient(connection);

    await expect(
      client.writeFile({
        workspaceHandle: "workspace",
        path: "file.txt",
        operationId: "write-1",
        requestDigest: new Uint8Array([1]),
        bytes: new TextEncoder().encode("next"),
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME", writeDisposition: "unknown" });
  });

  it.each(["conflict", "size-limit", "rejected"])(
    "marks a definitive %s response terminal instead of unknown",
    async (kind) => {
      const mutation = { prepare: vi.fn(), terminal: vi.fn(), unknown: vi.fn() };
      const connection = {
        request: async () => ({
          type: "writeFileResponse",
          value: {
            terminal: true,
            errorCode: `WRITE_${kind.toUpperCase()}`,
            errorMessage: kind,
          },
        }),
      } as unknown as RemoteAgentConnection;
      await expect(
        new RemoteAgentWorkspaceClient(connection, undefined, mutation).writeFile({
          workspaceHandle: "workspace",
          path: "file.txt",
          operationId: `write-${kind}`,
          requestDigest: new Uint8Array([1]),
          bytes: new Uint8Array([2]),
        }),
      ).rejects.toMatchObject({
        code: `WRITE_${kind.toUpperCase()}`,
        writeDisposition: "terminal",
      });
      expect(mutation.terminal).toHaveBeenCalledOnce();
      expect(mutation.unknown).not.toHaveBeenCalled();
    },
  );

  it.each([
    { terminal: false, errorCode: "" },
    { terminal: true, errorCode: "UNKNOWN_OUTCOME" },
  ])(
    "keeps an unknown native response $errorCode unknown when recording it fails",
    async (response) => {
      const mutation = {
        prepare: vi.fn(),
        terminal: vi.fn(),
        unknown: vi.fn().mockRejectedValue(new Error("owner unavailable")),
      };
      const connection = {
        request: async () => ({ value: response }),
      } as unknown as RemoteAgentConnection;
      await expect(
        new RemoteAgentWorkspaceClient(connection, undefined, mutation).writeFile({
          workspaceHandle: "workspace",
          path: "file.txt",
          operationId: "uncertain",
          requestDigest: new Uint8Array([1]),
          bytes: new Uint8Array([2]),
        }),
      ).rejects.toMatchObject({ writeDisposition: "unknown" });
      expect(mutation.terminal).not.toHaveBeenCalled();
    },
  );

  it("keeps revoked writes undispatched even when reservation cleanup fails", async () => {
    const request = vi.fn();
    const mutation = {
      prepare: vi.fn(),
      terminal: vi.fn().mockRejectedValue(new Error("cleanup failed")),
      unknown: vi.fn(),
    };
    const client = new RemoteAgentWorkspaceClient(
      { request } as unknown as RemoteAgentConnection,
      undefined,
      mutation,
    );
    await expect(
      client.writeFile(
        {
          workspaceHandle: "workspace",
          path: "file.txt",
          operationId: "revoked",
          requestDigest: new Uint8Array([1]),
          bytes: new Uint8Array([2]),
        },
        async () => {
          throw new Error("revoked");
        },
      ),
    ).rejects.toMatchObject({ writeDisposition: "not-dispatched" });
    expect(request).not.toHaveBeenCalled();
  });
});
