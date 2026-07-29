import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, () => unknown>());
const ipcMain = vi.hoisted(() => ({
  handle: vi.fn((channel: string, handler: () => unknown) => handlers.set(channel, handler)),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain }));

import { registerComputerUseIpcHandlers } from "./ipcHandlers.computerUse";

function register() {
  const requestHostAccessibilityPermission = vi.fn(() => false);
  const requestComputerUsePermissions = vi.fn(async () => ({
    runtimeAvailable: true,
    granted: false,
    message: null,
    permissions: [],
  }));
  registerComputerUseIpcHandlers({
    GET_COMPUTER_USE_RUNTIME_STATUS_CHANNEL: "runtime",
    GET_COMPUTER_USE_PERMISSIONS_STATUS_CHANNEL: "status",
    REQUEST_COMPUTER_USE_PERMISSIONS_CHANNEL: "request",
    INSTALL_COMPUTER_USE_RUNTIME_CHANNEL: "install",
    RUN_COMPUTER_USE_DOCTOR_CHANNEL: "doctor",
    getComputerUseRuntimeStatus: vi.fn(),
    getComputerUsePermissionsStatus: vi.fn(),
    requestHostAccessibilityPermission,
    requestComputerUsePermissions,
    installComputerUseRuntime: vi.fn(),
    runComputerUseDoctor: vi.fn(),
  });
  return { requestHostAccessibilityPermission, requestComputerUsePermissions };
}

describe("registerComputerUseIpcHandlers", () => {
  beforeEach(() => {
    handlers.clear();
    ipcMain.handle.mockClear();
    ipcMain.removeHandler.mockClear();
  });

  it("requests host Accessibility only for the explicit permission action", async () => {
    const calls = register();

    await handlers.get("status")?.();
    expect(calls.requestHostAccessibilityPermission).not.toHaveBeenCalled();

    await handlers.get("request")?.();
    expect(calls.requestHostAccessibilityPermission).toHaveBeenCalledOnce();
    expect(calls.requestComputerUsePermissions).toHaveBeenCalledWith(false);
    expect(calls.requestHostAccessibilityPermission.mock.invocationCallOrder[0]).toBeLessThan(
      calls.requestComputerUsePermissions.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });
});
