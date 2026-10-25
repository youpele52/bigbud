/**
 * Per-child subagent detail for the OpenCode V1 (and KiloCode) child tracker: model,
 * summed usage across the child's assistant messages, and tool steps from tool parts.
 *
 * @module OpencodeAdapter.stream.children.activity
 */
import type { AssistantMessage, ToolPart } from "@opencode-ai/sdk/v2";
import {
  appendSubagentStep,
  completeSubagentStep,
  normalizeSubagentMetrics,
  type ProviderSubagentMetrics,
  type ProviderSubagentStep,
} from "@bigbud/shared/providerSubagents";

const MAX_USAGE_MESSAGES = 64;

export interface ChildActivity {
  assistantMessageId?: string;
  progressPartId?: string;
  progressSummary?: string;
  progressEmittedAt?: number;
  lastToolName?: string;
  terminalReason?: string;
  model?: string;
  usage?: Map<string, { readonly tokens: number; readonly cost: number }>;
  steps?: ReadonlyArray<ProviderSubagentStep> | undefined;
}

/** Records one assistant message's model and usage; returns whether anything changed. */
export function recordChildAssistant(activity: ChildActivity, message: AssistantMessage): boolean {
  let changed = false;
  if (message.providerID && message.modelID) {
    const model = `${message.providerID}/${message.modelID}`;
    if (activity.model !== model) {
      activity.model = model;
      changed = true;
    }
  }
  const tokens = message.tokens
    ? message.tokens.input + message.tokens.output + message.tokens.reasoning
    : 0;
  const cost = Number.isFinite(message.cost) ? message.cost : 0;
  const usage = activity.usage ?? new Map<string, { tokens: number; cost: number }>();
  const previous = usage.get(message.id);
  if (
    (tokens > 0 || cost > 0) &&
    (previous?.tokens !== tokens || previous.cost !== cost) &&
    (previous || usage.size < MAX_USAGE_MESSAGES)
  ) {
    usage.set(message.id, { tokens, cost });
    activity.usage = usage;
    changed = true;
  }
  return changed;
}

export function childMetrics(activity: ChildActivity): ProviderSubagentMetrics | undefined {
  if (!activity.usage) return undefined;
  let tokens = 0;
  let cost = 0;
  for (const entry of activity.usage.values()) {
    tokens += entry.tokens;
    cost += entry.cost;
  }
  return normalizeSubagentMetrics({
    ...(tokens > 0 ? { totalTokens: tokens } : {}),
    ...(cost > 0 ? { costUsd: Math.round(cost * 1e9) / 1e9 } : {}),
  });
}

/** Folds one tool part into the step ring; returns whether the ring changed. */
export function recordChildToolPart(activity: ChildActivity, part: ToolPart, at: string): boolean {
  const title = "title" in part.state ? part.state.title : undefined;
  const before = activity.steps;
  const known = before?.some((step) => step.id === part.id) ?? false;
  if (part.state.status === "pending" || part.state.status === "running" || !known) {
    activity.steps = appendSubagentStep(before, {
      id: part.id,
      toolName: part.tool,
      ...(title ? { label: title } : {}),
      status:
        part.state.status === "completed"
          ? "completed"
          : part.state.status === "error"
            ? "failed"
            : "running",
      at,
    });
  } else {
    activity.steps = completeSubagentStep(
      before,
      part.id,
      part.state.status === "error" ? "failed" : "completed",
    );
  }
  return JSON.stringify(activity.steps) !== JSON.stringify(before);
}
