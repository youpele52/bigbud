/**
 * Subagent detail from one Pi extension result: model, tool steps, metrics and summary.
 *
 * Messages follow pi-ai 0.80.3: assistant `content` holds `toolCall` parts
 * (`{ type, id, name, arguments }`), and `toolResult` messages carry `toolCallId` and
 * `isError`. Only the reported fields are mapped; nothing is inferred.
 *
 * @module PiAdapter.stream.subagents.detail
 */
import {
  appendSubagentStep,
  boundSubagentText,
  completeSubagentStep,
  normalizeSubagentMetrics,
  type ProviderSubagentMetrics,
  type ProviderSubagentStep,
} from "@bigbud/shared/providerSubagents";

import { isRecord } from "./Adapter.utils.ts";

export interface PiSubagentDetail {
  readonly model?: string;
  readonly steps?: ReadonlyArray<ProviderSubagentStep>;
  readonly lastToolName?: string;
  readonly metrics?: ProviderSubagentMetrics;
  readonly summary?: string;
  readonly usage?: Record<string, number>;
}

const USAGE_KEYS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cost",
  "contextTokens",
  "turns",
] as const;

function boundedUsage(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return;
  const usage: Record<string, number> = {};
  for (const key of USAGE_KEYS) {
    const number = value[key];
    if (typeof number === "number" && Number.isFinite(number) && number >= 0) usage[key] = number;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function lastText(messages: ReadonlyArray<unknown>): string | undefined {
  for (const message of messages.toReversed()) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content.toReversed()) {
      if (
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.trim()
      )
        return part.text.trim().slice(0, 500);
    }
  }
}

function toolSteps(messages: ReadonlyArray<unknown>, at: string) {
  let steps: ReadonlyArray<ProviderSubagentStep> | undefined;
  let lastToolName: string | undefined;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      steps = completeSubagentStep(
        steps,
        message.toolCallId,
        message.isError === true ? "failed" : "completed",
      );
      continue;
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== "toolCall" || typeof part.name !== "string") continue;
      steps = appendSubagentStep(steps, {
        ...(typeof part.id === "string" ? { id: part.id } : {}),
        toolName: part.name,
        status: "running",
        at,
      });
      lastToolName = part.name;
    }
  }
  return { steps, lastToolName };
}

/** Pi results carry no timestamps per message, so steps share the observation time. */
export function piSubagentDetail(
  result: {
    readonly model?: unknown;
    readonly usage?: unknown;
    readonly messages?: ReadonlyArray<unknown>;
    readonly summary?: unknown;
  },
  at = new Date().toISOString(),
): PiSubagentDetail {
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const usage = boundedUsage(result.usage);
  const tokens = (usage?.input ?? 0) + (usage?.output ?? 0);
  const metrics = normalizeSubagentMetrics({
    ...(tokens > 0 ? { totalTokens: tokens } : {}),
    ...(usage?.cost !== undefined && usage.cost > 0 ? { costUsd: usage.cost } : {}),
  });
  const { steps, lastToolName } = toolSteps(messages, at);
  const model = boundSubagentText(result.model, "model");
  const summary =
    lastText(messages) ??
    (typeof result.summary === "string" ? result.summary.trim().slice(0, 500) : undefined);
  return {
    ...(model ? { model } : {}),
    ...(steps ? { steps } : {}),
    ...(lastToolName ? { lastToolName } : {}),
    ...(metrics ? { metrics } : {}),
    ...(summary ? { summary } : {}),
    ...(usage ? { usage } : {}),
  };
}
