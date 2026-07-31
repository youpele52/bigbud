import type { DesktopComputerUsePermissionsStatus } from "@bigbud/contracts";

import { pendingHostAccessibilityPermissionsStatus } from "./cuaDriver.permissions";

export interface CuaDriverLifecycleDeps {
  readonly stopBackendAndWaitForExit: () => Promise<void>;
  readonly stopCuaDriverDaemon: () => void;
  readonly startBackend: () => Promise<void>;
}

export interface CuaDriverLifecycle {
  readonly refresh: () => Promise<void>;
}

export function requestCuaDriverPermissionsAfterHostPreflight(input: {
  readonly hostAccessibilityTrusted: boolean | null;
  readonly hostBundleId: string;
  readonly lifecycle: CuaDriverLifecycle;
  readonly requestPermissions: () => Promise<DesktopComputerUsePermissionsStatus>;
}): Promise<DesktopComputerUsePermissionsStatus> {
  if (input.hostAccessibilityTrusted === false) {
    return Promise.resolve(pendingHostAccessibilityPermissionsStatus(input.hostBundleId));
  }
  return (async () => {
    if (input.hostAccessibilityTrusted === true) {
      await input.lifecycle.refresh();
    }
    return input.requestPermissions();
  })();
}

export function makeCuaDriverLifecycle(deps: CuaDriverLifecycleDeps): CuaDriverLifecycle {
  let refreshPromise: Promise<void> | null = null;

  return {
    refresh: () => {
      if (refreshPromise) return refreshPromise;
      const request = (async () => {
        await deps.stopBackendAndWaitForExit();
        deps.stopCuaDriverDaemon();
        await deps.startBackend();
      })();
      refreshPromise = request;
      const clearRequest = () => {
        if (refreshPromise === request) refreshPromise = null;
      };
      void request.then(clearRequest, clearRequest);
      return request;
    },
  };
}
