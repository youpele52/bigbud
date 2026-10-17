import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reconnect: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("./wsRpcClient", () => ({ getWsRpcClient: () => ({ reconnect: mocks.reconnect }) }));

import { beginServerConfigReadiness, registerServerConfigRetry } from "./serverConfigReadiness";
import { resetServerStateForTests } from "./serverState";
import { reconnectServerConfig } from "./serverConfigRecovery";

afterEach(() => {
  mocks.reconnect.mockReset();
  mocks.reconnect.mockResolvedValue(undefined);
  resetServerStateForTests();
});

describe("explicit physical config recovery", () => {
  it("coalesces reconnect actions and restarts a stopped logical config owner once", async () => {
    const retry = vi.fn();
    const stop = registerServerConfigRetry(beginServerConfigReadiness(false), retry, () => true);
    await Promise.all([reconnectServerConfig(), reconnectServerConfig()]);
    expect(mocks.reconnect).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
    stop();
  });

  it("does not create a competing config owner when the existing subscription resumes itself", async () => {
    const retry = vi.fn();
    const stop = registerServerConfigRetry(beginServerConfigReadiness(true), retry, () => false);
    await reconnectServerConfig();
    expect(retry).not.toHaveBeenCalled();
    stop();
  });

  it("classifies failure without exposing credentials or restarting stopped config", async () => {
    const retry = vi.fn();
    const stop = registerServerConfigRetry(beginServerConfigReadiness(false), retry);
    mocks.reconnect.mockRejectedValueOnce(new Error("token=private-value /private/provider/path"));
    await expect(reconnectServerConfig()).rejects.toThrow(
      "Unable to reconnect to the bigbud server.",
    );
    expect(retry).not.toHaveBeenCalled();
    stop();
  });
});
