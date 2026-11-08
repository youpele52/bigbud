import { beforeEach, describe, expect, it, vi } from "vitest";

import { connectExecutionTargetForSetup } from "./remoteAccess.connect";
import { useRemoteAccessStore } from "./remoteAccess.store";

const target = "ssh:host=devbox&user=root&port=22&auth=ssh-key&transport=agent";

function connectApi(result: Promise<unknown>) {
  return { server: { connectExecutionTarget: vi.fn(() => result) } } as never as {
    server: { connectExecutionTarget: ReturnType<typeof vi.fn> };
  };
}

describe("connectExecutionTargetForSetup", () => {
  beforeEach(() => {
    useRemoteAccessStore.setState({ disconnectedExecutionTargetIds: {} });
  });

  it("does nothing for a target that is not disconnected", async () => {
    const api = connectApi(Promise.resolve({ executionTargetId: target, disconnected: false }));

    await expect(connectExecutionTargetForSetup(api as never, target)).resolves.toBe(false);
    expect(api.server.connectExecutionTarget).not.toHaveBeenCalled();
  });

  it("connects an orphaned disconnected target before verification", async () => {
    useRemoteAccessStore.getState().markExecutionTargetDisconnected(target);
    const api = connectApi(Promise.resolve({ executionTargetId: target, disconnected: false }));

    await expect(connectExecutionTargetForSetup(api as never, target)).resolves.toBe(true);
    expect(api.server.connectExecutionTarget).toHaveBeenCalledWith({ executionTargetId: target });
    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds[target]).toBeUndefined();
  });

  it("keeps the flag and surfaces the error when the server refuses", async () => {
    useRemoteAccessStore.getState().markExecutionTargetDisconnected(target);
    const api = connectApi(Promise.reject(new Error("Persistence failed.")));

    await expect(connectExecutionTargetForSetup(api as never, target)).rejects.toThrow(
      "Persistence failed.",
    );
    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds[target]).toBe(true);
  });
});
