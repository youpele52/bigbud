import { describe, expect, it } from "vitest";

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
});
