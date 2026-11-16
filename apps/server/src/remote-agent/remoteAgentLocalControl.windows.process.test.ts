import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), verify: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("./localWorkspaceWatchAgent.binary.ts", () => ({
  resolveLocalWorkspaceWatchAgentBinary: () => "owned-helper",
}));
vi.mock("./localNativeInspection.capability.ts", () => ({
  verifyNativeInspectionCapability: mocks.verify,
}));
import { WindowsControlProcess } from "./remoteAgentLocalControl.windows.process.ts";

function child() {
  const value = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      value.emit("close", 0);
      return true;
    }),
  });
  return value;
}
beforeEach(() => {
  vi.useFakeTimers();
  mocks.verify.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("drains output during shutdown and kills only its helper at the deadline", async () => {
  const native = child();
  mocks.spawn.mockReturnValue(native);
  const process = await WindowsControlProcess.open("server");
  const frames = vi.fn();
  process.listen(frames, vi.fn());
  const closing = process.close();
  native.stdout.write("R\t1\tignored\n");
  expect(frames).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1999);
  expect(native.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await closing;
  expect(native.kill).toHaveBeenCalledWith("SIGKILL");
});
it("rejects oversized unterminated output and keeps draining until exit", async () => {
  const native = child();
  mocks.spawn.mockReturnValue(native);
  const process = await WindowsControlProcess.open("client");
  const failed = vi.fn();
  process.listen(vi.fn(), failed);
  native.stdout.write(Buffer.alloc(200_000));
  expect(failed).toHaveBeenCalledTimes(1);
  native.stdout.write("still drained");
  await vi.advanceTimersByTimeAsync(2000);
  await process.close();
});
it("handles split/multiple frames and cancels the watchdog on graceful exit", async () => {
  const native = child();
  mocks.spawn.mockReturnValue(native);
  const process = await WindowsControlProcess.open("server");
  const frames: string[] = [];
  process.listen((line) => frames.push(line), vi.fn());
  native.stdout.write("REA");
  native.stdout.write("DY\t1\nC\t1\n");
  expect(frames).toEqual(["READY\t1", "C\t1"]);
  const closing = process.close();
  native.emit("close", 0);
  await closing;
  await vi.advanceTimersByTimeAsync(2000);
  expect(native.kill).not.toHaveBeenCalled();
});
it("refuses buffered input beyond the bound", async () => {
  const native = child();
  mocks.spawn.mockReturnValue(native);
  const process = await WindowsControlProcess.open("server");
  const failed = vi.fn();
  process.listen(vi.fn(), failed);
  expect(process.send("x".repeat(200_000))).toBe(false);
  expect(failed).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2000);
  await process.close();
});

it("does not settle shutdown on an error before confirmed process close", async () => {
  const native = child();
  mocks.spawn.mockReturnValue(native);
  const process = await WindowsControlProcess.open("server");
  process.listen(vi.fn(), vi.fn());
  let settled = false;
  const closing = process.close().then(() => {
    settled = true;
  });
  native.emit("error", new Error("kill failed"));
  await Promise.resolve();
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(2000);
  await closing;
  expect(native.kill).toHaveBeenCalledWith("SIGKILL");
});
