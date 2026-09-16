import type { ProviderRuntimeEvent } from "@bigbud/contracts/orchestration/providerRuntime.events.ts";

interface ResponseItem {
  text: string;
  completed: boolean;
}

/** Collect canonical assistant text independently of provider transport details. */
export function makeBackgroundReviewResponse(limit: number) {
  const items = new Map<string | symbol, ResponseItem>();
  // Events without item IDs share one slot; their snapshots replace that slot only.
  const unkeyedItem = Symbol("unkeyed assistant text");
  const seen = new Set<string>();
  // Bound replay bookkeeping even when a provider repeatedly revises a snapshot.
  const replayWindow = Math.max(1, limit);
  let length = 0;

  const append = (event: ProviderRuntimeEvent): boolean => {
    const delta =
      event.type === "content.delta" && event.payload.streamKind === "assistant_text"
        ? event.payload.delta
        : undefined;
    const snapshot =
      event.type === "item.completed" &&
      event.payload.itemType === "assistant_message" &&
      event.payload.detail?.trim()
        ? event.payload.detail
        : undefined;
    if (delta === undefined && snapshot === undefined) return true;
    if (seen.has(event.eventId)) return true;

    const key = event.itemId ?? unkeyedItem;
    const previous = items.get(key);
    if (snapshot === undefined && (previous?.completed || delta === "")) return true;
    const nextText = snapshot ?? `${previous?.text ?? ""}${delta}`;
    const nextLength = length - (previous?.text.length ?? 0) + nextText.length;
    if (nextLength > limit) return false;

    items.set(key, { text: nextText, completed: snapshot !== undefined });
    length = nextLength;
    seen.add(event.eventId);
    if (seen.size > replayWindow) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  };

  return {
    append,
    text: () => Array.from(items.values(), (item) => item.text).join(""),
  };
}
