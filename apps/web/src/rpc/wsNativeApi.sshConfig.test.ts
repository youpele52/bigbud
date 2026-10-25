import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { describe, expect, it } from "vitest";

import { unknownOptionalRpcTag } from "./protocol.optionalRpc";
import { rpcClientMock } from "./wsNativeApi.test.helpers";

describe("wsNativeApi — SSH config hosts", () => {
  it("forwards host discovery to the RPC client", async () => {
    const result = {
      machineName: "macbook",
      hosts: [{ alias: "work-server", sourcePath: "~/.ssh/config", line: 3 }],
      sources: [{ path: "~/.ssh/config", kind: "user" as const, status: "loaded" as const }],
    };
    rpcClientMock.server.listSshConfigHosts.mockResolvedValue(result);
    const { createWsNativeApi } = await import("./wsNativeApi");

    await expect(createWsNativeApi().server.listSshConfigHosts({})).resolves.toEqual(result);
    expect(rpcClientMock.server.listSshConfigHosts).toHaveBeenCalledWith({});
  });

  it("treats an older server's unknown-tag defect as a per-request failure", () => {
    expect(
      unknownOptionalRpcTag(`Unknown request tag: ${WS_METHODS.serverListSshConfigHosts}`),
    ).toBe(WS_METHODS.serverListSshConfigHosts);
  });

  it("forwards host approval with its exact challenge identity", async () => {
    const input = { executionTargetId: "ssh:box", challengeId: "approval-1" };
    rpcClientMock.server.trustSshHost.mockResolvedValue({ message: "Trusted" });
    const { createWsNativeApi } = await import("./wsNativeApi");
    await expect(createWsNativeApi().server.trustSshHost(input)).resolves.toEqual({
      message: "Trusted",
    });
    expect(rpcClientMock.server.trustSshHost).toHaveBeenCalledWith(input);
  });
});
