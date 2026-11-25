import { describe, expect, it, vi } from "vitest";

import { RemoteAgentLifecycle } from "./remoteAgentLifecycle.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";

function connection(hello: { readonly agentEpoch: string; readonly agentInstanceId?: string }) {
  return {
    handshake: async () => ({
      protocolMajor: 1,
      protocolMinor: 0,
      agentVersion: "0.1.0",
      buildDigest: "development",
      os: "linux",
      architecture: "x86_64",
      agentInstanceId: hello.agentInstanceId ?? "agent-1",
      agentEpoch: hello.agentEpoch,
      capabilities: [],
      maxFrameBytes: 1024,
      maxOperationOutputBytes: 1024,
      maxJournalBytes: 1024,
    }),
    close: vi.fn(),
  };
}

const asConnection = (value: ReturnType<typeof connection>) =>
  value as unknown as RemoteAgentConnection;

describe("remote agent lifecycle", () => {
  it("retains the agent identity while reconnecting", async () => {
    const lifecycle = new RemoteAgentLifecycle({
      create: async () => asConnection(connection({ agentEpoch: "1" })),
    });
    await lifecycle.connect();
    expect(lifecycle.snapshot.state).toBe("ready");
    expect(lifecycle.snapshot.agentVersion).toBe("0.1.0");
    expect(lifecycle.snapshot.buildDigest).toBe("development");
    expect(lifecycle.supportsCapability("workspace.files")).toBe(false);
    lifecycle.markTransportLoss();
    expect(lifecycle.snapshot.state).toBe("reconnecting");
    expect(lifecycle.snapshot.agentEpoch).toBe("1");
  });

  it("degrades when a reconnect sees a new agent epoch", async () => {
    let epoch = "1";
    const lifecycle = new RemoteAgentLifecycle({
      create: async () => asConnection(connection({ agentEpoch: epoch })),
    });
    await lifecycle.connect();
    epoch = "2";
    await expect(lifecycle.connect({ reconnect: true })).rejects.toThrow("epoch changed");
    expect(lifecycle.snapshot.state).toBe("degraded");
    expect(lifecycle.snapshot.agentEpoch).toBe("1");
    await expect(lifecycle.connect({ reconnect: true })).rejects.toThrow("epoch changed");
    expect(lifecycle.snapshot.agentEpoch).toBe("1");
  });

  it("rejects a replacement instance that presents the retained epoch", async () => {
    const original = connection({ agentEpoch: "1", agentInstanceId: "original" });
    const replacement = connection({ agentEpoch: "1", agentInstanceId: "replacement" });
    const create = vi.fn().mockResolvedValueOnce(original).mockResolvedValue(replacement);
    const lifecycle = new RemoteAgentLifecycle({ create, expectedEpoch: "1" });
    await lifecycle.connect();
    lifecycle.markTransportLoss();
    await expect(lifecycle.connect({ reconnect: true })).rejects.toThrow("instance changed");
    expect(lifecycle.connection).toBeNull();
    expect(lifecycle.snapshot).toMatchObject({ state: "degraded", agentEpoch: "1" });
    expect(replacement.close).toHaveBeenCalledOnce();
    await expect(lifecycle.connect({ reconnect: true })).rejects.toThrow("instance changed");
  });
});
