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
});
