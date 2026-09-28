import { BrowserWindow, Notification } from "electron";

import type { DesktopNotificationInput } from "@bigbud/contracts";

export function isDesktopNotificationSupported(): boolean {
  return Notification.isSupported();
}

export function showDesktopNotification(
  input: DesktopNotificationInput,
  resolveIconPath: (ext: "ico" | "icns" | "png") => string | null,
  getMainWindow: () => BrowserWindow | null,
  openMainWindow?: (threadId?: string) => BrowserWindow,
): boolean {
  if (!Notification.isSupported()) {
    return false;
  }

  const { title, body, silent, threadId } = input;
  if (typeof title !== "string" || title.trim().length === 0) {
    return false;
  }

  const iconPath = resolveIconPath("png");
  const notification = new Notification({
    title,
    ...(typeof body === "string" && body.length > 0 ? { body } : {}),
    ...(silent === true ? { silent: true } : {}),
    ...(iconPath ? { icon: iconPath } : {}),
  });

  notification.on("click", () => {
    const targetThreadId = threadId?.trim() || undefined;
    const window = openMainWindow ? openMainWindow(targetThreadId) : getMainWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  notification.show();
  return true;
}
