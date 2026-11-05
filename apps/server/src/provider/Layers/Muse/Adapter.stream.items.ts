import type { ProviderRuntimeEvent, ThreadId } from "@bigbud/contracts";
import { Option } from "effect";

import type { MuseLiveItem } from "./Adapter.types.ts";
import type { MuseNotification } from "./Client.ts";
import { decodeItem, type MuseItem } from "./Client.schema.ts";
import { museEventBase } from "./Adapter.stream.base.ts";

export function mapItemType(kind: string): string {
  switch (kind) {
    case "agentMessage":
      return "assistant_message";
    case "userMessage":
      return "user_message";
    case "reasoning":
      return "reasoning";
    case "toolCall":
      return "mcp_tool_call";
    default:
      return "unknown";
  }
}

function mapItemStatus(
  status: string | undefined,
): "inProgress" | "completed" | "failed" | "declined" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "declined":
      return "declined";
    default:
      return "inProgress";
  }
}

/** Reasoning summary parts arrive as strings or `{ text }` records. */
function summaryText(summary: unknown): string | undefined {
  if (typeof summary === "string") return summary;
  if (!Array.isArray(summary)) return undefined;
  const parts = summary.flatMap((part) =>
    typeof part === "string"
      ? [part]
      : part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
  );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function itemText(item: MuseItem): string | undefined {
  const text = item.kind === "reasoning" ? (item.text ?? summaryText(item.summary)) : item.text;
  return text?.trim() ? text : undefined;
}

/** Keeps the live-item index current; call after mapping each notification. */
export function trackMuseItem(items: Map<string, MuseLiveItem>, notification: MuseNotification) {
  if (notification.method === "item/started" || notification.method === "item/updated") {
    const item = decodeItem(notification.params?.item);
    if (Option.isSome(item)) {
      items.set(item.value.itemId, { kind: item.value.kind, turnId: item.value.turnId });
    }
  } else if (notification.method === "item/completed") {
    const item = decodeItem(notification.params?.item);
    if (Option.isSome(item)) items.delete(item.value.itemId);
  } else if (notification.method === "turn/completed" || notification.method === "turn/unqueued") {
    const turnId = notification.params?.turnId;
    for (const [itemId, item] of items) if (item.turnId === turnId) items.delete(itemId);
  }
}

/**
 * Routes an `item/delta` by the owning item's kind and the delta `field`:
 * agent `text` is assistant output, reasoning `summary.N` is a thinking
 * summary. Deltas of other items (e.g. reminder children) are not user-facing.
 */
function deltaStream(
  item: MuseLiveItem | undefined,
  field: unknown,
):
  | { readonly streamKind: "assistant_text" | "reasoning_text" }
  | { readonly streamKind: "reasoning_summary_text"; readonly summaryIndex: number }
  | undefined {
  const summary = typeof field === "string" ? /^summary\.(\d+)$/.exec(field) : null;
  if (summary && item?.kind !== "agentMessage") {
    return { streamKind: "reasoning_summary_text", summaryIndex: Number(summary[1]) };
  }
  if (field !== undefined && field !== "text") return undefined;
  if (item === undefined || item.kind === "agentMessage") return { streamKind: "assistant_text" };
  if (item.kind === "reasoning") return { streamKind: "reasoning_text" };
  return undefined;
}

/**
 * Item lifecycle and delta mapping. Completed items are authoritative:
 * their full text travels as `detail` so canonical ingestion replaces
 * accumulated deltas instead of appending twice.
 */
export function mapMuseItemNotification(
  threadId: ThreadId,
  notification: MuseNotification,
  items: ReadonlyMap<string, MuseLiveItem> = new Map(),
): ReadonlyArray<ProviderRuntimeEvent> {
  const params = notification.params ?? {};
  switch (notification.method) {
    case "item/started":
    case "item/updated":
    case "item/completed": {
      const item = decodeItem(params.item);
      if (Option.isNone(item)) return [];
      const type =
        notification.method === "item/started"
          ? "item.started"
          : notification.method === "item/updated"
            ? "item.updated"
            : "item.completed";
      const text = itemText(item.value);
      return [
        {
          ...museEventBase(threadId, item.value.turnId, item.value.itemId),
          type,
          payload: {
            itemType: mapItemType(item.value.kind),
            status: mapItemStatus(item.value.status),
            ...(text ? { detail: text } : {}),
            data: { nativeKind: item.value.kind },
          },
        } as ProviderRuntimeEvent,
      ];
    }
    case "item/delta": {
      if (typeof params.delta !== "string" || typeof params.itemId !== "string") return [];
      const item = items.get(params.itemId);
      const stream = deltaStream(item, params.field);
      if (!stream) return [];
      return [
        {
          ...museEventBase(threadId, item?.turnId, params.itemId),
          type: "content.delta",
          payload: { ...stream, delta: params.delta },
        } as ProviderRuntimeEvent,
      ];
    }
    default:
      return [];
  }
}
