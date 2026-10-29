import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DesktopComputerUsePermissionsStatus,
  type DesktopComputerUseRuntimeStatus,
  type DesktopComputerUseInstallResult,
} from "@bigbud/contracts";
import { makeDesktopBridge } from "../../rpc/wsNativeApi.test.helpers";
import { desktopComputerUseQueryKeys } from "../../lib/desktopComputerUseReactQuery";
import { enableComputerUseInBackground } from "./computerUseEnable";

const { addToast, closeToast } = vi.hoisted(() => ({
  addToast: vi.fn(),
  closeToast: vi.fn(),
}));

vi.mock("../ui/toast", () => ({
  toastManager: {
    add: addToast,
    close: closeToast,
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
  ready: true,
  repairRequired: false,
  state: "ready",
  source: "managed",
  binaryPath: "/tmp/cua-driver",
  version: "cua-driver 0.9.1",
  expectedVersion: "0.9.1",
  manifestSchema: "1",
  policyVersion: "1",
  policySha256: "digest",
  daemonState: "ready",
  platform: "darwin",
  architecture: "arm64",
  platformHealth: "ready",
  healthSummary: "ok",
  lastError: null,
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
    addToast.mockReset().mockReturnValue("computer-use-progress");
    closeToast.mockReset();
    Object.defineProperty(Navigator.prototype, "platform", {
      configurable: true,
      value: "MacIntel",
    });
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
    });

    await vi.waitFor(() => {
      expect(requestPermissions).toHaveBeenCalledTimes(1);
    });

    expect(installRuntime).not.toHaveBeenCalled();
    expect(closeToast).not.toHaveBeenCalled();
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
        ready: false,
        repairRequired: true,
        state: "missing",
        source: "missing",
        binaryPath: null,
        version: null,
        expectedVersion: "0.9.1",
        manifestSchema: null,
        policyVersion: null,
        policySha256: null,
        daemonState: "stopped",
        platform: "darwin",
        architecture: "arm64",
        platformHealth: "degraded",
        healthSummary: null,
        lastError: null,
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
      type: "loading",
      title: "Setting up Computer Use",
      description: "bigbud is preparing desktop automation in the background.",
    });
  });

  it("requests permissions without reinstalling a permission-degraded runtime", async () => {
    const queryClient = new QueryClient();
    const updateSettings = vi.fn();
    const installRuntime = vi.fn();
    const requestPermissions = vi.fn().mockResolvedValue({
      runtimeAvailable: true,
      granted: false,
      pendingHostAccessibilityApproval: true,
      message:
        "❌ Accessibility: not granted. ✅ Screen Recording: granted. ℹ️ Approve Accessibility, then check access again.",
      permissions: [{ name: "accessibility", granted: false }],
    });

    getTestWindow().desktopBridge = makeDesktopBridge({
      getComputerUseRuntimeStatus: async () => ({
        ...managedRuntime,
        ready: false,
        repairRequired: false,
        state: "degraded",
        daemonState: "degraded",
        platformHealth: "degraded",
        healthSummary: "degraded",
      }),
      installComputerUseRuntime: installRuntime,
      requestComputerUsePermissions: requestPermissions,
    });

    enableComputerUseInBackground({ queryClient, updateSettings });

    await vi.waitFor(() => {
      expect(requestPermissions).toHaveBeenCalledTimes(1);
    });
    expect(installRuntime).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith({
      type: "warning",
      title: "Finish macOS permissions",
      description:
        "Accessibility: not granted.\nScreen Recording: granted.\nApprove Accessibility, then check access again.",
    });
  });

  it.each([
    ["success", "success", "Computer Use enabled"],
    ["install failure", "error", "Computer Use setup failed"],
    ["runtime not ready", "error", "Computer Use runtime is not ready"],
    ["permissions attention", "warning", "Finish macOS permissions"],
    ["install exception", "error", "Computer Use setup failed"],
    ["permissions exception", "error", "Computer Use setup failed"],
  ])("closes only the progress toast after %s", async (outcome, type, title) => {
    const queryClient = new QueryClient();
    let resolveInstall!: (result: DesktopComputerUseInstallResult) => void;
    let rejectInstall!: (reason: Error) => void;
    const installResult = new Promise<DesktopComputerUseInstallResult>((resolve, reject) => {
      resolveInstall = resolve;
      rejectInstall = reject;
    });
    const requestPermissions = vi.fn(async () => {
      if (outcome === "permissions exception") throw new Error("Permissions unavailable");
      return outcome === "permissions attention"
        ? { ...grantedPermissions, granted: false, pendingHostAccessibilityApproval: true }
        : grantedPermissions;
    });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    getTestWindow().desktopBridge = makeDesktopBridge({
      getComputerUseRuntimeStatus: async () => ({ ...managedRuntime, repairRequired: true }),
      installComputerUseRuntime: () => installResult,
      requestComputerUsePermissions: requestPermissions,
    });

    enableComputerUseInBackground({ queryClient, updateSettings: vi.fn() });

    await vi.waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ type: "loading" }));
    });
    expect(closeToast).not.toHaveBeenCalled();
    expect(requestPermissions).not.toHaveBeenCalled();
    addToast.mockReturnValue("computer-use-terminal");
    if (outcome === "install exception") {
      rejectInstall(new Error("Install unavailable"));
    } else {
      resolveInstall({
        ok: outcome !== "install failure",
        status:
          outcome === "runtime not ready"
            ? { ...managedRuntime, ready: false, state: "unavailable" }
            : managedRuntime,
      });
    }

    await vi.waitFor(() => {
      expect(closeToast).toHaveBeenCalledExactlyOnceWith("computer-use-progress");
    });
    expect(addToast).toHaveBeenCalledTimes(2);
    expect(addToast).toHaveBeenLastCalledWith(expect.objectContaining({ type, title }));
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: desktopComputerUseQueryKeys.status(),
    });
    if (outcome === "permissions attention") {
      expect(invalidateQueries).not.toHaveBeenCalledWith({
        queryKey: desktopComputerUseQueryKeys.permissions(),
      });
    } else {
      expect(invalidateQueries).toHaveBeenCalledWith({
        queryKey: desktopComputerUseQueryKeys.permissions(),
      });
    }
  });

  it("repairs an available but incompatible runtime before requesting permissions", async () => {
    const queryClient = new QueryClient();
    const updateSettings = vi.fn();
    const installRuntime = vi.fn().mockResolvedValue({ ok: true, status: managedRuntime });
    const requestPermissions = vi.fn().mockResolvedValue(grantedPermissions);

    getTestWindow().desktopBridge = makeDesktopBridge({
      getComputerUseRuntimeStatus: async () => ({
        ...managedRuntime,
        ready: false,
        repairRequired: true,
        state: "incompatible",
        version: "cua-driver 0.6.8",
        daemonState: "degraded",
        platformHealth: "degraded",
        healthSummary: null,
        lastError: "cua-driver is missing required tools: get_session_state.",
        message: "Expected cua-driver 0.9.1.",
      }),
      installComputerUseRuntime: installRuntime,
      requestComputerUsePermissions: requestPermissions,
    });

    enableComputerUseInBackground({ queryClient, updateSettings });

    await vi.waitFor(() => {
      expect(installRuntime).toHaveBeenCalledTimes(1);
      expect(requestPermissions).toHaveBeenCalledTimes(1);
    });
  });

  it("uses a generic permissions toast outside macOS", async () => {
    Object.defineProperty(Navigator.prototype, "platform", {
      configurable: true,
      value: "Linux x86_64",
    });

    const queryClient = new QueryClient();
    const updateSettings = vi.fn();
    const requestPermissions = vi.fn().mockResolvedValue({
      runtimeAvailable: true,
      granted: false,
      message: null,
      permissions: [],
    });

    getTestWindow().desktopBridge = makeDesktopBridge({
      getComputerUseRuntimeStatus: async () => managedRuntime,
      requestComputerUsePermissions: requestPermissions,
    });

    enableComputerUseInBackground({ queryClient, updateSettings });

    await vi.waitFor(() => {
      expect(requestPermissions).toHaveBeenCalledTimes(1);
    });

    expect(addToast).toHaveBeenCalledWith({
      type: "warning",
      title: "Finish desktop permissions",
      description:
        "Grant the needed operating system permissions in system settings, then return to bigbud and check access.",
    });
  });
});
