import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./RpcProcess.capabilities.ts", () => ({
  detectPiSettlementSupport: vi.fn(async () => ({
    supportsAgentSettled: false,
    supportsPromptDisposition: false,
  })),
}));

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

import { createPiRpcProcess } from "./RpcProcess.ts";
import { detectPiSettlementSupport } from "./RpcProcess.capabilities.ts";
import { createFakeChildProcess } from "./RpcProcess.testHelpers.ts";

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
    vi.mocked(detectPiSettlementSupport).mockResolvedValue({
      supportsAgentSettled: false,
      supportsPromptDisposition: false,
    });
  });

  it.each(["local"] as const)(
    "uses detected modern lifecycle support for a %s runtime",
    async (location) => {
      const child = createFakeChildProcess();
      spawnMock.mockReturnValueOnce(child);
      vi.mocked(detectPiSettlementSupport).mockResolvedValue({
        supportsAgentSettled: true,
        supportsPromptDisposition: true,
      });
      const rpc = await createPiRpcProcess({
        binaryPath: "/custom/pi",
        providerRuntimeTarget:
          location === "local"
            ? { location, executionTargetId: "local" }
            : { location, executionTargetId: "ssh:host=devbox&user=root&port=22" },
        workspaceTarget: { location: "local", executionTargetId: "local", cwd: undefined },
      });
      expect(rpc.supportsAgentSettled).toBe(true);
      child.emit("exit", 0, null);
    },
  );

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
    expect(rpcProcess.supportsAgentSettled).toBe(false);
    expect(rpcProcess.command).toBe("/custom/pi");

    child.emit("exit", 0, null);
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
});
