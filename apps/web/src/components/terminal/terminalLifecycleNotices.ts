import type { NativeApi } from "@bigbud/contracts";
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";

import { TERMINAL_CLOSING_NOTICE_KINDS } from "../../stores/terminal/terminalLiveness.store";
import type { toastManager } from "../ui/toast.manager";
import { resolveTerminalNoticeNames, type TerminalNoticeNames } from "./terminalLifecycle.labels";
import { describeTerminalLifecycleNotice } from "./terminalLifecycleNotices.copy";

type ToastOptions = Parameters<typeof toastManager.add>[0];

export interface TerminalLifecycleNoticeDeps {
  readonly terminal: Pick<NativeApi["terminal"], "keepOpen" | "retrySetup">;
  readonly toasts: Pick<typeof toastManager, "add" | "close">;
  readonly names?: (threadId?: string, terminalId?: string) => TerminalNoticeNames;
  readonly now?: () => number;
}

export interface TerminalLifecycleNotices {
  readonly handle: (notice: TerminalLifecycleNotice) => void;
  readonly dispose: () => void;
}

/** Replays repeat notice ids; remember enough of them to show each notice once. */
const MAX_SEEN_NOTICE_IDS = 512;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "Try again.";
}

function warningKey(notice: TerminalLifecycleNotice): string | null {
  return notice.threadId && notice.terminalId
    ? JSON.stringify([notice.threadId, notice.terminalId])
    : null;
}

/** Maps lifecycle notices to toasts (plan §11.3): Keep open, the setup retry, and closes. */
export function createTerminalLifecycleNotices(
  deps: TerminalLifecycleNoticeDeps,
): TerminalLifecycleNotices {
  const names = deps.names ?? resolveTerminalNoticeNames;
  const now = deps.now ?? Date.now;
  const seen = new Set<string>();
  const warningToastIds = new Map<string, string>();
  let disposed = false;

  const add = (options: ToastOptions): string => deps.toasts.add(options);
  const closeWarning = (notice: TerminalLifecycleNotice) => {
    const key = warningKey(notice);
    const id = key ? warningToastIds.get(key) : undefined;
    if (!key || id === undefined) return;
    warningToastIds.delete(key);
    deps.toasts.close(id);
  };

  const keepOpen = async (notice: TerminalLifecycleNotice) => {
    closeWarning(notice);
    const { threadId, terminalId } = notice;
    if (!threadId || !terminalId || !deps.terminal.keepOpen) return;
    try {
      await deps.terminal.keepOpen({ threadId, terminalId });
    } catch (error) {
      if (disposed) return;
      add({
        type: "error",
        title: "Couldn't keep the terminal open",
        description: errorMessage(error),
      });
    }
  };

  const retrySetup = async (notice: TerminalLifecycleNotice, toastId: string) => {
    deps.toasts.close(toastId);
    const { threadId, candidate } = notice;
    if (!threadId || !candidate || !deps.terminal.retrySetup) return;
    try {
      const result = await deps.terminal.retrySetup({
        threadId,
        evict: { threadId: candidate.threadId, terminalId: candidate.terminalId },
      });
      if (disposed) return;
      add(
        result.status === "started"
          ? { type: "success", title: `Setup script “${result.scriptName}” started.` }
          : { type: "info", title: "This project no longer has a setup script to run." },
      );
    } catch (error) {
      if (disposed) return;
      add({
        type: "error",
        title: "The setup script didn't start",
        description: errorMessage(error),
      });
    }
  };

  const handle = (notice: TerminalLifecycleNotice) => {
    if (disposed || seen.has(notice.noticeId)) return;
    seen.add(notice.noticeId);
    if (seen.size > MAX_SEEN_NOTICE_IDS) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    if (notice.kind === "idleWarningCleared") {
      closeWarning(notice);
      return;
    }
    if (TERMINAL_CLOSING_NOTICE_KINDS.has(notice.kind)) closeWarning(notice);
    const copy = describeTerminalLifecycleNotice(notice, names(notice.threadId, notice.terminalId));
    if (!copy) return;
    if (notice.kind === "idleWarning") {
      const key = warningKey(notice);
      closeWarning(notice);
      const closesAt = notice.closesAt ? Date.parse(notice.closesAt) : Number.NaN;
      // Never persistent: if the clearing notice is lost, the toast still leaves on its own.
      const timeout = Number.isFinite(closesAt) ? Math.max(1, closesAt - now()) : 60_000;
      const id = add({
        ...copy,
        timeout,
        ...(deps.terminal.keepOpen
          ? { actionProps: { children: "Keep open", onClick: () => void keepOpen(notice) } }
          : {}),
      });
      if (key) warningToastIds.set(key, id);
      return;
    }
    if (notice.kind === "setupBlockedByLimit" && notice.candidate && deps.terminal.retrySetup) {
      let toastId = "";
      toastId = add({
        ...copy,
        timeout: 0,
        actionProps: {
          children: "Close oldest and run setup",
          onClick: () => void retrySetup(notice, toastId),
        },
      });
      return;
    }
    add(copy);
  };

  return {
    handle,
    dispose: () => {
      disposed = true;
      seen.clear();
      warningToastIds.clear();
    },
  };
}
