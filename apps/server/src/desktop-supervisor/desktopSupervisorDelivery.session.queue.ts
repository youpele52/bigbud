import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

import type { AsyncBoundedChannel } from "./desktopSupervisorChannel.ts";
import {
  DESKTOP_SUPERVISOR_BATCH_EVENT_CAPACITY,
  DESKTOP_SUPERVISOR_BATCH_PAYLOAD_CAPACITY_BYTES,
} from "./desktopSupervisorConfig.ts";

const textEncoder = new TextEncoder();

export function collectDeliveryBatch(input: {
  readonly first: OrchestrationEvent;
  readonly channel: AsyncBoundedChannel<OrchestrationEvent>;
  readonly pending: Map<number, OrchestrationEvent>;
  readonly deliverySequence: number;
}): ReadonlyArray<OrchestrationEvent> {
  const events = [input.first];
  let payloadBytes = encodedSize(input.first);
  while (events.length < DESKTOP_SUPERVISOR_BATCH_EVENT_CAPACITY) {
    const expectedSequence = events.at(-1)!.sequence + 1;
    const pending = input.pending.get(expectedSequence);
    const candidate = pending ?? input.channel.tryTake();
    if (!candidate) break;
    if (pending) input.pending.delete(expectedSequence);
    if (candidate.sequence !== expectedSequence) {
      if (candidate.sequence > input.deliverySequence) {
        input.pending.set(candidate.sequence, candidate);
      }
      continue;
    }
    const candidateBytes = encodedSize(candidate);
    if (payloadBytes + candidateBytes > DESKTOP_SUPERVISOR_BATCH_PAYLOAD_CAPACITY_BYTES) {
      input.pending.set(candidate.sequence, candidate);
      break;
    }
    events.push(candidate);
    payloadBytes += candidateBytes;
  }
  return events;
}

function encodedSize(event: OrchestrationEvent): number {
  return textEncoder.encode(JSON.stringify(event)).byteLength;
}
