import * as OS from "node:os";
import * as Path from "node:path";

import type { App } from "electron";
import {
  desktopReleaseIdentityForChannel,
  resolveDesktopReleaseIdentity,
} from "@bigbud/shared/desktopReleaseIdentity";

import { resolveCuaDriverHostBundleId } from "./backend/cuaDriver.hostIdentity";
import {
  readLinuxGpuFallbackMarker,
  resolveLinuxDesktopRuntimeConfig,
  resolveLinuxGpuFallbackMarkerPath,
} from "./main.linuxRuntime";
import { resolveDesktopRuntimeInfo } from "./env/runtimeArch";

export function resolveDesktopMainConfig(app: App, desktopDir: string) {
  const rootDir = Path.resolve(desktopDir, "../../..");
  const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
  const releaseIdentity = isDevelopment
    ? desktopReleaseIdentityForChannel("stable")
    : resolveDesktopReleaseIdentity(app.getVersion());
  const configuredBaseDir = process.env.BIGBUD_HOME?.trim() || process.env.T3CODE_HOME?.trim();
  const baseDir =
    configuredBaseDir ?? Path.join(OS.homedir(), ".bigbud", ...releaseIdentity.baseDirSuffix);
  const stateDir = Path.join(baseDir, "userdata");
  const appDisplayName = isDevelopment ? "bigbud (Dev)" : releaseIdentity.productName;
  const userDataDirName = isDevelopment ? "bigbud-dev" : releaseIdentity.userDataDirName;
  const legacyUserDataDirName = isDevelopment
    ? "T3 Code (Dev)"
    : releaseIdentity.channel === "stable"
      ? "T3 Code (Alpha)"
      : null;
  const linuxGpuFallbackMarkerPath = resolveLinuxGpuFallbackMarkerPath(stateDir);

  return {
    appDisplayName,
    appUserModelId: releaseIdentity.appUserModelId,
    baseDir,
    cuaDriverHostBundleId: resolveCuaDriverHostBundleId(app.isPackaged, releaseIdentity.appId),
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
    linuxDesktopEntryName: isDevelopment
      ? "bigbud-dev.desktop"
      : releaseIdentity.linuxDesktopEntryName,
    linuxGpuFallbackMarkerPath,
    linuxWmClass: isDevelopment ? "bigbud-dev" : releaseIdentity.linuxWmClass,
    releaseIdentity,
    rootDir,
    serverSettingsPath: Path.join(stateDir, "settings.json"),
    userDataDirName,
  } as const;
}
