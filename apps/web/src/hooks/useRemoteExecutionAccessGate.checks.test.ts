import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRemoteAccessStore } from "../stores/remoteAccess/remoteAccess.store";
import { startRemoteExecutionCheck } from "./useRemoteExecutionAccessGate.checks";

vi.mock("../components/ui/toast", () => ({
  toastManager: { add: vi.fn(), close: vi.fn(), update: vi.fn() },
}));

const target = "ssh:host=devbox&user=root&port=22&auth=ssh-key";

describe("startRemoteExecutionCheck", () => {
  beforeEach(() => {
    useRemoteAccessStore.setState({
      verifiedExecutionTargetIds: {},
      disconnectedExecutionTargetIds: {},
      executionTargetChecks: {},
    });
  });

  it("marks the target verified when the check succeeds", async () => {
    await startRemoteExecutionCheck({ executionTargetId: target, verify: async () => {} }).promise;

    expect(useRemoteAccessStore.getState().verifiedExecutionTargetIds[target]).toBe(true);
  });

  it("does not re-mark verified when the user disconnected while the check ran", async () => {
    await startRemoteExecutionCheck({
      executionTargetId: target,
      verify: async () => {
        useRemoteAccessStore.getState().markExecutionTargetDisconnected(target);
      },
    }).promise;

    const state = useRemoteAccessStore.getState();
    expect(state.verifiedExecutionTargetIds[target]).toBeUndefined();
    expect(state.executionTargetChecks[target]).toMatchObject({
      status: "error",
      message: "Remote workspace is disconnected. Connect it to continue.",
    });
  });
});
