import { describe, expect, it } from "vitest";

import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool.ts";

function connection(epoch: string): RemoteAgentConnection {
  return {
    handshake: async () => ({
      protocolMajor: 1,
      protocolMinor: 0,
      agentVersion: "0.1.0",
      buildDigest: "development",
      os: "linux",
      architecture: "x86_64",
      agentInstanceId: "agent-1",
      agentEpoch: epoch,
      capabilities: [],
      maxFrameBytes: 1024,
      maxOperationOutputBytes: 1024,
      maxJournalBytes: 1024,
    }),
    close: () => undefined,
  } as unknown as RemoteAgentConnection;
}

describe("remote agent connection pool", () => {
  it("single-flights connections per execution target", async () => {
    let creates = 0;
    const pool = new RemoteAgentConnectionPool({
      create: async () => {
        creates += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return connection("epoch-1");
      },
    });
    const [first, second] = await Promise.all([pool.get("ssh:one"), pool.get("ssh:one")]);
    expect(first).toBe(second);
    expect(creates).toBe(1);
  });

  it("reconnects after transport loss and preserves the epoch guard", async () => {
    let creates = 0;
    const pool = new RemoteAgentConnectionPool({
      create: async () => connection(String(++creates)),
    });
    await pool.get("ssh:one");
    pool.markTransportLoss("ssh:one");
    await expect(pool.get("ssh:one")).rejects.toThrow("epoch changed");
    expect(pool.snapshot("ssh:one").state).toBe("degraded");
  });

  it("invalidates a ready connection when its transport fails", async () => {
    let notifyFailure: ((error: Error) => void) | undefined;
    let creates = 0;
    const pool = new RemoteAgentConnectionPool({
      create: async () => {
        creates += 1;
        const base = connection("epoch-1");
        return {
          ...base,
          onFailure: (listener: (error: Error) => void) => {
            notifyFailure = listener;
            return () => undefined;
          },
        } as unknown as RemoteAgentConnection;
      },
    });

    await pool.get("ssh:one");
    notifyFailure?.(new Error("socket closed"));
    expect(pool.snapshot("ssh:one").state).toBe("reconnecting");
    await pool.get("ssh:one");
    expect(creates).toBe(2);
  });
});
