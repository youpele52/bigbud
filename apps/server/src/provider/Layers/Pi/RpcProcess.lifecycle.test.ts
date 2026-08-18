import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, createPiRemoteWorkspaceBridgeMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  createPiRemoteWorkspaceBridgeMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

vi.mock("./PiRemoteWorkspaceBridge.ts", () => ({
  createPiRemoteWorkspaceBridge: createPiRemoteWorkspaceBridgeMock,
}));

import { createPiRpcProcess } from "./RpcProcess.ts";

function createFakeChildProcess() {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  const stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  const stdin = new EventEmitter() as EventEmitter & {
    writable: boolean;
    write: ReturnType<typeof vi.fn>;
  };
  stdout.setEncoding = vi.fn();
  stderr.setEncoding = vi.fn();
  stdin.writable = true;
  stdin.write = vi.fn();
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

async function createRpcProcess(child: ReturnType<typeof createFakeChildProcess>) {
  spawnMock.mockReturnValueOnce(child);
  createPiRemoteWorkspaceBridgeMock.mockResolvedValueOnce(undefined);
  return createPiRpcProcess({
    binaryPath: "/custom/pi",
    providerRuntimeTarget: { location: "local", executionTargetId: "local" },
    workspaceTarget: { location: "local", executionTargetId: "local", cwd: "/tmp/project" },
    env: process.env,
  });
}

describe("Pi RPC process lifecycle", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    createPiRemoteWorkspaceBridgeMock.mockReset();
  });

  it("rejects pending requests when stdin emits EPIPE and makes later requests safe", async () => {
    const child = createFakeChildProcess();
    child.stdin.write.mockReturnValue(true);
    const rpcProcess = await createRpcProcess(child);
    const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

    const request = rpcProcess.request({ type: "get_state" });
    child.stdin.emit("error", error);

    await expect(request).rejects.toBe(error);
    await expect(rpcProcess.request({ type: "get_state" })).rejects.toBe(error);
    expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
  });

  it("settles callback and stdin double-signaling only once in either order", async () => {
    for (const order of ["callback-first", "stdin-first"] as const) {
      const child = createFakeChildProcess();
      let callback: ((error?: Error | null) => void) | undefined;
      child.stdin.write.mockImplementation((_data, writeCallback) => {
        callback = writeCallback;
        return true;
      });
      const rpcProcess = await createRpcProcess(child);
      const callbackError = new Error("write callback failed");
      const stdinError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      const request = rpcProcess.request({ type: "get_state" });

      if (order === "callback-first") {
        callback?.(callbackError);
        child.stdin.emit("error", stdinError);
        await expect(request).rejects.toBe(callbackError);
      } else {
        child.stdin.emit("error", stdinError);
        callback?.(callbackError);
        await expect(request).rejects.toBe(stdinError);
      }
    }
  });

  it("settles all pending requests when stdin.write throws synchronously", async () => {
    const child = createFakeChildProcess();
    const error = new Error("stdin is destroyed");
    child.stdin.write.mockReturnValueOnce(true).mockImplementationOnce(() => {
      throw error;
    });
    const rpcProcess = await createRpcProcess(child);

    const first = rpcProcess.request({ type: "get_state" });
    const second = rpcProcess.request({ type: "get_state" });

    await expect(first).rejects.toBe(error);
    await expect(second).rejects.toBe(error);
    await expect(rpcProcess.request({ type: "get_state" })).rejects.toBe(error);
  });

  it("settles a buffered final stdout response before rejecting remaining requests", async () => {
    const child = createFakeChildProcess();
    child.stdin.write.mockReturnValue(true);
    const rpcProcess = await createRpcProcess(child);
    const first = rpcProcess.request({ type: "get_state" });
    const second = rpcProcess.request({ type: "get_state" });
    const firstRequest = JSON.parse(String(child.stdin.write.mock.calls[0]?.[0])) as { id: string };
    const error = new Error("stdout failed");

    child.stdout.emit(
      "data",
      JSON.stringify({
        type: "response",
        id: firstRequest.id,
        command: "get_state",
        success: true,
        data: {},
      }),
    );
    child.stdout.emit("error", error);

    await expect(first).resolves.toMatchObject({ id: firstRequest.id, success: true });
    await expect(second).rejects.toBe(error);
  });

  it("preserves the first child terminal cause and rejects every pending request", async () => {
    const child = createFakeChildProcess();
    child.stdin.write.mockReturnValue(true);
    const rpcProcess = await createRpcProcess(child);
    const first = rpcProcess.request({ type: "get_state" });
    const second = rpcProcess.request({ type: "get_state" });
    const error = new Error("spawn transport failed");

    child.emit("error", error);
    child.emit("exit", 1, null);
    child.emit("close", 1, null);

    await expect(first).rejects.toBe(error);
    await expect(second).rejects.toBe(error);
    await expect(rpcProcess.request({ type: "get_state" })).rejects.toBe(error);
  });

  it("does not replace an exit cause when a child error follows", async () => {
    const child = createFakeChildProcess();
    child.stdin.write.mockReturnValue(true);
    const rpcProcess = await createRpcProcess(child);
    const request = rpcProcess.request({ type: "get_state" });

    child.emit("exit", 1, null);
    child.emit("error", new Error("late child error"));

    await expect(request).rejects.toThrow(
      "Pi RPC process '/custom/pi' exited (code=1, signal=null).",
    );
    await expect(rpcProcess.request({ type: "get_state" })).rejects.toThrow(
      "Pi RPC process '/custom/pi' exited (code=1, signal=null).",
    );
  });

  it("stops a live child after stdin failure and cleans up only once", async () => {
    const child = createFakeChildProcess();
    const cleanup = vi.fn(async () => undefined);
    spawnMock.mockReturnValueOnce(child);
    createPiRemoteWorkspaceBridgeMock.mockResolvedValueOnce({
      cwd: "/tmp/bridge",
      extensionPath: "/tmp/bridge/extension.ts",
      extraArgs: [],
      cleanup,
    });
    const rpcProcess = await createPiRpcProcess({
      binaryPath: "/custom/pi",
      providerRuntimeTarget: { location: "local", executionTargetId: "local" },
      workspaceTarget: { location: "remote", executionTargetId: "ssh:host=devbox", cwd: "/srv" },
      env: process.env,
    });

    child.stdin.emit("error", new Error("write EPIPE"));
    const firstStop = rpcProcess.stop();
    const secondStop = rpcProcess.stop();
    child.emit("exit", null, "SIGTERM");

    await expect(firstStop).resolves.toBeUndefined();
    await expect(secondStop).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
