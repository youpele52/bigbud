import { ThreadId } from "@bigbud/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { toastManager } from "../components/ui/toast";
import { useSettings } from "../hooks/useSettings";
import { useStore } from "../stores/main";
import { showSystemThreadNotification } from "./systemNotification";
import {
  buildTerminalFinishedCopy,
  terminalFinishedNotificationKey,
} from "./terminalFinished.logic";
import { onTerminalWorkActivity } from "./terminalWorkEvents";

/**
 * Toast and desktop notification for finished terminal work, following task completions: the
 * toast honours "task completion toasts", the OS notification honours "system task completion
 * notifications" and only fires while the app is hidden. The server raises an item only when no
 * client views that pane, so a viewed pane never notifies.
 */
export function TerminalFinishedNotifications() {
  const settings = useSettings();
  const navigate = useNavigate();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const notified = new Set<string>();
    return onTerminalWorkActivity((item) => {
      const finished = item.finished;
      if (!finished) return;
      const key = terminalFinishedNotificationKey(item.threadId, finished);
      if (notified.has(key)) return;
      notified.add(key);
      if (notified.size > 256) notified.delete(notified.values().next().value!);
      const threadTitle = useStore.getState().sidebarThreadsById[item.threadId]?.title;
      const copy = buildTerminalFinishedCopy(finished, threadTitle);
      const current = settingsRef.current;
      if (current.enableTaskCompletionToasts) {
        toastManager.add({
          type: copy.type,
          title: copy.title,
          description: copy.body,
          data: { threadId: ThreadId.makeUnsafe(item.threadId), hideOnActiveThread: false },
          actionProps: {
            children: "View",
            onClick: () => {
              void navigateRef.current({ to: "/$threadId", params: { threadId: item.threadId } });
            },
          },
        });
      }
      if (document.hidden && current.enableSystemTaskCompletionNotifications) {
        void showSystemThreadNotification(
          { title: copy.title, body: copy.body, threadId: item.threadId },
          navigateRef.current,
        );
      }
    });
  }, []);

  return null;
}
