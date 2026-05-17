import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

const { spawnMock, createPiRemoteWorkspaceBridgeMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  createPiRemoteWorkspaceBridgeMock: vi.fn(),
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

describe("createPiRpcProcess", () => {
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
      },
    );
    expect(rpcProcess.cwd).toBe("/tmp/pi-remote-bridge");

    child.emit("exit", 0, null);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
