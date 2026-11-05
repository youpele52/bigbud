import { expect, it } from "vitest";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { rpcClientMock } from "./wsNativeApi.test.helpers";

it("forwards epoch-fenced maintenance once through the existing server RPC client", async () => {
  const input = {
    threadId: ThreadId.makeUnsafe("chat"),
    sessionEpoch: 3,
    action: "compact" as const,
  };
  rpcClientMock.server.providerControls.mockRejectedValue(
    new Error("Disconnected; outcome unknown"),
  );
  const { createWsNativeApi } = await import("./wsNativeApi");
  await expect(createWsNativeApi().server.providerControls!(input)).rejects.toThrow(
    "outcome unknown",
  );
  expect(rpcClientMock.server.providerControls).toHaveBeenCalledExactlyOnceWith(input);
});
