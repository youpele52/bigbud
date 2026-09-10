import type { OrchestrationEvent } from "@bigbud/contracts";

export const MAX_CLIENT_RECOVERY_EVENTS = 2_000;
export const MAX_CLIENT_RECOVERY_BYTES = 4 * 1024 * 1024;

export type RecoveryEventTrackingResult =
  | "accepted"
  | "duplicate"
  | "identity-mismatch"
  | "sequence-gap"
  | "overflow";

function eventIdentity(event: OrchestrationEvent): string {
  return `${event.eventId}\u0000${event.type}`;
}

function serializedBytes(event: OrchestrationEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength;
}

export function createMobileRecoveryEventTracker() {
  const bySequence = new Map<
    number,
    { readonly eventId: string; readonly type: string; readonly bytes: number }
  >();
  const byIdentity = new Map<string, number>();
  let totalBytes = 0;

  function reset() {
    bySequence.clear();
    byIdentity.clear();
    totalBytes = 0;
  }

  function evictOldest() {
    const oldest = bySequence.entries().next().value;
    if (oldest === undefined) return false;
    const [sequence, identity] = oldest;
    bySequence.delete(sequence);
    byIdentity.delete(`${identity.eventId}\u0000${identity.type}`);
    totalBytes -= identity.bytes;
    return true;
  }

  function track(
    event: OrchestrationEvent,
    throughSequence: number,
    allowEviction: boolean,
  ): RecoveryEventTrackingResult {
    const previous = bySequence.get(event.sequence);
    if (event.sequence <= throughSequence) {
      if (previous?.eventId === event.eventId && previous.type === event.type) {
        return "duplicate";
      }
      return "identity-mismatch";
    }
    if (event.sequence !== throughSequence + 1) return "sequence-gap";

    const identity = eventIdentity(event);
    const previousSequence = byIdentity.get(identity);
    if (previousSequence !== undefined && previousSequence !== event.sequence) {
      return "identity-mismatch";
    }

    const bytes = serializedBytes(event);
    if (bytes > MAX_CLIENT_RECOVERY_BYTES) return "overflow";
    if (allowEviction) {
      while (
        bySequence.size >= MAX_CLIENT_RECOVERY_EVENTS ||
        totalBytes + bytes > MAX_CLIENT_RECOVERY_BYTES
      ) {
        if (!evictOldest()) break;
      }
    }
    if (
      bySequence.size >= MAX_CLIENT_RECOVERY_EVENTS ||
      totalBytes + bytes > MAX_CLIENT_RECOVERY_BYTES
    ) {
      return "overflow";
    }

    bySequence.set(event.sequence, { eventId: event.eventId, type: event.type, bytes });
    byIdentity.set(identity, event.sequence);
    totalBytes += bytes;
    return "accepted";
  }

  return { reset, track } as const;
}
