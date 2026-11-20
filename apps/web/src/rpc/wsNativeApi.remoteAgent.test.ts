import { describe, expect, it } from "vitest";

import { rpcClientMock } from "./wsNativeApi.test.helpers";

describe("wsNativeApi — remote-agent status", () => {
  it("forwards persisted status queries with the reconnect request identity", async () => {
    const status = {
      executionTargetId: "ssh:test",
      phase: "ready-for-next-reconnect" as const,
      updateRequestId: "update-207",
      reconnectRequestId: "reconnect-1",
      reconnectOutcome: "pending" as const,
      currentVersion: "0.2.205",
      pendingVersion: "0.2.207",
      predecessorVersion: null,
      reason: null,
      currentTargetTriple: "x86_64-unknown-linux-gnu",
      currentBuildDigestShort: "aaaaaaaaaaaa",
      pendingTargetTriple: "x86_64-unknown-linux-musl",
      pendingBuildDigestShort: "bbbbbbbbbbbb",
    };
    rpcClientMock.server.getRemoteAgentUpdateStatus.mockResolvedValue(status);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const result = await createWsNativeApi().server.getRemoteAgentUpdateStatus({
      executionTargetId: "ssh:test",
      reconnectRequestId: "reconnect-1",
    });

    expect(result).toEqual(status);
    expect(rpcClientMock.server.getRemoteAgentUpdateStatus).toHaveBeenCalledWith({
      executionTargetId: "ssh:test",
      reconnectRequestId: "reconnect-1",
    });
  });

  it("forwards Remove agent with the Direct SSH switch and returns blockers as results", async () => {
    const blocked = {
      outcome: "blocked" as const,
      blockers: [{ kind: "terminal" as const, label: "Terminal in /srv" }],
    };
    rpcClientMock.server.removeRemoteAgent.mockResolvedValue(blocked);
    const { createWsNativeApi } = await import("./wsNativeApi");

    const input = {
      executionTargetId: "ssh:host=box&transport=agent" as never,
      switchWorkspacesToDirectSsh: true,
    };
    await expect(createWsNativeApi().server.removeRemoteAgent(input)).resolves.toEqual(blocked);
    expect(rpcClientMock.server.removeRemoteAgent).toHaveBeenCalledWith(input);
  });
});
