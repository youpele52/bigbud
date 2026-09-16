import { describe, expect, it, vi } from "vitest";

import { RemoteAgentConnectionError, RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";

describe("remote agent workspace client", () => {
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
    ).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
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
      ).rejects.toMatchObject({ code: `WRITE_${kind.toUpperCase()}` });
      expect(mutation.terminal).toHaveBeenCalledOnce();
      expect(mutation.unknown).not.toHaveBeenCalled();
    },
  );
});
