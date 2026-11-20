import type { useNavigate } from "@tanstack/react-router";

import { announceMascotAttention } from "../components/floating-assistant/mascotAttention.logic";
import { isThreadNavigationAvailable } from "../components/layout/AppSidebarLayout.logic";
import { useStore } from "../stores/main";

/**
 * Attempts to show a native OS notification about a thread.
 *
 * Priority order:
 *   1. Electron desktopBridge.notifications (Electron IPC-backed)
 *   2. Web Notification API (browser fallback)
 *
 * Returns true if the notification was dispatched.
 */
export async function showSystemThreadNotification(
  copy: { readonly title: string; readonly body: string; readonly threadId: string },
  navigate?: ReturnType<typeof useNavigate>,
): Promise<boolean> {
  const { title, body, threadId } = copy;

  // Electron path
  const bridge = window.desktopBridge;
  if (bridge?.notifications) {
    try {
      const shown = await bridge.notifications.show({ title, body, threadId });
      if (shown) {
        announceMascotAttention();
        return true;
      }
    } catch {
      // Fall through to web Notification API
    }
  }

  // Web Notification API fallback
  if (typeof Notification === "undefined") {
    return false;
  }

  if (Notification.permission === "denied") {
    return false;
  }

  if (Notification.permission === "default") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return false;
    }
  }

  const notification = new Notification(title, { body });
  notification.addEventListener(
    "click",
    () => {
      window.focus();
      const threadAvailable = isThreadNavigationAvailable(threadId, useStore.getState());
      if (!threadAvailable) {
        if (typeof bridge?.openMainWindow === "function") {
          void bridge.openMainWindow();
        }
        return;
      }
      if (navigate) {
        void navigate({ to: "/$threadId", params: { threadId } });
        return;
      }
      if (typeof window.desktopBridge?.openMainWindow === "function") {
        void window.desktopBridge.openMainWindow(threadId);
        return;
      }
      window.location.assign(`/${encodeURIComponent(threadId)}`);
    },
    { once: true },
  );
  void notification;
  announceMascotAttention();
  return true;
}
