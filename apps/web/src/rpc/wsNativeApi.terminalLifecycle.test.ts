import { expect, it } from "vitest";
import { rpcClientMock } from "./wsNativeApi.test.helpers";

it("passes keep open, setup retries and open lifecycle fields through unchanged", async () => {
  const { createWsNativeApi } = await import("./wsNativeApi");
  const api = createWsNativeApi();
  rpcClientMock.terminal.keepOpen.mockResolvedValue(undefined);
  await expect(api.terminal.keepOpen!({ threadId: "t", terminalId: "a" })).resolves.toBe(undefined);
  expect(rpcClientMock.terminal.keepOpen).toHaveBeenCalledWith({ threadId: "t", terminalId: "a" });

  const retry = { threadId: "t", evict: { threadId: "old", terminalId: "b" } };
  rpcClientMock.terminal.retrySetup.mockResolvedValue({ status: "no-script" });
  await expect(api.terminal.retrySetup!(retry)).resolves.toEqual({ status: "no-script" });
  expect(rpcClientMock.terminal.retrySetup).toHaveBeenCalledWith(retry);

  const open = {
    threadId: "t",
    terminalId: "a",
    cwd: "/repo",
    attachOnly: true,
    evict: { threadId: "old", terminalId: "b" },
  };
  rpcClientMock.terminal.open.mockResolvedValue({});
  await api.terminal.open(open);
  expect(rpcClientMock.terminal.open).toHaveBeenCalledWith(open);
});
