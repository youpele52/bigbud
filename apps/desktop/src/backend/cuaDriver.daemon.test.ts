import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chmodSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  runCommand: vi.fn(async () => ({ code: 0 })),
  spawned: [] as Array<ReturnType<typeof makeChild>>,
  spawn: vi.fn(),
  stopMcpClient: vi.fn(),
}));

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    pid: number;
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 71 + mocks.spawned.length;
  child.kill = vi.fn(() => true);
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function emitExit(child: ReturnType<typeof makeChild>): void {
  child.exitCode = 0;
  child.emit("exit", 0, null);
}

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
  spawnSync: vi.fn(),
}));
vi.mock("node:fs", () => ({
  chmodSync: mocks.chmodSync,
  mkdirSync: mocks.mkdirSync,
  rmSync: mocks.rmSync,
}));
vi.mock("@bigbud/shared/cua-driver/childEnvironment", () => ({
  makeCuaDriverChildEnvironment: vi.fn(() => ({})),
}));
vi.mock("@bigbud/shared/cua-driver/invocation", () => ({
  cuaDriverEmbeddedEnvironment: vi.fn(() => ({ CUA_DRIVER_SOCKET: "/socket" })),
  cuaDriverServeArguments: vi.fn(() => ["serve"]),
}));
vi.mock("./cuaDriver", () => ({
  resolveComputerUseRuntime: vi.fn(() => ({ binaryPath: "/cua-driver" })),
}));
vi.mock("./cuaDriver.mcpClient", () => ({
  callCuaDriverTool: vi.fn(async () => ({
    structuredContent: { checks: [], overall: "ok" },
  })),
  stopCuaDriverMcpClientAndWait: vi.fn(async () => {
    mocks.stopMcpClient();
  }),
}));
vi.mock("./cuaDriver.paths", () => ({
  resolveManagedPaths: vi.fn(() => ({ rootDir: "/managed" })),
}));
vi.mock("./cuaDriver.process", () => ({
  runCommand: mocks.runCommand,
  stopCuaDriverCommandsAndWait: vi.fn(async () => undefined),
}));

async function loadStartedDaemon() {
  const daemon = await import("./cuaDriver.daemon");
  await daemon.startCuaDriverDaemon("/base", "host-id");
  return daemon;
}

describe("cua-driver daemon shutdown", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mocks.spawned.length = 0;
    mocks.spawn.mockReset().mockImplementation(() => {
      const child = makeChild();
      mocks.spawned.push(child);
      return child;
    });
    mocks.stopMcpClient.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for exit and coalesces concurrent and repeated stops", async () => {
    const daemon = await loadStartedDaemon();
    const child = mocks.spawned[0]!;

    const first = daemon.stopCuaDriverDaemonAndWait();
    const second = daemon.stopCuaDriverDaemonAndWait();

    expect(second).toBe(first);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(mocks.stopMcpClient).toHaveBeenCalledTimes(1);
    emitExit(child);
    await Promise.all([first, second]);
    await daemon.stopCuaDriverDaemonAndWait();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("cancels a scheduled restart", async () => {
    const daemon = await loadStartedDaemon();
    emitExit(mocks.spawned[0]!);

    await daemon.stopCuaDriverDaemonAndWait();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("blocks a scheduled restart as soon as update quiescence begins", async () => {
    const daemon = await loadStartedDaemon();
    emitExit(mocks.spawned[0]!);
    const { beginInstalledProcessQuiescence } = await import("./installedProcessQuiescence");

    beginInstalledProcessQuiescence();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    await daemon.stopCuaDriverDaemonAndWait();
  });

  it("propagates timeout and prevents a new daemon from overlapping the pending stop", async () => {
    const daemon = await loadStartedDaemon();
    const stopping = daemon.stopCuaDriverDaemonAndWait(1_000);
    const starting = daemon.startCuaDriverDaemon("/base", "host-id");
    const stopExpectation = expect(stopping).rejects.toThrow(
      "Could not confirm cua-driver process shutdown",
    );
    const startExpectation = expect(starting).rejects.toThrow(
      "Could not confirm cua-driver process shutdown",
    );

    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    await stopExpectation;
    await startExpectation;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("does not spawn a waiting start after update quiescence begins", async () => {
    const daemon = await loadStartedDaemon();
    const stopping = daemon.stopCuaDriverDaemonAndWait();
    const waitingStart = daemon.startCuaDriverDaemon("/base", "host-id");
    const { beginInstalledProcessQuiescence } = await import("./installedProcessQuiescence");

    beginInstalledProcessQuiescence();
    emitExit(mocks.spawned[0]!);
    await stopping;

    await expect(waitingStart).resolves.toEqual({});
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
});
