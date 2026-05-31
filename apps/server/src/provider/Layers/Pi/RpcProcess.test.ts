import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, createPiRemoteWorkspaceBridgeMock, assertSshExecutionTargetReadyMock } =
  vi.hoisted(() => ({
    spawnMock: vi.fn(),
    createPiRemoteWorkspaceBridgeMock: vi.fn(),
    assertSshExecutionTargetReadyMock: vi.fn(),
  }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock("./PiRemoteWorkspaceBridge.ts", () => ({
  createPiRemoteWorkspaceBridge: createPiRemoteWorkspaceBridgeMock,
}));

vi.mock("../../../ssh/sshVerification.ts", () => ({
  assertSshExecutionTargetReady: assertSshExecutionTargetReadyMock,
}));

import { createPiRpcProcess } from "./RpcProcess.ts";

function createFakeChildProcess() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stdout.setEncoding = vi.fn();
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stderr.setEncoding = vi.fn();
  const stdin = {
    writable: true,
    end: vi.fn(),
    write: vi.fn((_data: string, callback?: (error?: Error | null) => void) => {
      callback?.(null);
      return true;
    }),
  };
  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    stdin: typeof stdin;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.exitCode = null;
  child.kill = vi.fn();
  return child;
}

async function withMockedPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  }
}

