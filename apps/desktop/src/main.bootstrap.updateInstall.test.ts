import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  events: [] as string[],
}));

vi.mock("./backend/copilotRuntimeMigration", () => ({
  preservePackagedCopilotRuntime: vi.fn(async () => mocks.events.push("copilot preserved")),
}));
vi.mock("./backend/backendManager", () => ({
  stopBackendAndWaitForExit: vi.fn(async () => mocks.events.push("backend stopped")),
}));
vi.mock("./backend/cuaDriver.runtime", () => ({
  resolveComputerUseRuntime: () => ({ binaryPath: "/cua" }),
}));
vi.mock("./backend/cuaDriver.daemon", () => ({
  stopCuaDriverDaemonAndWait: vi.fn(async () => mocks.events.push("daemon stopped")),
}));
vi.mock("./backend/cuaDriver.process", () => ({
  stopCuaDriverCommandsAndWait: vi.fn(async () => mocks.events.push("commands stopped")),
}));
vi.mock("./backend/cuaDriver.windowsSweep", () => ({ sweepWindowsCuaDriverProcesses: vi.fn() }));
vi.mock("./backend/windowsFileReplaceability", () => ({ assertWindowsFilesReplaceable: vi.fn() }));
vi.mock("./updater/windowsUpdateTargets", () => ({ resolveWindowsUpdateTargets: vi.fn() }));
vi.mock("./backend/installedProcessQuiescence", () => ({
  beginInstalledProcessQuiescence: vi.fn(() => mocks.events.push("quiesce")),
  getInstalledProcessTreeUncertainty: () => null,
}));

import { createPrepareForUpdateInstall } from "./main.bootstrap.updateInstall";

beforeEach(() => {
  mocks.events.length = 0;
});

it("announces the update quit while the backend runs, before stopping it (F7)", async () => {
  const runQuitHandshake = vi.fn(async (reason: string) => {
    mocks.events.push(`handshake ${reason}`);
  });
  await createPrepareForUpdateInstall({
    cuaDriverBaseDir: "/base",
    isPackaged: true,
    resourcesPath: "/resources",
    runQuitHandshake,
  })();
  expect(runQuitHandshake).toHaveBeenCalledWith("update");
  expect(mocks.events.slice(0, 4)).toEqual([
    "copilot preserved",
    "quiesce",
    "handshake update",
    "backend stopped",
  ]);
});

it("still stops the backend when the handshake fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await createPrepareForUpdateInstall({
    cuaDriverBaseDir: "/base",
    isPackaged: true,
    resourcesPath: "/resources",
    runQuitHandshake: async () => {
      throw new Error("pipe closed");
    },
  })();
  expect(mocks.events).toContain("backend stopped");
});
