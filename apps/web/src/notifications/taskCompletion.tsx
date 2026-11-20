import { ThreadId } from "@bigbud/contracts";
import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";

import { memoryReviewNotification } from "./memoryReview";
import { showSystemThreadNotification } from "./systemNotification";
import { toastManager } from "../components/ui/toast";
import { useSettings } from "../hooks/useSettings";
import { useStore } from "../stores/main";
import type { Thread } from "../models/types";
import { isVisibleThread } from "../logic/thread/threadVisibility.logic";
import {
  buildTaskCompletionCopy,
  collectCompletedThreadCandidates,
  collectAgentUpdateCandidates,
  type CompletedThreadCandidate,
} from "./taskCompletion.logic";

/** Native OS notification for a completed task (desktop bridge, then the Web Notification API). */
export async function showSystemTaskCompletionNotification(
  candidate: CompletedThreadCandidate,
  navigate?: ReturnType<typeof useNavigate>,
): Promise<boolean> {
  return showSystemThreadNotification(
    { ...buildTaskCompletionCopy(candidate), threadId: candidate.threadId },
    navigate,
  );
}

/**
 * Fires an in-app toast notification for a completed task. Clicking the
 * action button navigates to the thread.
 */
const visibleUpdates = new Map<string, string>();

export function showCompletionToast(
  candidate: CompletedThreadCandidate,
  navigate: ReturnType<typeof useNavigate>,
): void {
  const { title, body } = buildTaskCompletionCopy(candidate);

  const key = candidate.messageId ? `${candidate.threadId}:${candidate.messageId}` : null;
  const existing = key ? visibleUpdates.get(key) : undefined;
  if (candidate.kind !== "update" && existing) {
    toastManager.update(existing, { type: "success", title, description: body });
    visibleUpdates.delete(key!);
    return;
  }
  const id = toastManager.add({
    type: candidate.kind === "update" ? "info" : "success",
    onClose: () => {
      if (key) visibleUpdates.delete(key);
    },
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
  if (key && candidate.kind === "update") {
    visibleUpdates.set(key, id);
    if (visibleUpdates.size > 256) visibleUpdates.delete(visibleUpdates.keys().next().value!);
  }
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
  const notifiedRef = useRef(new Set<string>());

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

    const previousActivityIds = new Set(
      previousThreads.flatMap((thread) => thread.activities.map((activity) => activity.id)),
    );
    for (const thread of threads) {
      if (!isVisibleThread(thread)) {
        continue;
      }
      for (const activity of thread.activities) {
        if (previousActivityIds.has(activity.id)) continue;
        const notification = memoryReviewNotification(activity.kind);
        if (!notification) continue;
        toastManager.add({
          ...notification,
          data: { threadId: thread.id, hideOnActiveThread: false },
        });
      }
    }

    const completed = collectCompletedThreadCandidates(previousThreads, threads);
    const candidates = [
      ...collectAgentUpdateCandidates(previousThreads, threads).filter(
        (update) =>
          !completed.some(
            (candidate) =>
              candidate.threadId === update.threadId && candidate.messageId === update.messageId,
          ),
      ),
      ...completed,
    ];
    if (candidates.length === 0) {
      return;
    }

    const currentSettings = settingsRef.current;
    const currentNavigate = navigateRef.current;

    // In-app toasts fire regardless of whether the tab is visible.
    // System notifications only fire when the user is not actively viewing the app.
    const appIsHidden = document.hidden;

    for (const candidate of candidates) {
      const key = candidate.notificationKey!;
      if (notifiedRef.current.has(key)) continue;
      notifiedRef.current.add(key);
      if (notifiedRef.current.size > 512)
        notifiedRef.current.delete(notifiedRef.current.values().next().value!);
      if (currentSettings.enableTaskCompletionToasts) {
        showCompletionToast(candidate, currentNavigate);
      }

      if (appIsHidden && currentSettings.enableSystemTaskCompletionNotifications) {
        void showSystemTaskCompletionNotification(candidate, currentNavigate);
      }
    }
  }, [threads]);

  return null;
}
