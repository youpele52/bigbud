let inboundActivitySequence = 0;
let lastInboundActivityAt: number | null = null;

export function markWsInboundActivity(): void {
  inboundActivitySequence += 1;
  lastInboundActivityAt = Date.now();
}

export function getWsInboundActivitySequence(): number {
  return inboundActivitySequence;
}

export function hasWsInboundActivitySince(sequence: number): boolean {
  return inboundActivitySequence > sequence;
}

/** Milliseconds since the last inbound value, or null before the first one. */
export function getMsSinceLastWsInboundActivity(now = Date.now()): number | null {
  return lastInboundActivityAt === null ? null : Math.max(0, now - lastInboundActivityAt);
}
