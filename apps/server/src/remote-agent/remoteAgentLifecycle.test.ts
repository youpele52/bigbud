import { describe, expect, it } from "vitest";

import { RemoteAgentLifecycle } from "./remoteAgentLifecycle.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";

function connection(hello: { readonly agentEpoch: string }): RemoteAgentConnection {
  return {
    handshake: async () => ({
      protocolMajor: 1,
      protocolMinor: 0,
      agentVersion: "0.1.0",
      buildDigest: "development",
      os: "linux",
      architecture: "x86_64",
      agentInstanceId: "agent-1",
      agentEpoch: hello.agentEpoch,
      capabilities: [],
      maxFrameBytes: 1024,
      maxOperationOutputBytes: 1024,
      maxJournalBytes: 1024,
    }),
    close: () => undefined,
  } as unknown as RemoteAgentConnection;
}

describe("remote agent lifecycle", () => {
  it("distinguishes ready, reconnecting, and pre-acceptance fallback", async () => {
    const lifecycle = new RemoteAgentLifecycle({
      create: async () => connection({ agentEpoch: "1" }),
    });
    await lifecycle.connect();
    expect(lifecycle.snapshot.state).toBe("ready");
    expect(lifecycle.snapshot.agentVersion).toBe("0.1.0");
    expect(lifecycle.snapshot.buildDigest).toBe("development");
    expect(lifecycle.supportsCapability("workspace.files")).toBe(false);
    lifecycle.markTransportLoss();
    expect(lifecycle.snapshot.state).toBe("reconnecting");
    expect(lifecycle.canFallback(false)).toBe(true);
    expect(lifecycle.canFallback(true)).toBe(false);
  });

  it("degrades when a reconnect sees a new agent epoch", async () => {
    let epoch = "1";
    const lifecycle = new RemoteAgentLifecycle({
      create: async () => connection({ agentEpoch: epoch }),
    });
    await lifecycle.connect();
    epoch = "2";
    await expect(lifecycle.connect({ reconnect: true })).rejects.toThrow("epoch changed");
    expect(lifecycle.snapshot.state).toBe("degraded");
  });
});
