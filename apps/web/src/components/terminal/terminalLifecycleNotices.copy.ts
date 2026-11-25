import type {
  TerminalCloseDrainingHostsResult,
  TerminalLifecycleNotice,
} from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import { TERMINAL_LIVE_LIMIT_DEFAULT } from "@bigbud/contracts/workspace/terminal.limit.ts";

import type { TerminalNoticeNames } from "./terminalLifecycle.labels";

export interface TerminalLifecycleNoticeCopy {
  /** Amber for warnings and closes, red for failures (plan §11.3). */
  readonly type: "warning" | "error";
  readonly title: string;
  readonly description?: string;
}

/**
 * Toast copy per notice kind (plan §11.3). Null means no toast: `quitClosed` follows the user's
 * own quit, `orphanClosed` is summarised by `offlineClosed`, and `modelInvalid`/`spoolDegraded`
 * are diagnostics. `idleWarningCleared` only dismisses the warning.
 */
export function describeTerminalLifecycleNotice(
  notice: TerminalLifecycleNotice,
  { label, thread }: TerminalNoticeNames,
): TerminalLifecycleNoticeCopy | null {
  switch (notice.kind) {
    case "idleWarning":
      return {
        type: "warning",
        title: `“${label}” in “${thread}” has been idle for 9 minutes and will close in 1 minute.`,
      };
    case "idleClosed":
      return { type: "warning", title: `Closed idle terminal “${label}” in “${thread}”.` };
    case "pressureClosed":
      return {
        type: "warning",
        title: `Memory is low, so bigbud closed the idle terminal “${label}” in “${thread}”.`,
      };
    case "pressureNoCandidate":
      return { type: "warning", title: "Memory is low. No hidden idle terminals could be closed." };
    case "limitClosed":
      return { type: "warning", title: `Closed “${label}” in “${thread}” to open a new terminal.` };
    case "setupBlockedByLimit": {
      const limit = notice.limit ?? TERMINAL_LIVE_LIMIT_DEFAULT;
      return {
        type: "warning",
        title: "Terminal limit reached, so the setup script didn't start.",
        description: notice.candidate
          ? `Closing the oldest terminal, “${label}” in “${thread}”, lets it run.`
          : `Setup script didn't run because the terminal limit (${limit}) is reached. Close a terminal and run it again.`,
      };
    }
    case "offlineClosed": {
      const count = notice.count ?? 1;
      return {
        type: "warning",
        title: `While bigbud was closed, ${count} ${count === 1 ? "terminal was" : "terminals were"} closed because ${count === 1 ? "it was" : "they were"} idle.`,
      };
    }
    case "hostLost":
      return {
        type: "error",
        title: `Lost contact with “${label}” in “${thread}”.`,
        description:
          "The terminal service became unavailable. bigbud can’t confirm whether the terminal stopped. The last available output stays visible, and bigbud won’t restart it automatically.",
      };
    case "legacyHostUnreachable":
      return {
        type: "warning",
        title:
          "Terminals from a previous bigbud version are still running but can't be reconnected.",
      };
    case "backendRestartStopped":
      return { type: "warning", title: "Terminals were stopped because the backend restarted." };
    case "idleWarningCleared":
    case "orphanClosed":
    case "quitClosed":
    case "modelInvalid":
    case "spoolDegraded":
      return null;
  }
}

/** The outcome of "Close them": green when every old host stopped, amber when some remain. */
export function describeClosedDrainingHosts(result: TerminalCloseDrainingHostsResult): {
  readonly type: "success" | "warning";
  readonly title: string;
  readonly description?: string;
} {
  if (result.remaining === 0)
    return { type: "success", title: "Closed the terminals from the previous bigbud version." };
  return {
    type: "warning",
    title: "Some terminals from the previous bigbud version are still running.",
    description: "bigbud couldn't safely identify their terminal service, so it was left running.",
  };
}
