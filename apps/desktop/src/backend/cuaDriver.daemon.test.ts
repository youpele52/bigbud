import { EventEmitter } from "node:events";
import * as Path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chmodSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  runCommand: vi.fn(async () => ({ code: 0 })),
  makeChildEnvironment: vi.fn((..._args: unknown[]) => ({})),
  resolvePrivateStateHome: vi.fn((_baseDir: string) => "/managed/home"),
  serveArguments: vi.fn(() => ["serve"]),
  resolveRuntime: vi.fn(() => ({ binaryPath: "/cua-driver", version: null as string | null })),
  spawned: [] as Array<ReturnType<typeof makeChild>>,
  spawn: vi.fn(),
  stopMcpClient: vi.fn(),
  removeStaleSocket: vi.fn((): "absent" | "removed" | "blocked" => "absent"),
  prepareCursorTheme: vi.fn((_stateHome: string, _version: string | null): string | null => null),
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
vi.mock("@bigbud/shared/cua-driver/childEnvironment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bigbud/shared/cua-driver/childEnvironment")>()),
  makeCuaDriverChildEnvironment: mocks.makeChildEnvironment,
}));
vi.mock("@bigbud/shared/cua-driver/invocation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bigbud/shared/cua-driver/invocation")>()),
  cuaDriverEmbeddedEnvironment: vi.fn(() => ({ CUA_DRIVER_SOCKET: "/socket" })),
  cuaDriverServeArguments: mocks.serveArguments,
}));
vi.mock("./cuaDriver.cursorTheme", () => ({
  prepareCuaCursorTheme: mocks.prepareCursorTheme,
}));
vi.mock("./cuaDriver.runtime", () => ({
  resolveComputerUseRuntime: mocks.resolveRuntime,
}));
vi.mock("./cuaDriver.compatibility", () => ({
  inspectCuaDriverCompatibility: vi.fn(async () => ({
    version: mocks.resolveRuntime().version,
    honoursPidFile: mocks.resolveRuntime().version === "0.38.0",
  })),
}));
vi.mock("./cuaDriver.mcpClient", () => ({
  callCuaDriverTool: vi.fn(async (_path: string, tool: string) => {
    if (tool === "kill_app")
      throw new Error("Permission denied: tool 'kill_app' is explicitly denied");
    return { structuredContent: { checks: [], overall: "ok" } };
  }),
  stopCuaDriverMcpClientAndWait: vi.fn(async () => {
    mocks.stopMcpClient();
  }),
}));
vi.mock("./cuaDriver.daemon.endpoint", () => ({
  removeStaleDaemonSocket: mocks.removeStaleSocket,
}));
vi.mock("./cuaDriver.paths", () => ({
  resolveManagedPaths: vi.fn(() => ({ rootDir: "/managed", homeDir: "/managed/home" })),
  resolvePrivateStateHome: mocks.resolvePrivateStateHome,
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
    mocks.removeStaleSocket.mockReset().mockReturnValue("absent");
    mocks.makeChildEnvironment.mockClear();
    mocks.serveArguments.mockClear();
    mocks.rmSync.mockClear();
    mocks.prepareCursorTheme.mockReset().mockReturnValue(null);
    mocks.resolveRuntime.mockReset().mockReturnValue({ binaryPath: "/cua-driver", version: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not spawn an incompatible runtime", async () => {
    const { inspectCuaDriverCompatibility } = await import("./cuaDriver.compatibility");
    vi.mocked(inspectCuaDriverCompatibility).mockRejectedValueOnce(
      new Error("unsupported manifest"),
    );
    const daemon = await import("./cuaDriver.daemon");
    await expect(daemon.startCuaDriverDaemon("/base", "host-id")).rejects.toThrow(
      "unsupported manifest",
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
    const { cuaDriverRuntimeKey, getCuaDriverStartupFailure } =
      await import("./cuaDriver.startupFailure");
    expect(getCuaDriverStartupFailure(cuaDriverRuntimeKey("/base", "/cua-driver", null))).toContain(
      "unsupported manifest",
    );
    await daemon.startCuaDriverDaemon("/base", "host-id");
    expect(
      getCuaDriverStartupFailure(cuaDriverRuntimeKey("/base", "/cua-driver", null)),
    ).toBeNull();
  });

  it("propagates delayed preflight success through backend startup instead of orphaning it", async () => {
    const { inspectCuaDriverCompatibility } = await import("./cuaDriver.compatibility");
    vi.mocked(inspectCuaDriverCompatibility).mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ version: "0.39.0", honoursPidFile: true }), 13_000),
        ),
    );
    const backend = await import("./backendRuntimeEnv");
    const start = backend.resolveComputerUseRuntimeEnv("/base", "host-id");
    let settled = false;
    void start.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(settled).toBe(false);
    expect(mocks.spawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(start).resolves.toMatchObject({
      BIGBUD_CUA_DRIVER_PATH: "/cua-driver",
      BIGBUD_CUA_VALIDATE_MCP: "1",
    });
  });

  it("does not hand off an environment when policy is ignored", async () => {
    const { callCuaDriverTool } = await import("./cuaDriver.mcpClient");
    vi.mocked(callCuaDriverTool).mockResolvedValue({ structuredContent: { overall: "ok" } });
    const daemon = await import("./cuaDriver.daemon");
    const start = daemon.startCuaDriverDaemon("/base", "host-id");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(daemon.getCuaDriverDaemonEnvironment()).toBeUndefined();
    emitExit(mocks.spawned[0]!);
    await expect(start).resolves.toEqual({});
    expect(daemon.getCuaDriverDaemonStatus().state).toBe("stopped");
    vi.mocked(callCuaDriverTool).mockImplementation(async (_path, tool) => {
      if (tool === "kill_app")
        throw new Error("Permission denied: tool 'kill_app' is explicitly denied");
      return { structuredContent: { checks: [], overall: "ok" } };
    });
  });

  it("does not spawn after shutdown during compatibility inspection", async () => {
    const { inspectCuaDriverCompatibility } = await import("./cuaDriver.compatibility");
    let complete!: (value: { version: string; honoursPidFile: boolean }) => void;
    vi.mocked(inspectCuaDriverCompatibility).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const daemon = await import("./cuaDriver.daemon");
    const start = daemon.startCuaDriverDaemon("/base", "host-id");
    await daemon.stopCuaDriverDaemonAndWait();
    complete({ version: "0.39.0", honoursPidFile: true });
    await expect(start).resolves.toEqual({});
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("does not read health or hand off env after shutdown during the policy probe", async () => {
    const { callCuaDriverTool } = await import("./cuaDriver.mcpClient");
    let deny!: (error: Error) => void;
    vi.mocked(callCuaDriverTool).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          deny = reject;
        }),
    );
    const daemon = await import("./cuaDriver.daemon");
    const start = daemon.startCuaDriverDaemon("/base", "host-id");
    await vi.advanceTimersByTimeAsync(0);
    const stopping = daemon.stopCuaDriverDaemonAndWait();
    emitExit(mocks.spawned[0]!);
    await stopping;
    vi.mocked(callCuaDriverTool).mockClear();
    deny(new Error("Permission denied: tool 'kill_app' is explicitly denied"));
    await vi.advanceTimersByTimeAsync(100);
    await expect(start).resolves.toEqual({});
    expect(callCuaDriverTool).not.toHaveBeenCalled();
    expect(daemon.getCuaDriverDaemonEnvironment()).toBeUndefined();
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

  it("removes a stale socket at the endpoint before respawning", async () => {
    await loadStartedDaemon();
    mocks.removeStaleSocket.mockReturnValue("removed");
    emitExit(mocks.spawned[0]!);
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.removeStaleSocket).toHaveBeenCalledOnce();
    // Containment: the stale-socket check is scoped to the daemon's own run dir.
    const [endpoint, runDir] = mocks.removeStaleSocket.mock.calls[0] as unknown as [string, string];
    expect(Path.dirname(endpoint)).toBe(runDir);
    expect(mocks.removeStaleSocket.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.spawn.mock.invocationCallOrder[1]!,
    );
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("does not respawn when the endpoint holds something that is not a socket", async () => {
    const daemon = await loadStartedDaemon();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.removeStaleSocket.mockReturnValue("blocked");
    emitExit(mocks.spawned[0]!);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(daemon.getCuaDriverDaemonStatus().lastError).toContain("not a removable socket");
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

  it("passes a private --pid-file inside the run dir for a 0.38 runtime", async () => {
    mocks.resolveRuntime.mockReturnValue({ binaryPath: "/cua-driver", version: "0.38.0" });
    const daemon = await loadStartedDaemon();
    expect(mocks.serveArguments).toHaveBeenCalledTimes(1);
    const [endpoint, hostBundleId, options] = mocks.serveArguments.mock.calls[0]! as unknown as [
      string,
      string,
      { pidFile?: string },
    ];
    expect(hostBundleId).toBe("host-id");
    expect(options.pidFile).toMatch(/^\/managed\/run\/[^/]+\/cua\.pid$/);
    if (process.platform !== "win32") {
      expect(Path.dirname(options.pidFile!)).toBe(Path.dirname(endpoint));
    }
    // The run dir (socket and pid file) is removed with the daemon.
    const stop = daemon.stopCuaDriverDaemonAndWait();
    emitExit(mocks.spawned[0]!);
    await stop;
    expect(mocks.rmSync).toHaveBeenCalledWith(Path.dirname(options.pidFile!), {
      recursive: true,
      force: true,
    });
  });

  it("selects the installed bigbud cursor theme when one was prepared", async () => {
    mocks.resolveRuntime.mockReturnValue({ binaryPath: "/cua-driver", version: "0.38.0" });
    mocks.prepareCursorTheme.mockReturnValue("ai.bigbud.agent-cursor");
    await loadStartedDaemon();
    expect(mocks.prepareCursorTheme).toHaveBeenCalledWith("/managed/home", "0.38.0");
    expect(mocks.serveArguments).toHaveBeenCalledWith(
      expect.any(String),
      "host-id",
      expect.objectContaining({ cursorTheme: "ai.bigbud.agent-cursor" }),
    );
  });

  it.each([
    ["0.9.1 (parses but ignores the flag)", "0.9.1"],
    ["an unknown version", null],
  ])("keeps the serve argv unchanged for %s", async (_label, version) => {
    mocks.resolveRuntime.mockReturnValue({ binaryPath: "/cua-driver", version });
    await loadStartedDaemon();
    expect(mocks.serveArguments).toHaveBeenCalledWith(expect.any(String), "host-id", {});
  });

  it("runs the daemon and its helpers with the private state home and forwards it", async () => {
    const daemon = await import("./cuaDriver.daemon");
    const environment = await daemon.startCuaDriverDaemon("/base", "host-id");
    const stateHome = "/managed/home";
    const expected = { BIGBUD_CUA_STATE_HOME: stateHome };
    expect(mocks.resolvePrivateStateHome).toHaveBeenCalledWith("/base");
    // Daemon spawn, `status` polling and the health MCP call all carry it.
    for (const call of mocks.makeChildEnvironment.mock.calls) {
      expect(call[1]).toMatchObject(expected);
    }
    expect(mocks.makeChildEnvironment.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Forwarded to the backend as the carrier key only: terminals and provider CLIs
    // must not inherit the Driver overrides, which every Driver child derives at spawn.
    expect(environment).toMatchObject(expected);
    expect(environment.CUA_DRIVER_RS_HOME).toBeUndefined();
    expect(environment.CUA_DRIVER_TELEMETRY_HOME).toBeUndefined();
    expect(environment.HOME).toBeUndefined();
  });
});
