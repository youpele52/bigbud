import { expect, it } from "vitest";

import { rpcClientMock } from "./wsNativeApi.test.helpers";

it("forwards warning delivery without creating or retrying generation", async () => {
  rpcClientMock.server.claimMetadataWarnings.mockResolvedValue([]);
  rpcClientMock.server.acknowledgeMetadataWarning.mockResolvedValue(true);
  const { createWsNativeApi } = await import("./wsNativeApi");
  const api = createWsNativeApi();
  await expect(api.server.claimMetadataWarnings({ clientId: "renderer" })).resolves.toEqual([]);
  await expect(
    api.server.acknowledgeMetadataWarning({ clientId: "renderer", warningId: "warning" }),
  ).resolves.toBe(true);
  expect(rpcClientMock.server.claimMetadataWarnings).toHaveBeenCalledExactlyOnceWith({
    clientId: "renderer",
  });
  expect(rpcClientMock.server.acknowledgeMetadataWarning).toHaveBeenCalledExactlyOnceWith({
    clientId: "renderer",
    warningId: "warning",
  });
  expect(rpcClientMock.server.retryTextGeneration).not.toHaveBeenCalled();
  expect(rpcClientMock.orchestration.dispatchCommand).not.toHaveBeenCalled();
});
