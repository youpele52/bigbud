import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { createFakeChildProcess } from "./RpcProcess.testHelpers.ts";

async function createLocalRpcProcess() {
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
  return { child, rpcProcess };
}

describe("createPiRpcProcess lifecycle", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    createPiRemoteWorkspaceBridgeMock.mockReset();
  });

  it("stop sends SIGTERM and resolves once the child exits", async () => {
    const { child, rpcProcess } = await createLocalRpcProcess();
    const stopPromise = rpcProcess.stop();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("exit", 0, null);
    await expect(stopPromise).resolves.toBeUndefined();
  });

  it("stop is idempotent", async () => {
    const { child, rpcProcess } = await createLocalRpcProcess();
    const first = rpcProcess.stop();
    const second = rpcProcess.stop();

    child.emit("exit", 0, null);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("stop resolves immediately if the child has already exited", async () => {
    const { child, rpcProcess } = await createLocalRpcProcess();
    child.emit("exit", 0, null);

    await expect(rpcProcess.stop()).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
