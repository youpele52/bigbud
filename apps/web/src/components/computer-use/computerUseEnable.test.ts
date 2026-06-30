import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DesktopComputerUsePermissionsStatus,
  type DesktopComputerUseRuntimeStatus,
} from "@bigbud/contracts";
import { makeDesktopBridge } from "../../rpc/wsNativeApi.test.helpers";
import { desktopComputerUseQueryKeys } from "../../lib/desktopComputerUseReactQuery";
import { enableComputerUseInBackground } from "./computerUseEnable";

const { addToast } = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

vi.mock("../ui/toast", () => ({
  toastManager: {
    add: addToast,
  },
}));

const grantedPermissions: DesktopComputerUsePermissionsStatus = {
  runtimeAvailable: true,
  granted: true,
  message: null,
  permissions: [
    { name: "accessibility", granted: true },
    { name: "screen_recording", granted: true },
  ],
};

const managedRuntime: DesktopComputerUseRuntimeStatus = {
  available: true,
  source: "managed",
  binaryPath: "/tmp/cua-driver",
  version: "0.6.8",
  message: null,
  diagnostics: null,
};

function getTestWindow(): Window & typeof globalThis & { desktopBridge?: unknown } {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis & { desktopBridge?: unknown };
  };
  if (!testGlobal.window) {
    testGlobal.window = {} as Window & typeof globalThis & { desktopBridge?: unknown };
  }
  return testGlobal.window;
}

describe("enableComputerUseInBackground", () => {
  beforeEach(() => {
    addToast.mockReset();
  });

  it("enables immediately and skips reinstall when the runtime is already available", async () => {
    const queryClient = new QueryClient();
    const updateSettings = vi.fn();
    const requestPermissions = vi.fn().mockResolvedValue(grantedPermissions);
    const installRuntime = vi.fn();

    getTestWindow().desktopBridge = makeDesktopBridge({
      getComputerUseRuntimeStatus: async () => managedRuntime,
      installComputerUseRuntime: installRuntime,
      requestComputerUsePermissions: requestPermissions,
    });

    enableComputerUseInBackground({ queryClient, updateSettings });

    expect(updateSettings).toHaveBeenCalledWith({
      computerUseEnabled: true,
      hasSeenComputerUsePrompt: true,
    });

    await vi.waitFor(() => {
      expect(requestPermissions).toHaveBeenCalledTimes(1);
    });

    expect(installRuntime).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(desktopComputerUseQueryKeys.status())).toEqual(managedRuntime);
    expect(queryClient.getQueryData(desktopComputerUseQueryKeys.permissions())).toEqual(
      grantedPermissions,
    );
    expect(addToast).toHaveBeenCalledWith({
      type: "success",
      title: "Computer Use enabled",
      description: "Desktop automation is ready to use.",
    });
  });

  it("installs in the background before requesting permissions when the runtime is missing", async () => {
    const queryClient = new QueryClient();
    const updateSettings = vi.fn();
    const installRuntime = vi.fn().mockResolvedValue({
      ok: true,
      status: managedRuntime,
    });
    const requestPermissions = vi.fn().mockResolvedValue(grantedPermissions);

    getTestWindow().desktopBridge = makeDesktopBridge({
      getComputerUseRuntimeStatus: async () => ({
        available: false,
        source: "missing",
        binaryPath: null,
        version: null,
        message: "Computer Use runtime is not installed yet.",
        diagnostics: null,
      }),
      installComputerUseRuntime: installRuntime,
      requestComputerUsePermissions: requestPermissions,
    });

    enableComputerUseInBackground({ queryClient, updateSettings });

    await vi.waitFor(() => {
      expect(installRuntime).toHaveBeenCalledTimes(1);
      expect(requestPermissions).toHaveBeenCalledTimes(1);
    });

    expect(addToast).toHaveBeenCalledWith({
      type: "info",
      title: "Setting up Computer Use",
      description: "bigbud is preparing desktop automation in the background.",
    });
  });
});
