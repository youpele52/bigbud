import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRemoteAccessStore } from "../stores/remoteAccess/remoteAccess.store";
import { refreshDisconnectedExecutionTargets } from "./useDisconnectedExecutionTargetsSync";

const first = "ssh:host=devbox&user=root&port=22&auth=ssh-key";
const second = "ssh:host=build&user=ci&port=22&auth=password";

function apiReturning(result: Promise<{ executionTargetIds: readonly string[] }>) {
  return { server: { listDisconnectedExecutionTargets: vi.fn(() => result) } };
}

describe("refreshDisconnectedExecutionTargets", () => {
  beforeEach(() => {
    useRemoteAccessStore.setState({
      disconnectedExecutionTargetIds: { [first]: true },
      disconnectedTargetsLoaded: false,
    });
  });

  it("replaces local flags with the server's persisted set", async () => {
    await expect(
      refreshDisconnectedExecutionTargets(
        apiReturning(Promise.resolve({ executionTargetIds: [second] })),
      ),
    ).resolves.toBe(true);

    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds).toEqual({
      [second]: true,
    });
  });

  it("logs and ignores load failures so startup continues", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      refreshDisconnectedExecutionTargets(apiReturning(Promise.reject(new Error("offline")))),
    ).resolves.toBe(false);

    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds).toEqual({
      [first]: true,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(useRemoteAccessStore.getState().disconnectedTargetsLoaded).toBe(true);
    warn.mockRestore();
  });

  it("applies the server list but keeps targets changed locally while it loads", async () => {
    const third = "ssh:host=docs&user=root&port=22&auth=ssh-key";
    let resolve!: (value: { executionTargetIds: readonly string[] }) => void;
    const pending = refreshDisconnectedExecutionTargets(
      apiReturning(new Promise((settle) => (resolve = settle))),
    );
    useRemoteAccessStore.getState().clearExecutionTargetDisconnected(first);
    useRemoteAccessStore.getState().markExecutionTargetDisconnected(third);
    resolve({ executionTargetIds: [first, second] });

    await expect(pending).resolves.toBe(true);
    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds).toEqual({
      [second]: true,
      [third]: true,
    });
    expect(useRemoteAccessStore.getState().disconnectedTargetsLoaded).toBe(true);
  });

  it("ignores a response that arrives after the connection changed", async () => {
    await expect(
      refreshDisconnectedExecutionTargets(
        apiReturning(Promise.resolve({ executionTargetIds: [second] })),
        () => true,
      ),
    ).resolves.toBe(false);
    expect(useRemoteAccessStore.getState().disconnectedExecutionTargetIds).toEqual({
      [first]: true,
    });
    expect(useRemoteAccessStore.getState().disconnectedTargetsLoaded).toBe(false);
  });

  it("marks the list loaded when the host cannot list disconnects", async () => {
    await expect(refreshDisconnectedExecutionTargets({ server: {} } as never)).resolves.toBe(false);
    expect(useRemoteAccessStore.getState().disconnectedTargetsLoaded).toBe(true);
  });
});
