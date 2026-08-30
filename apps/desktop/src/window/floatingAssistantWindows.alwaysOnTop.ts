import type { BrowserWindow } from "electron";

export type FloatingAssistantAlwaysOnTopPolicy =
  | { readonly level: "floating" | "screen-saver" }
  | { readonly level: null };

export function resolveFloatingAssistantAlwaysOnTopPolicy(
  platform: string,
): FloatingAssistantAlwaysOnTopPolicy {
  if (platform === "darwin") return { level: "floating" };
  if (platform === "win32") return { level: "screen-saver" };

  // Electron cannot enforce always-on-top on native Wayland. An unlevelled
  // request remains the supported best effort for Linux/X11, XWayland, and
  // unrecognized platforms.
  return { level: null };
}

export function reassertFloatingAssistantAlwaysOnTop(
  window: BrowserWindow,
  platform: string = process.platform,
): void {
  if (window.isDestroyed()) return;

  const policy = resolveFloatingAssistantAlwaysOnTopPolicy(platform);
  if (policy.level === null) {
    window.setAlwaysOnTop(true);
    return;
  }
  window.setAlwaysOnTop(true, policy.level);
}

export function bindFloatingAssistantAlwaysOnTop(
  window: BrowserWindow,
  platform: string = process.platform,
): void {
  const reassert = (): void => reassertFloatingAssistantAlwaysOnTop(window, platform);

  reassert();
  window.on("ready-to-show", reassert);
  window.on("show", reassert);
  window.on("restore", reassert);
  window.on("focus", reassert);
}
