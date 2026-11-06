import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retainRemoteMonitor, useRemoteMonitorStore } from "./remoteMonitor.store";
import { useRemoteAccessStore } from "../remoteAccess/remoteAccess.store";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("~/rpc/wsRpcClient", () => ({
  getWsRpcClient: () => ({ server: { sampleSshMonitor: rpc } }),
}));
const sample = (sequence: number) =>
  JSON.stringify({
    summaryStatus: "ready",
    sampledAtMs: Date.now(),
    sequence,
    cpuPercent: { value: 25, status: "ready" },
    memoryUsedBytes: { value: 2048, status: "ready" },
    disks: [],
    interfaces: [],
  });

beforeEach(() => {
  useRemoteAccessStore.setState({ disconnectedTargetsLoaded: true });
});

afterEach(() => {
  vi.useRealTimers();
  rpc.mockReset();
});

describe("SSH monitor shared ownership", () => {
  it("polls once for two surfaces and clears live data on a transient failure", async () => {
    vi.useFakeTimers();
    rpc.mockResolvedValueOnce(sample(1)).mockRejectedValueOnce(new Error("ssh offline"));
    const releaseA = retainRemoteMonitor("ssh:host=demo", "project-one");
    const releaseB = retainRemoteMonitor("ssh:host=demo", "project-two");
    await vi.waitFor(() =>
      expect(useRemoteMonitorStore.getState()["ssh:host=demo"]?.connection).toBe("connected"),
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    releaseA();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(useRemoteMonitorStore.getState()["ssh:host=demo"]).toMatchObject({
      connection: "unavailable",
      snapshot: null,
      reason: "ssh offline",
    });
    releaseB();
    expect(useRemoteMonitorStore.getState()["ssh:host=demo"]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("waits for the disconnect list before sampling", async () => {
    vi.useFakeTimers();
    useRemoteAccessStore.setState({ disconnectedTargetsLoaded: false });
    rpc.mockResolvedValue(sample(1));
    const release = retainRemoteMonitor("ssh:host=loading", "project-one");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rpc).not.toHaveBeenCalled();

    useRemoteAccessStore.getState().markDisconnectedTargetsLoaded();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rpc).toHaveBeenCalledTimes(1);
    release();
  });

  it("never samples a user-disconnected target and resumes after Connect", async () => {
    vi.useFakeTimers();
    const target = "ssh:host=paused";
    useRemoteAccessStore.getState().markExecutionTargetDisconnected(target);
    rpc.mockResolvedValue(sample(1));
    const release = retainRemoteMonitor(target, "project-one");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rpc).not.toHaveBeenCalled();
    expect(useRemoteMonitorStore.getState()[target]).toMatchObject({
      connection: "unavailable",
      reason: "Remote workspace is disconnected. Connect it to continue.",
    });
    const idleState = useRemoteMonitorStore.getState();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(useRemoteMonitorStore.getState()).toBe(idleState);

    useRemoteAccessStore.getState().clearExecutionTargetDisconnected(target);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rpc).toHaveBeenCalledTimes(1);
    release();
  });
});
