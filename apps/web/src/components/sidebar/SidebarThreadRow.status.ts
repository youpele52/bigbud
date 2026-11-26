import type { TerminalFinishedItem } from "@bigbud/contracts/workspace/terminal.activity.ts";
import { presentTerminalFinished } from "./Sidebar.terminalFinished.logic";
import type { GitStatusResult } from "@bigbud/contracts";
import type { ThreadTerminalLiveness } from "../../stores/terminal/terminalLiveness.store";

import { CHILD_PROVIDER_ICON_CLASS } from "../chat/agents/agentActivity.presentation";
import type { ThreadStatusPill } from "./Sidebar.logic";

export type ThreadPr = GitStatusResult["pr"];

export interface TerminalStatusIndicator {
  label: string;
  colorClass: string;
  pulse: boolean;
}

export interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

export function providerIconPresentationClass(
  status: ThreadStatusPill | null,
  isConnecting: boolean,
): string {
  if (isConnecting) return "text-warning";
  if (status?.label === "Done") return "text-success";
  if (status?.label === "Subagents Working") return CHILD_PROVIDER_ICON_CLASS;
  return status?.colorClass ?? "text-muted-foreground";
}

export function isProviderIconWorking(status: ThreadStatusPill | null): boolean {
  return status?.label === "Working" || status?.label === "Subagents Working";
}

export function shouldAnimateProviderIcon({
  isConnecting,
  isRunning,
}: {
  isConnecting: boolean;
  isRunning: boolean;
}): boolean {
  return isConnecting || isRunning;
}

export function shouldShowThreadStatusLabel(status: ThreadStatusPill | null): boolean {
  return (
    status !== null &&
    status.label !== "Failed" &&
    status.label !== "Working" &&
    status.label !== "Subagents Working" &&
    status.label !== "Compacting" &&
    status.label !== "Done" &&
    status.label !== "Idle"
  );
}

const EMPTY_LIVENESS: ThreadTerminalLiveness = Object.freeze({});

/**
 * The live terminals the row counts: those that are panes of the thread in this client. A thread
 * with no known panes (opened by another client, or local state lost) shows every live terminal,
 * so a running process is never hidden.
 */
export function livenessForThreadPanes(
  liveness: ThreadTerminalLiveness,
  panes: ReadonlyArray<string>,
): ThreadTerminalLiveness {
  if (panes.length === 0) return liveness;
  const ids = Object.keys(liveness);
  const kept = ids.filter((terminalId) => panes.includes(terminalId));
  if (kept.length === ids.length) return liveness;
  if (kept.length === 0) return EMPTY_LIVENESS;
  return Object.fromEntries(kept.map((terminalId) => [terminalId, liveness[terminalId]!]));
}

/** How often a pending idle warning's "closes in N minutes" label is recomputed. */
export const TERMINAL_LIVENESS_REFRESH_MS = 15_000;

function pendingIdleDeadlineMs(liveness: ThreadTerminalLiveness, nowMs: number): number | null {
  let soonest: number | null = null;
  for (const entry of Object.values(liveness)) {
    const closesAt = entry.idleClosesAt ? Date.parse(entry.idleClosesAt) : Number.NaN;
    if (Number.isFinite(closesAt) && closesAt > nowMs && (soonest === null || closesAt < soonest))
      soonest = closesAt;
  }
  return soonest;
}

/** Whether the label depends on the clock (an idle warning is pending). */
export function hasPendingIdleWarning(liveness: ThreadTerminalLiveness, nowMs: number): boolean {
  return pendingIdleDeadlineMs(liveness, nowMs) !== null;
}

/**
 * The row's terminal glyph for live terminals (plan §11.2): amber while an idle warning is
 * pending, blue with a pulse when any is busy, muted otherwise. Passed deadlines are ignored, as
 * the close notice or the next inventory removes the terminal.
 */
export function terminalStatusFromLiveness(
  liveness: ThreadTerminalLiveness,
  nowMs: number,
): TerminalStatusIndicator | null {
  const entries = Object.values(liveness);
  if (entries.length === 0) return null;
  const deadline = pendingIdleDeadlineMs(liveness, nowMs);
  if (deadline !== null) {
    const minutes = Math.max(1, Math.ceil((deadline - nowMs) / 60_000));
    return {
      label: `Terminal closes in ${minutes} ${minutes === 1 ? "minute" : "minutes"} (idle)`,
      colorClass: "text-warning",
      pulse: false,
    };
  }
  const busy = entries.filter((entry) => entry.busy).length;
  const running =
    entries.length === 1 ? "1 terminal running" : `${entries.length} terminals running`;
  if (busy === 0) return { label: running, colorClass: "text-muted-foreground", pulse: false };
  return {
    label: entries.length === 1 ? `${running} (busy)` : `${running} (${busy} busy)`,
    colorClass: "text-info-foreground",
    pulse: true,
  };
}

/**
 * The row's terminal icon for finished terminal work in Needs you: red when the newest command
 * failed (non-zero exit), green otherwise. The command is in the tooltip; no exit code is shown.
 */
export function terminalStatusFromFinished(
  items: ReadonlyArray<TerminalFinishedItem> | undefined,
): TerminalStatusIndicator | null {
  const finished = presentTerminalFinished(items);
  if (!finished) return null;
  return {
    label: `${finished.failed ? "Terminal command failed" : "Terminal command finished"}: ${finished.command}`,
    colorClass: finished.failed ? "text-destructive" : "text-success",
    pulse: false,
  };
}

export function mergeRunningTerminalIds(
  ...runningTerminalIdLists: ReadonlyArray<ReadonlyArray<string>>
): string[] {
  return [...new Set(runningTerminalIdLists.flat())].filter((terminalId) => terminalId.length > 0);
}

export function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-success-foreground",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-muted-foreground",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-primary",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

export function shouldShowThreadConnectingPresentation(
  visibleThreadStatus: ThreadStatusPill | null,
  connectingStartedAt: string | null,
): connectingStartedAt is string {
  return connectingStartedAt !== null && visibleThreadStatus?.label === "Getting Ready";
}
