import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { killProcessTree } from "./backendProcess";
import { stopChildProcessTreeAndWait } from "./backendShutdown";
import {
  beginInstalledProcessQuiescence,
  getInstalledProcessTreeUncertainty,
} from "./installedProcessQuiescence";

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: mocks.spawnSync,
}));

const originalPlatform = process.platform;

function makeChild(pid = 42) {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  child.exitCode = null;
  child.signalCode = null;
  child.pid = pid;
  child.kill = vi.fn(() => true);
  return child;
}

function emitExit(child: ReturnType<typeof makeChild>): void {
  child.exitCode = 0;
  child.emit("exit", 0, null);
}

describe("stopChildProcessTreeAndWait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns immediately when the child already exited", async () => {
    const child = makeChild();
    child.exitCode = 0;

    await stopChildProcessTreeAndWait(child as never, new WeakSet(), 5_000);

    expect(child.kill).not.toHaveBeenCalled();
  });

  it("waits for a graceful child exit", async () => {
    const child = makeChild();
    child.kill.mockImplementation(() => {
      emitExit(child);
      return true;
    });

    await stopChildProcessTreeAndWait(child as never, new WeakSet(), 5_000);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("escalates to SIGKILL and waits for the resulting exit", async () => {
    const child = makeChild();
    child.kill.mockImplementation((signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") emitExit(child);
      return true;
    });

    const stopped = stopChildProcessTreeAndWait(child as never, new WeakSet(), 5_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await stopped;

    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });

  it("rejects when exit cannot be confirmed before the timeout", async () => {
    const child = makeChild();

    const expectation = expect(
      stopChildProcessTreeAndWait(child as never, new WeakSet(), 5_000),
    ).rejects.toThrow("did not exit within 5000ms");
    await vi.advanceTimersByTimeAsync(5_000);
    await expectation;
  });
});

describe("killProcessTree on Windows", () => {
  beforeEach(() => {
    mocks.spawnSync.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    vi.restoreAllMocks();
  });

  it("uses taskkill /T /F and falls back when taskkill returns nonzero", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    const taskkill = mocks.spawnSync.mockReturnValue({
      pid: 7,
      output: [],
      stdout: null,
      stderr: null,
      status: 1,
      signal: null,
    });
    const child = makeChild(123);

    killProcessTree(child as never, "SIGTERM");

    expect(taskkill).toHaveBeenCalledWith("taskkill", ["/pid", "123", "/T", "/F"], {
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("keeps taskkill uncertainty after timeout, late root exit, and retry", async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    mocks.spawnSync.mockReturnValue({
      error: Object.assign(new Error("taskkill timed out"), { code: "ETIMEDOUT" }),
      pid: 7,
      output: [],
      stdout: null,
      stderr: null,
      status: null,
      signal: null,
    });
    const child = makeChild(123);

    beginInstalledProcessQuiescence();
    const expectation = expect(
      stopChildProcessTreeAndWait(child as never, new WeakSet(), 5_000),
    ).rejects.toThrow("did not exit within 5000ms");
    expect(getInstalledProcessTreeUncertainty()?.message).toContain("unsafe until bigbud restarts");
    await vi.advanceTimersByTimeAsync(5_000);
    await expectation;

    emitExit(child);
    await expect(
      stopChildProcessTreeAndWait(child as never, new WeakSet(), 5_000),
    ).resolves.toBeUndefined();
    expect(getInstalledProcessTreeUncertainty()?.message).toContain("unsafe until bigbud restarts");
  });

  it("falls back to root cleanup when taskkill reports a command error", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    mocks.spawnSync.mockReturnValue({
      error: new Error("taskkill unavailable"),
      pid: 7,
      output: [],
      stdout: null,
      stderr: null,
      status: null,
      signal: null,
    });
    const child = makeChild(123);

    expect(killProcessTree(child as never).treeTerminationConfirmed).toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
