import { ThreadId } from "@bigbud/contracts";
import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";

import { toastManager } from "../components/ui/toast";
import { useSettings } from "../hooks/useSettings";
import { useStore } from "../stores/main";
import type { Thread } from "../models/types";
import {
  buildTaskCompletionCopy,
  collectCompletedThreadCandidates,
  type CompletedThreadCandidate,
} from "./taskCompletion.logic";

/**
 * Attempts to show a native OS notification for a completed task.
 *
 * Priority order:
 *   1. Electron desktopBridge.notifications (Electron IPC-backed)
 *   2. Web Notification API (browser fallback)
 *
 * Returns true if the notification was dispatched.
 */
export async function showSystemTaskCompletionNotification(
  candidate: CompletedThreadCandidate,
): Promise<boolean> {
  const { title, body } = buildTaskCompletionCopy(candidate);

  // Electron path
  const bridge = window.desktopBridge;
  if (bridge?.notifications) {
    try {
      return await bridge.notifications.show({ title, body });
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
  void notification;
  return true;
}

/**
 * Fires an in-app toast notification for a completed task. Clicking the
 * action button navigates to the thread.
 */
export function showCompletionToast(
  candidate: CompletedThreadCandidate,
  navigate: ReturnType<typeof useNavigate>,
): void {
  const { title, body } = buildTaskCompletionCopy(candidate);

  toastManager.add({
    type: "success",
    title,
    description: body,
    data: {
      threadId: ThreadId.makeUnsafe(candidate.threadId),
      hideOnActiveThread: true,
    },
    actionProps: {
      children: "View",
      onClick: () => {
        void navigate({ to: "/$threadId", params: { threadId: candidate.threadId } });
      },
    },
  });
}

/**
 * Headless component that watches threads for task completions and dispatches
 * toasts and/or system notifications depending on user settings.
 *
 * Must be rendered inside both the ToastProvider and a React Router context.
 */
export function TaskCompletionNotifications() {
  const threads = useStore((state) => state.threads);
  const settings = useSettings();
  const navigate = useNavigate();

  // Keep a stable ref to the previous threads snapshot so we can diff on every update.
  const previousThreadsRef = useRef<Thread[]>([]);

  // Keep refs to the latest settings and navigate so the effect doesn't re-run
  // on every settings change while still reading current values.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const previousThreads = previousThreadsRef.current;
    previousThreadsRef.current = threads;

    // On the initial render (empty previous), skip to avoid spurious notifications
    // from pre-existing completed threads.
    if (previousThreads.length === 0 && threads.length > 0) {
      return;
    }

    const candidates = collectCompletedThreadCandidates(previousThreads, threads);
    if (candidates.length === 0) {
      return;
    }

    const currentSettings = settingsRef.current;
    const currentNavigate = navigateRef.current;

    // In-app toasts fire regardless of whether the tab is visible.
    // System notifications only fire when the user is not actively viewing the app.
    const appIsHidden = document.hidden;

    for (const candidate of candidates) {
      if (currentSettings.enableTaskCompletionToasts) {
        showCompletionToast(candidate, currentNavigate);
      }

      if (appIsHidden && currentSettings.enableSystemTaskCompletionNotifications) {
        void showSystemTaskCompletionNotification(candidate);
      }
    }
  }, [threads]);

  return null;
}
