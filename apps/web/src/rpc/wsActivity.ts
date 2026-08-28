let inboundActivitySequence = 0;

export function markWsInboundActivity(): void {
  inboundActivitySequence += 1;
}

export function getWsInboundActivitySequence(): number {
  return inboundActivitySequence;
}

export function hasWsInboundActivitySince(sequence: number): boolean {
  return inboundActivitySequence > sequence;
}
