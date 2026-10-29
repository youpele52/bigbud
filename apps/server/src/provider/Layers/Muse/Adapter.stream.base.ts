import type { ProviderRuntimeEvent, ThreadId, TurnId } from "@bigbud/contracts";

let eventCounter = 0;

/** Shared canonical-event envelope for the Muse stream mappers. */
export function museEventBase(threadId: ThreadId, turnId?: string, itemId?: string) {
  eventCounter += 1;
  return {
    eventId: `muse-event-${Date.now()}-${eventCounter}` as ProviderRuntimeEvent["eventId"],
    provider: "muse" as const,
    threadId,
    createdAt: new Date().toISOString(),
    ...(turnId ? { turnId: turnId as TurnId } : {}),
    ...(itemId ? { itemId: itemId as ProviderRuntimeEvent["itemId"] } : {}),
  };
}
