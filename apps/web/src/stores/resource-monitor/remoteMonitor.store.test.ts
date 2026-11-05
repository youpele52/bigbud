import { afterEach, describe, expect, it, vi } from "vitest";
import { retainRemoteMonitor, useRemoteMonitorStore } from "./remoteMonitor.store";

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
});
