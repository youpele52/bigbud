import type {
  OrchestrationSubagentMetrics,
  OrchestrationTask,
} from "@bigbud/contracts/orchestration/orchestration.thread.tasks.ts";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import { formatToolDisplayName } from "~/lib/toolPresentation";

/** Status tones follow the app semantics: blue working, green done, amber warning, red failure. */
export type SubagentStatusTone = "working" | "done" | "warning" | "failed";

export const SUBAGENT_STATUS_TONE_CLASSES: Record<
  SubagentStatusTone,
  { readonly dot: string; readonly text: string }
> = {
  working: { dot: "bg-blue-500", text: "text-blue-600 dark:text-blue-400" },
  done: { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  warning: { dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
  failed: { dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
};

/** Maximum visual nesting depth for subagent rows. */
export const SUBAGENT_MAX_INDENT_DEPTH = 3;

const isActive = (agent: OrchestrationTask) =>
  agent.status === "pending" || agent.status === "inProgress";

const isStale = (agent: OrchestrationTask) => isActive(agent) && !agent.activityFresh;

export function subagentStatusLabel(agent: OrchestrationTask): string {
  if (isStale(agent)) return "Last seen";
  switch (agent.status) {
    case "pending":
      return "Starting";
    case "inProgress":
      return "Working";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
  }
}

export function subagentStatusTone(agent: OrchestrationTask): SubagentStatusTone {
  if (isStale(agent) || agent.status === "stopped") return "warning";
  if (agent.status === "completed") return "done";
  if (agent.status === "failed") return "failed";
  return "working";
}

export function visibleSubagents<T>(agents: ReadonlyArray<T>, expanded: boolean): ReadonlyArray<T> {
  return expanded ? agents : agents.slice(0, 1);
}

export function subagentDisplayName(agent: OrchestrationTask): string {
  return agent.subagentType ?? agent.subject;
}

export function subagentModelLabel(agent: OrchestrationTask): string | undefined {
  if (!agent.model) return undefined;
  return agent.effort ? `${agent.model} · ${agent.effort}` : agent.model;
}

export function subagentActivityLine(agent: OrchestrationTask): string | undefined {
  if (agent.progressSummary) return agent.progressSummary;
  if (agent.lastToolName && isActive(agent))
    return `Running ${formatToolDisplayName(agent.lastToolName)}`;
  return (
    agent.resultSummary ??
    (agent.lastToolName ? `Ran ${formatToolDisplayName(agent.lastToolName)}` : undefined)
  );
}

function durationLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

/** Elapsed time: terminal rows to `endedAt`, live rows to `now`, stale rows as age. */
export function subagentTimeLabel(agent: OrchestrationTask, now = Date.now()): string {
  if (isStale(agent)) return `${durationLabel(now - Date.parse(agent.updatedAt))} ago`;
  const end = isActive(agent) ? now : Date.parse(agent.endedAt ?? agent.updatedAt);
  return durationLabel(end - Date.parse(agent.createdAt));
}

function preciseDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Formats only the provider-reported metrics; absent values are omitted, never zero-filled. */
export function subagentMetricsLabel(
  metrics: OrchestrationSubagentMetrics | undefined,
): string | undefined {
  if (!metrics) return undefined;
  const parts: string[] = [];
  if (metrics.totalTokens !== undefined) {
    parts.push(`${formatContextWindowTokens(metrics.totalTokens)} tokens`);
  }
  if (metrics.toolUses !== undefined) {
    parts.push(`${metrics.toolUses} tool${metrics.toolUses === 1 ? "" : "s"}`);
  }
  if (metrics.durationMs !== undefined) parts.push(preciseDuration(metrics.durationMs));
  if (metrics.costUsd !== undefined) {
    parts.push(
      metrics.costUsd > 0 && metrics.costUsd < 0.01 ? "<$0.01" : `$${metrics.costUsd.toFixed(2)}`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function hasSubagentDetails(agent: OrchestrationTask): boolean {
  return Boolean(
    agent.description ||
    agent.prompt ||
    agent.lastToolName ||
    (agent.subagentType && agent.subagentType !== agent.subject) ||
    agent.terminalReason ||
    agent.resultSummary ||
    (agent.recentSteps && agent.recentSteps.length > 0) ||
    subagentMetricsLabel(agent.metrics),
  );
}
