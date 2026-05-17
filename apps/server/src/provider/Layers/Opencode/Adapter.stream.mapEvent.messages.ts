import {
  type EventId,
  type ProviderRuntimeEvent,
  type ThreadTokenUsageSnapshot,
  type TurnId,
} from "@bigbud/contracts";
import { type Event as OpencodeEvent } from "@opencode-ai/sdk/v2";

import type { ActiveOpencodeSession } from "./Adapter.types.ts";
import { eventBase, normalizeString } from "./Adapter.stream.utils.ts";

type MapEventContext = {
  readonly stamp: { readonly eventId: EventId; readonly createdAt: string };
  readonly raw: { source: "opencode.sdk.session-event"; method: string; payload: unknown };
  readonly turnId: TurnId | undefined;
};

export function mapMessagePartDelta(
  session: ActiveOpencodeSession,
  event: OpencodeEvent,
  context: MapEventContext,
): ReadonlyArray<ProviderRuntimeEvent> {
  const partDelta = event as OpencodeEvent & {
    properties: {
      partID?: string;
      field?: string;
      delta?: string;
    };
  };
  const delta = partDelta.properties.delta;
  const itemId = partDelta.properties.partID;

  if (!delta || !itemId) {
    return [];
  }

  const streamKind =
    partDelta.properties.field === "text" || partDelta.properties.field === "reasoning"
      ? session.reasoningPartIds.has(itemId)
        ? "reasoning_text"
        : "assistant_text"
      : undefined;

  if (!streamKind) {
    return [];
  }

  return [
    {
      ...eventBase({
        eventId: context.stamp.eventId,
        createdAt: context.stamp.createdAt,
        threadId: session.threadId,
        ...(context.turnId ? { turnId: context.turnId } : {}),
        itemId,
        raw: context.raw,
      }),
      type: "content.delta",
      payload: {
        streamKind,
        delta,
      },
    },
  ];
}

export function mapMessagePartUpdated(
  session: ActiveOpencodeSession,
  event: OpencodeEvent,
  context: MapEventContext,
): ReadonlyArray<ProviderRuntimeEvent> {
  const part = (event.properties as { part: { id: string; type: string } }).part;

  if (part.type === "reasoning") {
    session.reasoningPartIds.add(part.id);
    return [];
  }

  if (part.type !== "tool") {
    return [];
  }

  const toolPart = part as unknown as {
    id: string;
    type: "tool";
    tool: string;
    state: {
      status?: string;
      input?: unknown;
      output?: string;
      error?: string;
      metadata?: Record<string, unknown>;
      title?: string;
    };
    metadata?: Record<string, unknown>;
  };

  const toolState = toolPart.state?.status;
  const toolInput = toolPart.state?.input;
  const toolOutput = normalizeString(toolPart.state?.output);
  const toolError = normalizeString(toolPart.state?.error);
  const toolTitle =
    normalizeString(toolPart.state?.title) ??
    normalizeString(toolPart.metadata?.title) ??
    toolPart.tool;

  if (toolState === "pending" || toolState === "running") {
    return [
      {
        ...eventBase({
          eventId: context.stamp.eventId,
          createdAt: context.stamp.createdAt,
          threadId: session.threadId,
          ...(context.turnId ? { turnId: context.turnId } : {}),
          itemId: toolPart.id,
          raw: context.raw,
        }),
        type: "item.started",
        payload: {
          itemType: "dynamic_tool_call",
          status: "inProgress",
          title: toolTitle,
          ...(toolInput ? { data: toolInput } : {}),
        },
      },
    ];
  }

  if (toolState === "completed" || toolState === "error") {
    return [
      {
        ...eventBase({
          eventId: context.stamp.eventId,
          createdAt: context.stamp.createdAt,
          threadId: session.threadId,
          ...(context.turnId ? { turnId: context.turnId } : {}),
          itemId: toolPart.id,
          raw: context.raw,
        }),
        type: "item.completed",
        payload: {
          itemType: "dynamic_tool_call",
          status: toolState === "completed" ? "completed" : "failed",
          title: toolTitle,
          ...(toolOutput ? { detail: toolOutput } : {}),
          ...(toolError ? { detail: toolError } : {}),
          data: toolPart,
        },
      },
    ];
  }

  return [];
}

export function mapMessageUpdated(
  session: ActiveOpencodeSession,
  event: OpencodeEvent,
  context: MapEventContext,
): ReadonlyArray<ProviderRuntimeEvent> {
  const msg = (event.properties as { info: { role: string } }).info;
  if (msg.role !== "assistant") return [];

  const assistantMsg = msg as {
    id: string;
    role: "assistant";
    modelID?: string;
    providerID?: string;
    tokens?: {
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
    cost?: number;
    time?: { completed?: number };
  };

  if (assistantMsg.modelID) {
    session.model = assistantMsg.modelID;
  }
  if (assistantMsg.providerID) {
    session.providerID = assistantMsg.providerID;
  }

  if (assistantMsg.tokens) {
    const tokens = assistantMsg.tokens;
    const inputTokens = tokens.input ?? 0;
    const outputTokens = tokens.output ?? 0;
    const cachedInputTokens = tokens.cache?.read ?? 0;
    const usedTokens = inputTokens + outputTokens + cachedInputTokens;

    if (usedTokens > 0) {
      const usage: ThreadTokenUsageSnapshot = {
        usedTokens,
        totalProcessedTokens: usedTokens,
        ...(inputTokens > 0 ? { inputTokens, lastInputTokens: inputTokens } : {}),
        ...(cachedInputTokens > 0
          ? { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }
          : {}),
        ...(outputTokens > 0 ? { outputTokens, lastOutputTokens: outputTokens } : {}),
        ...(usedTokens > 0 ? { lastUsedTokens: usedTokens } : {}),
      };
      session.lastUsage = usage;

      return [
        {
          ...eventBase({
            eventId: context.stamp.eventId,
            createdAt: context.stamp.createdAt,
            threadId: session.threadId,
            ...(context.turnId ? { turnId: context.turnId } : {}),
            itemId: assistantMsg.id,
            raw: context.raw,
          }),
          type: "thread.token-usage.updated",
          payload: { usage },
        },
      ];
    }
  }

  if (assistantMsg.time?.completed) {
    return [
      {
        ...eventBase({
          eventId: context.stamp.eventId,
          createdAt: context.stamp.createdAt,
          threadId: session.threadId,
          ...(context.turnId ? { turnId: context.turnId } : {}),
          itemId: assistantMsg.id,
          raw: context.raw,
        }),
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
          data: assistantMsg,
        },
      },
    ];
  }

  return [];
}
