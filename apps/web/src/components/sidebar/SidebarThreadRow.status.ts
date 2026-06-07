import type { GitStatusResult } from "@bigbud/contracts";

export type ThreadPr = GitStatusResult["pr"];

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-info-foreground",
    pulse: true,
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
