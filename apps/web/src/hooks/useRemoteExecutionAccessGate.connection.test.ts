import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRemoteAccessStore } from "../stores/remoteAccess/remoteAccess.store";
import {
  blockDisconnectedRemoteExecutionTarget,
  connectRemoteExecutionTarget,
  disconnectRemoteExecutionTarget,
} from "./useRemoteExecutionAccessGate.connection";

const api = vi.hoisted(() => ({
  server: {
    disconnectExecutionTarget: vi.fn(),
    connectExecutionTarget: vi.fn(),
  },
}));
const toast = vi.hoisted(() => ({ add: vi.fn(), close: vi.fn(), update: vi.fn() }));
vi.mock("../rpc/nativeApi", () => ({ readNativeApi: () => api }));
vi.mock("../components/ui/toast", () => ({ toastManager: toast }));

const target = "ssh:host=devbox&user=root&port=22&auth=ssh-key";

function lastToast() {
  return toast.add.mock.calls.at(-1)?.[0];
}

describe("remote execution target connection actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    toast.add.mockReturnValue("toast-id");
    useRemoteAccessStore.setState({
      verifiedExecutionTargetIds: {},
      disconnectedExecutionTargetIds: {},
      executionTargetChecks: {},
    });
  });

  it("disconnects, flags the target and drops its verified state", async () => {
    useRemoteAccessStore.getState().markExecutionTargetVerified(target);
    api.server.disconnectExecutionTarget.mockResolvedValue({
      executionTargetId: target,
      disconnected: true,
    });

    await expect(
      disconnectRemoteExecutionTarget({ executionTargetId: target, name: "App" }),
    ).resolves.toBe(true);

    expect(api.server.disconnectExecutionTarget).toHaveBeenCalledWith({
      executionTargetId: target,
    });
    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds[target]).toBe(true);
    expect(useRemoteAccessStore.getState().verifiedExecutionTargetIds[target]).toBeUndefined();
    expect(toast.add.mock.calls[0]?.[0]).toMatchObject({ type: "loading" });
    expect(lastToast()).toMatchObject({ type: "success", title: 'Disconnected "App"' });
  });

  it("leaves local state untouched and reports a red failure when disconnect fails", async () => {
    useRemoteAccessStore.getState().markExecutionTargetVerified(target);
    api.server.disconnectExecutionTarget.mockRejectedValue(new Error("Persistence failed."));

    await expect(
      disconnectRemoteExecutionTarget({ executionTargetId: target, name: "App" }),
    ).resolves.toBe(false);

    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds[target]).toBeUndefined();
    expect(useRemoteAccessStore.getState().verifiedExecutionTargetIds[target]).toBe(true);
    expect(lastToast()).toMatchObject({ type: "error", description: "Persistence failed." });
  });

  it("connects by clearing the flag only after the server accepts", async () => {
    useRemoteAccessStore.getState().markExecutionTargetDisconnected(target);
    useRemoteAccessStore.getState().markExecutionTargetVerified(target);
    api.server.connectExecutionTarget.mockRejectedValueOnce(new Error("Server unavailable."));

    await expect(connectRemoteExecutionTarget({ executionTargetId: target })).resolves.toBe(false);
    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds[target]).toBe(true);
    expect(lastToast()).toMatchObject({ type: "error" });

    api.server.connectExecutionTarget.mockResolvedValueOnce({
      executionTargetId: target,
      disconnected: false,
    });
    await expect(connectRemoteExecutionTarget({ executionTargetId: target })).resolves.toBe(true);
    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds[target]).toBeUndefined();
    expect(useRemoteAccessStore.getState().verifiedExecutionTargetIds[target]).toBeUndefined();
  });

  it("does not block a connected target", () => {
    const onConnected = vi.fn();

    expect(blockDisconnectedRemoteExecutionTarget({ executionTargetId: target, onConnected })).toBe(
      false,
    );
    expect(toast.add).not.toHaveBeenCalled();
  });

  it("blocks a disconnected target with a Connect action that resumes the original action", async () => {
    useRemoteAccessStore.getState().markExecutionTargetDisconnected(target);
    api.server.connectExecutionTarget.mockResolvedValue({
      executionTargetId: target,
      disconnected: false,
    });
    const onConnected = vi.fn();

    expect(blockDisconnectedRemoteExecutionTarget({ executionTargetId: target, onConnected })).toBe(
      true,
    );
    const blocked = lastToast();
    expect(blocked).toMatchObject({
      type: "warning",
      title: "root@devbox is disconnected",
      actionProps: { children: "Connect" },
    });
    expect(onConnected).not.toHaveBeenCalled();

    blocked.actionProps.onClick();
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledOnce());
    expect(api.server.connectExecutionTarget).toHaveBeenCalledWith({ executionTargetId: target });
    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds[target]).toBeUndefined();
  });
});
