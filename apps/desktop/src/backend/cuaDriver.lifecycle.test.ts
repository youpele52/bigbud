import { describe, expect, it, vi } from "vitest";

import {
  makeCuaDriverLifecycle,
  requestCuaDriverPermissionsAfterHostPreflight,
} from "./cuaDriver.lifecycle";

describe("CuaDriverLifecycle", () => {
  it("stops the backend before replacing the daemon and starting a fresh backend", async () => {
    const calls: string[] = [];
    const lifecycle = makeCuaDriverLifecycle({
      stopBackendAndWaitForExit: vi.fn(async () => {
        calls.push("stop-backend");
      }),
      stopCuaDriverDaemon: vi.fn(() => {
        calls.push("stop-daemon");
      }),
      startBackend: vi.fn(async () => {
        calls.push("start-backend");
      }),
    });

    await lifecycle.refresh();

    expect(calls).toEqual(["stop-backend", "stop-daemon", "start-backend"]);
  });

  it("coalesces concurrent refresh requests", async () => {
    let releaseStop!: () => void;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseStop = resolve;
        }),
    );
    const stopDaemon = vi.fn();
    const start = vi.fn(async () => {});
    const lifecycle = makeCuaDriverLifecycle({
      stopBackendAndWaitForExit: stop,
      stopCuaDriverDaemon: stopDaemon,
      startBackend: start,
    });

    const first = lifecycle.refresh();
    const second = lifecycle.refresh();
    releaseStop();
    await Promise.all([first, second]);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(stopDaemon).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("requestCuaDriverPermissionsAfterHostPreflight", () => {
  const granted = {
    runtimeAvailable: true,
    granted: true,
    message: null,
    permissions: [{ name: "accessibility", granted: true }],
  };

  it("returns pending guidance without refreshing or checking the old daemon", async () => {
    const refresh = vi.fn(async () => {});
    const requestPermissions = vi.fn(async () => granted);

    const result = await requestCuaDriverPermissionsAfterHostPreflight({
      hostAccessibilityTrusted: false,
      hostBundleId: "ai.bigbud.desktop.dev",
      lifecycle: { refresh },
      requestPermissions,
    });

    expect(result.pendingHostAccessibilityApproval).toBe(true);
    expect(result.source?.hostBundleId).toBe("ai.bigbud.desktop.dev");
    expect(refresh).not.toHaveBeenCalled();
    expect(requestPermissions).not.toHaveBeenCalled();
  });

  it("refreshes before checking permissions after the host grant is trusted", async () => {
    const calls: string[] = [];
    const result = await requestCuaDriverPermissionsAfterHostPreflight({
      hostAccessibilityTrusted: true,
      hostBundleId: "ai.bigbud.desktop.dev",
      lifecycle: {
        refresh: vi.fn(async () => {
          calls.push("refresh");
        }),
      },
      requestPermissions: vi.fn(async () => {
        calls.push("permissions");
        return granted;
      }),
    });

    expect(result).toEqual(granted);
    expect(calls).toEqual(["refresh", "permissions"]);
  });

  it("checks directly on platforms without the Electron macOS preflight", async () => {
    const refresh = vi.fn(async () => {});
    const requestPermissions = vi.fn(async () => granted);

    await requestCuaDriverPermissionsAfterHostPreflight({
      hostAccessibilityTrusted: null,
      hostBundleId: "ai.bigbud.desktop",
      lifecycle: { refresh },
      requestPermissions,
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(requestPermissions).toHaveBeenCalledOnce();
  });
});
