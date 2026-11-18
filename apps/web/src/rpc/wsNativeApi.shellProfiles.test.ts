import { expect, it } from "vitest";
import { rpcClientMock } from "./wsNativeApi.test.helpers";

it("reads the selected pane's inventory without open/restart or older-server fallback", async () => {
  const { createWsNativeApi } = await import("./wsNativeApi");
  const api = createWsNativeApi();
  const input = { threadId: "thread", terminalId: "pane" };
  const inventory = { host: { kind: "ssh", hostId: "remote" }, profiles: [] } as const;
  rpcClientMock.terminal.shellProfiles.mockResolvedValue(inventory);
  await expect(api.terminal.shellProfiles!(input)).resolves.toEqual(inventory);
  expect(rpcClientMock.terminal.shellProfiles).toHaveBeenCalledExactlyOnceWith(input);
  rpcClientMock.terminal.shellProfiles.mockRejectedValue(new Error("unsupported method"));
  await expect(api.terminal.shellProfiles!(input)).rejects.toThrow("unsupported method");
  expect(rpcClientMock.terminal.open).not.toHaveBeenCalled();
  expect(rpcClientMock.terminal.restart).not.toHaveBeenCalled();
  expect(rpcClientMock.terminal.wslDistributions).not.toHaveBeenCalled();
});