describe("createPiRpcProcess", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    createPiRemoteWorkspaceBridgeMock.mockReset();
    assertSshExecutionTargetReadyMock.mockReset();
  });

  it("spawns pi with local cwd for local-runtime local Pi sessions", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValueOnce(child);
    createPiRemoteWorkspaceBridgeMock.mockResolvedValueOnce(undefined);

    const rpcProcess = await createPiRpcProcess({
      binaryPath: "/custom/pi",
      providerRuntimeTarget: {
        location: "local",
        executionTargetId: "local",
      },
      workspaceTarget: {
        location: "local",
        executionTargetId: "local",
        cwd: "/tmp/local-project",
      },
      sessionFile: "/tmp/pi-session.json",
      env: globalThis.process.env,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "/custom/pi",
      ["--mode", "rpc", "--session", "/tmp/pi-session.json"],
      {
        cwd: "/tmp/local-project",
        env: globalThis.process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );
    expect(rpcProcess.cwd).toBe("/tmp/local-project");
    expect(rpcProcess.command).toBe("/custom/pi");

    child.emit("exit", 0, null);
  });

  it("injects the remote workspace bridge for local-runtime remote Pi sessions", async () => {
    const child = createFakeChildProcess();
    const cleanup = vi.fn(async () => undefined);
    spawnMock.mockReturnValueOnce(child);
    createPiRemoteWorkspaceBridgeMock.mockResolvedValueOnce({
      cwd: "/tmp/pi-remote-bridge",
      extensionPath: "/tmp/pi-remote-bridge/.bigbud/bigbud-remote-workspace-bridge.ts",
      extraArgs: [
        "--no-builtin-tools",
        "--no-extensions",
        "--extension",
        "/tmp/pi-remote-bridge/.bigbud/bigbud-remote-workspace-bridge.ts",
      ],
      cleanup,
    });

    const rpcProcess = await createPiRpcProcess({
      binaryPath: "/custom/pi",
      providerRuntimeTarget: {
        location: "local",
        executionTargetId: "local",
      },
      workspaceTarget: {
        location: "remote",
        executionTargetId: "ssh:host=devbox&user=root&port=22",
        cwd: "/srv/project",
      },
      sessionFile: "/tmp/pi-session.json",
      env: globalThis.process.env,
    });

    expect(createPiRemoteWorkspaceBridgeMock).toHaveBeenCalledWith({
      location: "remote",
      executionTargetId: "ssh:host=devbox&user=root&port=22",
      cwd: "/srv/project",
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "/custom/pi",
      [
        "--mode",
        "rpc",
        "--session",
        "/tmp/pi-session.json",
        "--no-builtin-tools",
        "--no-extensions",
        "--extension",
        "/tmp/pi-remote-bridge/.bigbud/bigbud-remote-workspace-bridge.ts",
      ],
      {
        cwd: "/tmp/pi-remote-bridge",
        env: globalThis.process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );
    expect(rpcProcess.cwd).toBe("/tmp/pi-remote-bridge");

    child.emit("exit", 0, null);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("uses a shell on Windows for local provider runtime Pi sessions", async () => {
    await withMockedPlatform("win32", async () => {
      const child = createFakeChildProcess();
      spawnMock.mockReturnValueOnce(child);
      createPiRemoteWorkspaceBridgeMock.mockResolvedValueOnce(undefined);

      const rpcProcess = await createPiRpcProcess({
        binaryPath: "/custom/pi.cmd",
        providerRuntimeTarget: {
          location: "local",
          executionTargetId: "local",
        },
        workspaceTarget: {
          location: "local",
          executionTargetId: "local",
          cwd: "/tmp/project",
        },
        env: globalThis.process.env,
      });

      expect(spawnMock).toHaveBeenCalledWith("/custom/pi.cmd", ["--mode", "rpc"], {
        cwd: "/tmp/project",
        env: globalThis.process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
      });

      child.emit("exit", 0, null);
      await expect(rpcProcess.stop()).resolves.toBeUndefined();
    });
  });

  it("quotes Windows shell command paths with spaces", async () => {
    await withMockedPlatform("win32", async () => {
      const child = createFakeChildProcess();
      spawnMock.mockReturnValueOnce(child);
      createPiRemoteWorkspaceBridgeMock.mockResolvedValueOnce(undefined);

      const rpcProcess = await createPiRpcProcess({
        binaryPath: "C:\\Users\\Youpele PC\\AppData\\Roaming\\npm\\pi.cmd",
        providerRuntimeTarget: {
          location: "local",
          executionTargetId: "local",
        },
        workspaceTarget: {
          location: "local",
          executionTargetId: "local",
          cwd: "C:\\Users\\Youpele PC\\project",
        },
        env: globalThis.process.env,
      });

      expect(spawnMock).toHaveBeenCalledWith(
        '"C:\\Users\\Youpele PC\\AppData\\Roaming\\npm\\pi.cmd"',
        ["--mode", "rpc"],
        {
          cwd: "C:\\Users\\Youpele PC\\project",
          env: globalThis.process.env,
          stdio: ["pipe", "pipe", "pipe"],
          shell: true,
        },
      );

      child.emit("exit", 0, null);
      await expect(rpcProcess.stop()).resolves.toBeUndefined();
    });
  });

  it("does not use a shell on Windows for executable Pi paths", async () => {
    await withMockedPlatform("win32", async () => {
      const child = createFakeChildProcess();
      spawnMock.mockReturnValueOnce(child);
      createPiRemoteWorkspaceBridgeMock.mockResolvedValueOnce(undefined);

      const rpcProcess = await createPiRpcProcess({
        binaryPath: "C:\\Program Files\\Pi\\pi.exe",
        providerRuntimeTarget: {
          location: "local",
          executionTargetId: "local",
        },
        workspaceTarget: {
          location: "local",
          executionTargetId: "local",
          cwd: "C:\\Users\\Youpele PC\\project",
        },
        env: globalThis.process.env,
      });

      expect(spawnMock).toHaveBeenCalledWith("C:\\Program Files\\Pi\\pi.exe", ["--mode", "rpc"], {
        cwd: "C:\\Users\\Youpele PC\\project",
        env: globalThis.process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });

      child.emit("exit", 0, null);
      await expect(rpcProcess.stop()).resolves.toBeUndefined();
    });
  });

  it("does not use a shell on Windows for remote provider runtime Pi sessions", async () => {
    await withMockedPlatform("win32", async () => {
      const child = createFakeChildProcess();
      spawnMock.mockReturnValueOnce(child);
      createPiRemoteWorkspaceBridgeMock.mockResolvedValueOnce(undefined);

      const rpcProcess = await createPiRpcProcess({
        binaryPath: "pi",
        providerRuntimeTarget: {
          location: "remote",
          executionTargetId:
            "ssh:host=devbox&user=root&port=22&auth=ssh-key&keyPath=%2Ftmp%2Fid_ed25519",
        },
        workspaceTarget: {
          location: "remote",
          executionTargetId:
            "ssh:host=devbox&user=root&port=22&auth=ssh-key&keyPath=%2Ftmp%2Fid_ed25519",
          cwd: "/srv/project",
        },
        env: globalThis.process.env,
      });

      expect(assertSshExecutionTargetReadyMock).toHaveBeenCalledWith(
        "ssh:host=devbox&user=root&port=22&auth=ssh-key&keyPath=%2Ftmp%2Fid_ed25519",
      );
      expect(spawnMock).toHaveBeenCalledWith("ssh", expect.any(Array), {
        env: globalThis.process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });

      child.emit("exit", 0, null);
      await expect(rpcProcess.stop()).resolves.toBeUndefined();
    });
  });

  it("stop sends SIGTERM and resolves once the child exits", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValueOnce(child);
    createPiRemoteWorkspaceBridgeMock.mockResolvedValueOnce(undefined);

    const rpcProcess = await createPiRpcProcess({
      binaryPath: "/custom/pi",
      providerRuntimeTarget: {
        location: "local",
        executionTargetId: "local",
      },
      workspaceTarget: {
        location: "local",
        executionTargetId: "local",
        cwd: "/tmp/project",
      },
      env: globalThis.process.env,
    });

    const stopPromise = rpcProcess.stop();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("exit", 0, null);
    await expect(stopPromise).resolves.toBeUndefined();
  });

  it("stop is idempotent", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValueOnce(child);
    createPiRemoteWorkspaceBridgeMock.mockResolvedValueOnce(undefined);

    const rpcProcess = await createPiRpcProcess({
      binaryPath: "/custom/pi",
      providerRuntimeTarget: {
        location: "local",
        executionTargetId: "local",
      },
      workspaceTarget: {
        location: "local",
        executionTargetId: "local",
        cwd: "/tmp/project",
      },
      env: globalThis.process.env,
    });

    const first = rpcProcess.stop();
    const second = rpcProcess.stop();

    // Both calls resolve at the same time and only one SIGTERM is sent.
    child.emit("exit", 0, null);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("stop resolves immediately if the child has already exited", async () => {
    const child = createFakeChildProcess();
    spawnMock.mockReturnValueOnce(child);
    createPiRemoteWorkspaceBridgeMock.mockResolvedValueOnce(undefined);

    const rpcProcess = await createPiRpcProcess({
      binaryPath: "/custom/pi",
      providerRuntimeTarget: {
        location: "local",
        executionTargetId: "local",
      },
      workspaceTarget: {
        location: "local",
        executionTargetId: "local",
        cwd: "/tmp/project",
      },
      env: globalThis.process.env,
    });

    child.emit("exit", 0, null);

    await expect(rpcProcess.stop()).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
