import { ipcMain, type App, type WebContents } from "electron";
import type { TerminalRenderingPolicy } from "@bigbud/contracts/server/ipc.terminal";
import { desktopIpcChannels } from "./main.channels";
import { shouldArmLinuxGpuFallback, type LinuxOzonePlatform } from "./main.linuxRuntime";

const HARDWARE_WEBGL_STATUSES = new Set([
  "enabled",
  "enabled_on",
  "enabled_force",
  "enabled_force_on",
  "enabled_readback",
]);

/**
 * The display server Chromium runs on: an explicit ozone override wins, otherwise Electron's
 * default auto hint selects Wayland whenever a Wayland session is present.
 */
export function resolveLinuxDisplayServer(
  ozonePlatform: LinuxOzonePlatform | null,
  env: NodeJS.ProcessEnv = process.env,
): LinuxOzonePlatform {
  if (ozonePlatform) return ozonePlatform;
  return env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland" ? "wayland" : "x11";
}

/**
 * macOS and Windows attempt WebGL while Chromium's feature status is not yet reported (Orca-style);
 * the renderer keeps same-xterm DOM fallback and crash latches. Linux stays conservative because
 * software GL (llvmpipe/SwiftShader) is common there, and denies Wayland outright: xterm WebGL
 * context creation can wedge terminal input there before any context-loss event (Orca #5319).
 * A reported non-hardware status always denies.
 */
export function resolveTerminalRenderingPolicy(
  disabled: boolean,
  crashLatched: boolean,
  feature: string | undefined,
  platform: NodeJS.Platform = process.platform,
  displayServer: LinuxOzonePlatform | null = null,
): TerminalRenderingPolicy {
  const optimistic = feature === undefined && platform !== "linux";
  const wayland = platform === "linux" && displayServer === "wayland";
  const reason = disabled
    ? "Application hardware acceleration is disabled."
    : wayland
      ? "WebGL terminals are disabled on Linux Wayland, where context creation can freeze input."
      : crashLatched
        ? "GPU crash protection is active for this window session."
        : optimistic || HARDWARE_WEBGL_STATUSES.has(feature ?? "")
          ? null
          : "Hardware WebGL2 is unavailable or not yet known.";
  return {
    allowed: reason === null,
    reason,
    webglFeatureStatus: wayland
      ? "linux-wayland"
      : optimistic
        ? "unknown-optimistic"
        : (feature ?? "unknown"),
  };
}

let readPolicy = (): TerminalRenderingPolicy =>
  resolveTerminalRenderingPolicy(false, false, undefined, "linux");

/** Read-only policy: no renderer action can clear Linux fallback or change app switches. */
export function registerTerminalRenderingPolicy(
  app: Pick<App, "on" | "getGPUFeatureStatus">,
  disabled: boolean,
  platform: NodeJS.Platform = process.platform,
  displayServer: LinuxOzonePlatform | null = null,
): void {
  let crashLatched = false;
  let observed = false;
  app.on("gpu-info-update", () => {
    observed = true;
  });
  app.on("child-process-gone", (_event, details) => {
    if (details.type === "GPU" && shouldArmLinuxGpuFallback(details.reason)) crashLatched = true;
  });
  readPolicy = () => {
    const features = observed ? app.getGPUFeatureStatus() : null;
    return resolveTerminalRenderingPolicy(
      disabled,
      crashLatched,
      // Newer Chromium reports both WebGL versions under the unified webgl feature.
      features?.webgl2 ?? features?.webgl,
      platform,
      displayServer,
    );
  };
}

export function registerTerminalRenderingIpc(isTrusted: (sender: WebContents) => boolean): void {
  ipcMain.handle(
    desktopIpcChannels.getTerminalRenderingPolicy,
    (event): TerminalRenderingPolicy => {
      if (!isTrusted(event.sender) || event.senderFrame !== event.sender.mainFrame)
        throw new Error("Untrusted terminal rendering policy request.");
      return readPolicy();
    },
  );
}
