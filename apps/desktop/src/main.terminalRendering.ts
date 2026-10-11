import { ipcMain, type App, type WebContents } from "electron";
import type { TerminalRenderingPolicy } from "@bigbud/contracts/server/ipc.terminal";
import { desktopIpcChannels } from "./main.channels";
import { shouldArmLinuxGpuFallback } from "./main.linuxRuntime";

export function resolveTerminalRenderingPolicy(
  disabled: boolean,
  crashLatched: boolean,
  feature: string | undefined,
): TerminalRenderingPolicy {
  const reason = disabled
    ? "Application hardware acceleration is disabled."
    : crashLatched
      ? "GPU crash protection is active for this window session."
      : ![
            "enabled",
            "enabled_on",
            "enabled_force",
            "enabled_force_on",
            "enabled_readback",
          ].includes(feature ?? "")
        ? "Hardware WebGL2 is unavailable or not yet known."
        : null;
  return { allowed: reason === null, reason, webglFeatureStatus: feature ?? "unknown" };
}

let readPolicy = (): TerminalRenderingPolicy =>
  resolveTerminalRenderingPolicy(false, false, undefined);

/** Read-only policy: no renderer action can clear Linux fallback or change app switches. */
export function registerTerminalRenderingPolicy(
  app: Pick<App, "on" | "getGPUFeatureStatus">,
  disabled: boolean,
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
