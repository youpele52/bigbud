import { expect, it } from "vitest";
import { rpcClientMock } from "./wsNativeApi.test.helpers";

it("routes recovery cuts through the dedicated RPC without falling back to open or restart", async () => {
  const { createWsNativeApi } = await import("./wsNativeApi");
  const api = createWsNativeApi();
  const input = {
    threadId: "thread",
    terminalId: "default",
    expectedGeneration: "generation",
    after: { generation: "generation", sequence: 42 },
  };
  rpcClientMock.terminal.recovery.mockResolvedValue({
    type: "unavailable",
    reason: "pending-renderer-query",
  });
  await expect(api.terminal.recovery!(input)).resolves.toEqual({
    type: "unavailable",
    reason: "pending-renderer-query",
  });
  expect(rpcClientMock.terminal.recovery).toHaveBeenCalledWith(input);
  expect(rpcClientMock.terminal.open).not.toHaveBeenCalled();
  expect(rpcClientMock.terminal.restart).not.toHaveBeenCalled();
  rpcClientMock.terminal.recovery.mockRejectedValue(new Error("older server"));
  await expect(api.terminal.recovery!(input)).rejects.toThrow("older server");
  expect(rpcClientMock.terminal.open).not.toHaveBeenCalled();
});
