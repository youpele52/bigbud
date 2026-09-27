import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  statSync: vi.fn(() => ({ isFile: () => true, mode: 0o755 })),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ statSync: mocks.statSync }));
vi.mock("../env/pathResolver", () => ({
  resolvePackagedDesktopSupervisorBinary: () => "/packaged/supervisor",
}));
import { SystemMonitorBridge } from "./bridge";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: { writable: boolean; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    exitCode: number | null;
  };
  child.stdout = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  child.stdin = {
    writable: true,
    write: vi.fn((bytes: Uint8Array) => {
      if (bytes[4] === 10) {
        queueMicrotask(() =>
          child.stdout.emit(
            "data",
            Buffer.from([0, 0, 0, 12, 18, 10, 8, 1, 24, 128, 128, 8, 32, 2, 40, 1]),
          ),
        );
      } else if (bytes[4] === 82) {
        queueMicrotask(() =>
          child.stdout.emit("data", Buffer.from([0, 0, 0, 6, 114, 4, 8, bytes[7]!, 16, 2])),
        );
      } else if (bytes[4] === 26) {
        queueMicrotask(() =>
          child.stdout.emit("data", Buffer.from([0, 0, 0, 6, 106, 4, 8, bytes[7]!, 16, 1])),
        );
      }
      return true;
    }),
    end: vi.fn(),
  };
  return child;
}

describe("SystemMonitorBridge", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.BIGBUD_SYSTEM_MONITOR_BINARY;
    delete process.env.BIGBUD_SYSTEM_MONITOR_ENABLED;
    mocks.spawn.mockReset();
    mocks.statSync.mockClear();
  });
  it("uses only an explicit development binary and reports unavailable when absent", async () => {
    const bridge = new SystemMonitorBridge(false);
    await expect(bridge.retry()).rejects.toThrow("binary unavailable");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("launches the packaged supervisor artifact path", async () => {
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const bridge = new SystemMonitorBridge(true);
    await expect(bridge.retry()).resolves.toBe(true);
    expect(mocks.spawn).toHaveBeenCalledWith(
      "/packaged/supervisor",
      ["--system-monitor"],
      expect.any(Object),
    );
    bridge.stop();
  });
  it("handshakes in the dedicated mode and tears down on process exit", async () => {
    process.env.BIGBUD_SYSTEM_MONITOR_BINARY = "/dev/supervisor";
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const bridge = new SystemMonitorBridge(false);
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn() };
    bridge.addRenderer(sender as never);
    await expect(bridge.retry()).resolves.toBe(true);
    expect(mocks.spawn).toHaveBeenCalledWith(
      "/dev/supervisor",
      ["--system-monitor"],
      expect.any(Object),
    );
    child.emit("exit", 1);
    expect(sender.send).toHaveBeenCalledWith("desktop:system-monitor-event", {
      type: "unavailable",
      reason: "monitor process exited",
    });
    bridge.stop();
  });
  it("honors the disabled switch before spawning", async () => {
    process.env.BIGBUD_SYSTEM_MONITOR_BINARY = "/dev/supervisor";
    process.env.BIGBUD_SYSTEM_MONITOR_ENABLED = "0";
    await expect(new SystemMonitorBridge(false).retry()).rejects.toThrow("disabled");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("retries collection in the same child, then reconnects after transport exit", async () => {
    process.env.BIGBUD_SYSTEM_MONITOR_BINARY = "/dev/supervisor";
    const first = fakeChild();
    const second = fakeChild();
    mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const bridge = new SystemMonitorBridge(false);
    await expect(bridge.retry()).resolves.toBe(true);
    await expect(bridge.retry()).resolves.toBe(true);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(first.kill).not.toHaveBeenCalled();
    expect(first.stdin.write).toHaveBeenCalledWith(expect.objectContaining({ 4: 82 }));
    first.emit("exit", 1);
    await expect(bridge.retry()).resolves.toBe(true);
    first.emit("exit", 0);
    first.stdout.emit("data", Buffer.from([0, 0, 0, 255]));
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(second.kill).not.toHaveBeenCalled();
    bridge.stop();
  });
  it("times out an unacknowledged collection Retry without replacing a healthy child", async () => {
    vi.useFakeTimers();
    process.env.BIGBUD_SYSTEM_MONITOR_BINARY = "/dev/supervisor";
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const bridge = new SystemMonitorBridge(false);
    await bridge.retry();
    child.stdin.write.mockImplementation(() => true);
    const retry = expect(bridge.retry()).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(3_000);
    await retry;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    bridge.stop();
  });
  it("retains the subscription and forwards Rust collection status across Retry", async () => {
    process.env.BIGBUD_SYSTEM_MONITOR_BINARY = "/dev/supervisor";
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const bridge = new SystemMonitorBridge(false);
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn() };
    bridge.addRenderer(sender as never);
    const demand = { processes: false, disks: true, sensors: false };
    expect(await bridge.subscribe(demand)).toBe(1);
    child.stdout.emit(
      "data",
      Buffer.from([0, 0, 0, 16, 122, 14, 8, 2, 16, 1, 24, 232, 7, 34, 3, 99, 112, 117, 40, 1]),
    );
    await expect(bridge.retry()).resolves.toBe(true);
    bridge.update(1, demand);
    expect(sender.send).toHaveBeenCalledWith(
      "desktop:system-monitor-event",
      expect.objectContaining({
        type: "collectionStatus",
        status: expect.objectContaining({ state: "retrying" }),
      }),
    );
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(child.stdin.write).toHaveBeenCalledWith(expect.objectContaining({ 4: 34 }));
    bridge.stop();
  });
  it("rejects a missing handshake at the three-second deadline", async () => {
    vi.useFakeTimers();
    process.env.BIGBUD_SYSTEM_MONITOR_BINARY = "/dev/supervisor";
    const child = fakeChild();
    child.stdin.write.mockImplementation(() => true);
    mocks.spawn.mockReturnValue(child);
    const bridge = new SystemMonitorBridge(false);
    const result = bridge.retry();
    const rejection = expect(result).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(3_000);
    await rejection;
    expect(child.kill).toHaveBeenCalled();
    bridge.stop();
  });
  it("bounds concurrent process queries to two", async () => {
    process.env.BIGBUD_SYSTEM_MONITOR_BINARY = "/dev/supervisor";
    const child = fakeChild();
    mocks.spawn.mockReturnValue(child);
    const bridge = new SystemMonitorBridge(false);
    await bridge.retry();
    const query = { sort: "cpu" as const, descending: true, limit: 10 };
    const first = bridge.query(query).catch(() => undefined);
    const second = bridge.query(query).catch(() => undefined);
    await expect(bridge.query(query)).rejects.toThrow("busy");
    bridge.stop();
    await Promise.all([first, second]);
  });
});
