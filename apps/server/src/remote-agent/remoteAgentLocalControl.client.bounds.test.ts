import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sendRemoteAgentControlRequest } from "./remoteAgentLocalControl.client.ts";
import { startRemoteAgentLocalControlServer } from "./remoteAgentLocalControl.server.ts";

it.skipIf(process.platform === "win32")(
  "rejects an oversized Unix response without retaining an unbounded buffer",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "bb-"));
    const socketPath = join(directory, "control.sock");
    const server = await startRemoteAgentLocalControlServer({
      socketPath,
      handle: async () => ({
        v: 1,
        ok: true,
        result: "x".repeat(1024 * 1024),
      }),
    });
    try {
      await expect(
        sendRemoteAgentControlRequest(socketPath, { method: "status", target: "fixture" }, 2000),
      ).rejects.toThrow("reply exceeds the control limit");
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
