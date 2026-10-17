import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOwnedNodeExecutor } from "./lib/checkpoint-node-tests.process";
import { beginWindowsTreeCleanup } from "./lib/checkpoint-node-tests.windows";

const rootPid = Math.max(process.pid, process.ppid) + 10000;

function fakeChild(pid = rootPid) {
  const handle = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
  return {
    handle,
    child: handle as unknown as ChildProcess,
    close: (code: number | null, signal: NodeJS.Signals | null = null) => {
      handle.exitCode = code;
      handle.signalCode = signal;
      handle.emit("exit", code, signal);
      handle.emit("close", code, signal);
    },
  };
}

const options = { cwd: ".", timeoutMs: 100, maxBuffer: 512 };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
});

function windowsExecutor() {
  const root = fakeChild();
  const helper = fakeChild(rootPid + 1);
  const launch = vi.fn(() => root.child);
  const helperLaunch = vi.fn(() => helper.child);
  const cleanup = vi.fn((...args: Parameters<typeof beginWindowsTreeCleanup>) =>
    beginWindowsTreeCleanup(args[0], args[1], args[2], helperLaunch as unknown as typeof spawn),
  );
  const execute = createOwnedNodeExecutor("win32", {
    launch: launch as unknown as typeof spawn,
    windowsCleanup: cleanup,
  });
  return { root, helper, launch, helperLaunch, cleanup, execute };
}

it("requests Node on Windows and joins both the owned tree and taskkill before returning (mocked spawn)", async () => {
  const state = windowsExecutor();
  const outcome = state
    .execute(["--test", "fixture.test.mjs"], options)
    .catch((error: Error & { code: string }) => error);
  state.root.handle.emit("spawn");
  expect(state.launch).toHaveBeenCalledWith("node", ["--test", "fixture.test.mjs"], {
    cwd: ".",
    detached: false,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(state.helperLaunch).toHaveBeenCalledWith(
    "taskkill",
    ["/PID", String(rootPid), "/T", "/F"],
    {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  expect(state.cleanup.mock.calls[0]?.[2]).toBe(5100);
  let returned = false;
  void outcome.then(() => {
    returned = true;
  });
  state.root.close(null, "SIGKILL");
  await Promise.resolve();
  expect(returned).toBe(false);
  state.helper.close(0);
  expect(await outcome).toMatchObject({ code: "NODE_TIMEOUT" });
  expect(state.helper.handle.kill).not.toHaveBeenCalled();
  const next = fakeChild(rootPid + 2);
  state.launch.mockReturnValueOnce(next.child);
  const retry = state.execute(["--version"], options);
  next.handle.emit("spawn");
  next.close(0);
  await expect(retry).resolves.toEqual({ stdout: "", stderr: "" });
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["nonzero", "error", "timeout", "signal"] as const)(
  "keeps helper %s failure unknown and refuses retry",
  async (kind) => {
    const state = windowsExecutor();
    const outcome = state
      .execute(["--test", "fixture.test.mjs"], options)
      .catch((error: Error & { code: string }) => error);
    state.root.handle.emit("spawn");
    await vi.advanceTimersByTimeAsync(100);
    if (kind === "nonzero") state.helper.close(1);
    if (kind === "error")
      state.helper.handle.emit("error", new Error("synthetic helper launch failure"));
    if (kind === "signal") state.helper.close(null, "SIGKILL");
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(5000);
    expect(await outcome).toMatchObject({ code: "NODE_TREE_CLEANUP_UNKNOWN" });
    await expect(state.execute(["--version"], options)).rejects.toMatchObject({
      code: "NODE_TREE_CLEANUP_UNKNOWN",
    });
    state.root.close(0);
    state.helper.close(0);
    await expect(state.execute(["--version"], options)).rejects.toMatchObject({
      code: "NODE_TREE_CLEANUP_UNKNOWN",
    });
    expect(state.launch).toHaveBeenCalledTimes(1);
    expect(state.helperLaunch).toHaveBeenCalledTimes(1);
    expect(state.helper.handle.kill.mock.calls.length).toBeLessThanOrEqual(1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("keeps a confirmed taskkill but unjoined harness unknown at the original deadline", async () => {
  const state = windowsExecutor();
  const outcome = state
    .execute(["--test"], options)
    .catch((error: Error & { code: string }) => error);
  state.root.handle.emit("spawn");
  await vi.advanceTimersByTimeAsync(100);
  state.helper.close(0);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await outcome).toMatchObject({ code: "NODE_TREE_CLEANUP_UNKNOWN" });
  await expect(state.execute(["--version"], options)).rejects.toMatchObject({
    code: "NODE_TREE_CLEANUP_UNKNOWN",
  });
  state.root.close(0);
  expect(state.helper.handle.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels overflow immediately and never resets the original join deadline", async () => {
  const state = windowsExecutor();
  const outcome = state
    .execute(["--test"], { ...options, timeoutMs: 10000 })
    .catch((error: Error & { code: string }) => error);
  state.root.handle.emit("spawn");
  await vi.advanceTimersByTimeAsync(20);
  state.root.handle.stdout.write("x".repeat(1024));
  expect(state.helperLaunch).toHaveBeenCalledTimes(1);
  expect(state.cleanup.mock.calls[0]?.[2]).toBe(5020);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await outcome).toMatchObject({ code: "NODE_TREE_CLEANUP_UNKNOWN" });
  expect(state.helper.handle.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  state.root.close(0);
  state.helper.close(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("never launches taskkill after the tracked root exits before cancellation", async () => {
  const state = windowsExecutor();
  const outcome = state
    .execute(["--test"], options)
    .catch((error: Error & { code: string }) => error);
  state.root.handle.emit("spawn");
  state.root.handle.exitCode = 0;
  state.root.handle.emit("exit", 0, null);
  await vi.advanceTimersByTimeAsync(100);
  expect(await outcome).toMatchObject({ code: "NODE_TREE_CLEANUP_UNKNOWN" });
  expect(state.helperLaunch).not.toHaveBeenCalled();
  await expect(state.execute(["--version"], options)).rejects.toMatchObject({
    code: "NODE_TREE_CLEANUP_UNKNOWN",
  });
  state.root.close(0);
});

it.each([0, 1, -5, Number.NaN, Number.MAX_SAFE_INTEGER, process.pid, process.ppid])(
  "rejects unsafe root PID %s before action",
  async (pid) => {
    const root = fakeChild(pid);
    const launch = vi.fn();
    const cleanup = beginWindowsTreeCleanup(
      root.child,
      () => true,
      5000,
      launch as unknown as typeof spawn,
    );
    await expect(cleanup.result).resolves.toBe(false);
    expect(launch).not.toHaveBeenCalled();
  },
);

it("rechecks retained identity and remaining deadline at the taskkill action boundary", async () => {
  const root = fakeChild();
  const launch = vi.fn();
  await expect(
    beginWindowsTreeCleanup(root.child, () => false, 5000, launch as unknown as typeof spawn)
      .result,
  ).resolves.toBe(false);
  await expect(
    beginWindowsTreeCleanup(root.child, () => true, 0, launch as unknown as typeof spawn).result,
  ).resolves.toBe(false);
  for (const deadline of [Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(
      beginWindowsTreeCleanup(root.child, () => true, deadline, launch as unknown as typeof spawn)
        .result,
    ).resolves.toBe(false);
  }
  root.handle.exitCode = 0;
  await expect(
    beginWindowsTreeCleanup(root.child, () => true, 5000, launch as unknown as typeof spawn).result,
  ).resolves.toBe(false);
  expect(launch).not.toHaveBeenCalled();
});
