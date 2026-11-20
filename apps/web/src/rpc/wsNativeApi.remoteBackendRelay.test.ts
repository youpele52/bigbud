import { expect, it } from "vitest";
import { rpcClientMock } from "./wsNativeApi.test.helpers";

it("reports the actual unavailable profile state without constructing a remote client", async () => {
  rpcClientMock.server.listRemoteBackendRelayProfiles.mockResolvedValue({
    availability: "setup-required",
    profiles: [],
  });
  const { createWsNativeApi } = await import("./wsNativeApi");
  expect(await createWsNativeApi().server.listRemoteBackendRelayProfiles()).toEqual({
    availability: "setup-required",
    profiles: [],
  });
  expect(rpcClientMock.server.openRemoteBackendRelay).not.toHaveBeenCalled();
});
it("a lost open reply can be canceled with the caller-known nonce before any lease ID exists", async () => {
  const requestId = "12345678-1234-4123-8123-123456789abc";
  rpcClientMock.server.openRemoteBackendRelay.mockRejectedValue(new Error("reply lost"));
  rpcClientMock.server.closeRemoteBackendRelay.mockResolvedValue({ closed: true });
  const { createWsNativeApi } = await import("./wsNativeApi");
  const api = createWsNativeApi();
  await expect(
    api.server.openRemoteBackendRelay({ profileId: "saved-profile", requestId }),
  ).rejects.toThrow("reply lost");
  expect(await api.server.closeRemoteBackendRelay({ requestId })).toEqual({ closed: true });
  expect(rpcClientMock.server.openRemoteBackendRelay).toHaveBeenCalledWith({
    profileId: "saved-profile",
    requestId,
  });
  expect(rpcClientMock.server.closeRemoteBackendRelay).toHaveBeenCalledWith({ requestId });
  expect(rpcClientMock.server.installRemoteAgent).not.toHaveBeenCalled();
});
