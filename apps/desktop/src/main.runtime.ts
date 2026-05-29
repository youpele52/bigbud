import { BrowserWindow } from "electron";
import type { App } from "electron";

import {
  armLinuxGpuFallbackMarker,
  type LinuxDesktopRuntimeConfig,
  shouldArmLinuxGpuFallback,
} from "./main.linuxRuntime";
import {
  formatDesktopPerformanceSnapshot,
  logDesktopGpuFeatureStatus,
  scheduleDesktopPerformanceSnapshots,
} from "./main.performance";

export function installDesktopSingleInstanceLock(
  appInstance: Pick<App, "on" | "quit" | "requestSingleInstanceLock">,
  getMainWindow: () => BrowserWindow | null,
): void {
  if (appInstance.requestSingleInstanceLock()) {
    appInstance.on("second-instance", () => {
      const window = getMainWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
      if (!window) return;
      if (window.isMinimized()) {
        window.restore();
      }
      if (!window.isVisible()) {
        window.show();
      }
      window.focus();
    });
    return;
  }

  appInstance.quit();
}

export function applyLinuxRuntimeSwitches(
  appInstance: Pick<App, "commandLine" | "disableHardwareAcceleration">,
  wmClass: string,
  runtimeConfig: LinuxDesktopRuntimeConfig,
): void {
  if (process.platform !== "linux") {
    return;
  }

  appInstance.commandLine.appendSwitch("class", wmClass);
  if (runtimeConfig.ozonePlatform) {
    appInstance.commandLine.appendSwitch("ozone-platform", runtimeConfig.ozonePlatform);
  }
  if (runtimeConfig.disableHardwareAcceleration) {
    appInstance.disableHardwareAcceleration();
  }
}

export function registerDesktopRuntimeMonitoring(options: {
  readonly appInstance: Pick<App, "getAppMetrics" | "getGPUFeatureStatus" | "on">;
  readonly runtimeConfig: LinuxDesktopRuntimeConfig;
  readonly linuxGpuFallbackMarkerPath: string;
  readonly log: (message: string) => void;
}): void {
  options.log(
    `linux runtime config conservativeMode=${options.runtimeConfig.conservativeMode} disableHardwareAcceleration=${options.runtimeConfig.disableHardwareAcceleration} spellcheckEnabled=${options.runtimeConfig.spellcheckEnabled} backendMaxOldSpaceMb=${options.runtimeConfig.backendMaxOldSpaceMb ?? "default"} ozonePlatform=${options.runtimeConfig.ozonePlatform ?? "auto"} gpuFallbackMarkerArmed=${options.runtimeConfig.gpuFallbackMarkerArmed}`,
  );
  options.log(
    `performance snapshot label=ready ${formatDesktopPerformanceSnapshot(options.appInstance.getAppMetrics())}`,
  );
  scheduleDesktopPerformanceSnapshots(options.appInstance, options.log);
  options.appInstance.on("gpu-info-update", () => {
    logDesktopGpuFeatureStatus(options.appInstance, options.log);
  });
  options.appInstance.on("child-process-gone", (_event, details) => {
    if (
      process.platform === "linux" &&
      details.type === "GPU" &&
      shouldArmLinuxGpuFallback(details.reason)
    ) {
      armLinuxGpuFallbackMarker(options.linuxGpuFallbackMarkerPath);
      options.log(`linux gpu fallback marker armed reason=${details.reason}`);
    }
  });
}
