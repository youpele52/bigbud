import * as OS from "node:os";
import * as Path from "node:path";

import type { App } from "electron";
import { releaseChannelLabel, resolveReleaseChannel } from "@bigbud/shared/releaseChannel";

import { resolveCuaDriverHostBundleId } from "./backend/cuaDriver.hostIdentity";
import {
  readLinuxGpuFallbackMarker,
  resolveLinuxDesktopRuntimeConfig,
  resolveLinuxGpuFallbackMarkerPath,
} from "./main.linuxRuntime";
import { resolveDesktopRuntimeInfo } from "./env/runtimeArch";

export function resolveDesktopMainConfig(app: App, desktopDir: string) {
  const baseDir =
    process.env.BIGBUD_HOME?.trim() ||
    process.env.T3CODE_HOME?.trim() ||
    Path.join(OS.homedir(), ".bigbud");
  const stateDir = Path.join(baseDir, "userdata");
  const rootDir = Path.resolve(desktopDir, "../../..");
  const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
  const releaseChannel = resolveReleaseChannel(app.getVersion());
  const appDisplayName = isDevelopment
    ? "bigbud (Dev)"
    : releaseChannel
      ? `bigbud (${releaseChannelLabel(releaseChannel)})`
      : "bigbud";
  const userDataDirName = isDevelopment ? "bigbud-dev" : "bigbud";
  // Retain the Alpha-era name during the legacy profile migration window.
  const legacyUserDataDirName = isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)";
  const linuxGpuFallbackMarkerPath = resolveLinuxGpuFallbackMarkerPath(stateDir);

  return {
    appDisplayName,
    appUserModelId: "ai.bigbud.desktop",
    baseDir,
    cuaDriverHostBundleId: resolveCuaDriverHostBundleId(app.isPackaged),
    desktopLinuxRuntimeConfig: resolveLinuxDesktopRuntimeConfig({
      gpuFallbackMarkerArmed: readLinuxGpuFallbackMarker(linuxGpuFallbackMarkerPath),
    }),
    desktopRuntimeInfo: resolveDesktopRuntimeInfo({
      platform: process.platform,
      processArch: process.arch,
      runningUnderArm64Translation: app.runningUnderARM64Translation === true,
    }),
    desktopScheme: "bigbud",
    isDevelopment,
    isDevelopmentDiagnostics: !app.isPackaged,
    legacyUserDataDirName,
    linuxDesktopEntryName: isDevelopment ? "bigbud-dev.desktop" : "bigbud.desktop",
    linuxGpuFallbackMarkerPath,
    linuxWmClass: isDevelopment ? "bigbud-dev" : "bigbud",
    rootDir,
    serverSettingsPath: Path.join(stateDir, "settings.json"),
    userDataDirName,
  } as const;
}
