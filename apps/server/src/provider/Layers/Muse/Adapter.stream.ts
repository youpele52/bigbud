import type { ProviderRuntimeEvent, ThreadId } from "@bigbud/contracts";

import type { MuseLiveItem } from "./Adapter.types.ts";
import type { MuseNotification } from "./Client.ts";
import { mapMuseItemNotification } from "./Adapter.stream.items.ts";
import { mapMuseTurnNotification } from "./Adapter.stream.turns.ts";

export { mapItemType } from "./Adapter.stream.items.ts";
export { mapTerminalState } from "./Adapter.stream.turns.ts";

/**
 * Single dispatcher for native MSP notifications, delegating turn lifecycle
 * to Adapter.stream.turns.ts and item lifecycle to Adapter.stream.items.ts.
 * Unknown notifications produce no canonical events.
 */
export function mapMuseNotification(
  threadId: ThreadId,
  notification: MuseNotification,
  items: ReadonlyMap<string, MuseLiveItem> = new Map(),
): ReadonlyArray<ProviderRuntimeEvent> {
  if (notification.method.startsWith("turn/")) {
    return mapMuseTurnNotification(threadId, notification);
  }
  if (notification.method.startsWith("item/")) {
    return mapMuseItemNotification(threadId, notification, items);
  }
  return [];
}
