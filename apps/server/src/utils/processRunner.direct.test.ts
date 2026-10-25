import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { runProcess } from "./processRunner";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
function child() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => false),
    pid: undefined,
  });
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("direct process deadlines", () => {
  it("settles independently of close/pipe drain and ignores late output", async () => {
    vi.useFakeTimers();
    const process = child();
    vi.mocked(spawn).mockReturnValue(process as never);
    const operation = runProcess("wsl.exe", ["--distribution", "x & y"], {
      shell: false,
      settleOnTimeout: true,
      timeoutMs: 100,
    });
    const assertion = expect(operation).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(process.kill).toHaveBeenCalled();
    expect(process.stdout.destroyed).toBe(true);
    process.emit("close", 0, null);
    process.stdout.emit("data", Buffer.from("late"));
    expect(spawn).toHaveBeenCalledWith(
      "wsl.exe",
      ["--distribution", "x & y"],
      expect.objectContaining({ shell: false }),
    );
  });
  it("cancels owned wrapper without waiting for guest completion", async () => {
    const process = child();
    vi.mocked(spawn).mockReturnValue(process as never);
    const controller = new AbortController();
    const operation = runProcess("wsl.exe", [], {
      shell: false,
      signal: controller.signal,
      settleOnTimeout: true,
    });
    const assertion = expect(operation).rejects.toThrow("cancelled");
    controller.abort();
    await assertion;
    expect(process.kill).toHaveBeenCalled();
    expect(process.stderr.destroyed).toBe(true);
  });
  it("rejects output overflow and never invokes distro lifecycle commands", async () => {
    const process = child();
    vi.mocked(spawn).mockReturnValue(process as never);
    const operation = runProcess("wsl.exe", ["--list", "--quiet"], {
      shell: false,
      settleOnTimeout: true,
      maxBufferBytes: 4,
    });
    const assertion = expect(operation).rejects.toThrow("buffer limit");
    process.stdout.write(Buffer.from("overflow"));
    await assertion;
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("does not spawn an already-cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runProcess("wsl.exe", [], { signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
