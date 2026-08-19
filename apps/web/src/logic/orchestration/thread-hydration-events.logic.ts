import { ThreadId, type OrchestrationEvent } from "@bigbud/contracts";
import { useStore } from "../../stores/main";
import { getDeletedThreadIds } from "./thread-deletion.logic";

interface ActiveHydration {
  readonly token: number;
  readonly eventsBySequence: Map<number, OrchestrationEvent>;
}

export interface ThreadHydrationEventBuffer {
  begin: (threadId: ThreadId) => number;
  bufferEvent: (event: OrchestrationEvent) => boolean;
  finish: (
    threadId: ThreadId,
    token: number,
    projectionSequence: number,
  ) => ReadonlyArray<OrchestrationEvent> | null;
  fail: (threadId: ThreadId, token: number) => ReadonlyArray<OrchestrationEvent> | null;
  clear: () => void;
}

function eventThreadIds(event: OrchestrationEvent): readonly ThreadId[] {
  if (event.type === "thread.deleted") {
    return getDeletedThreadIds(event.payload);
  }
  if ("threadId" in event.payload && typeof event.payload.threadId === "string") {
    return [event.payload.threadId];
  }
  return event.aggregateKind === "thread" ? [ThreadId.makeUnsafe(event.aggregateId)] : [];
}

function eventThreadId(event: OrchestrationEvent): ThreadId | null {
  if ("threadId" in event.payload && typeof event.payload.threadId === "string") {
    return event.payload.threadId;
  }
  return event.aggregateKind === "thread" ? ThreadId.makeUnsafe(event.aggregateId) : null;
}

export function createThreadHydrationEventBuffer(): ThreadHydrationEventBuffer {
  const activeByThreadId = new Map<ThreadId, ActiveHydration>();
  let nextToken = 1;

  const take = (threadId: ThreadId, token: number, projectionSequence: number) => {
    const active = activeByThreadId.get(threadId);
    if (!active || active.token !== token) {
      return null;
    }
    activeByThreadId.delete(threadId);
    return [...active.eventsBySequence.values()]
      .filter((event) => event.sequence > projectionSequence)
      .toSorted((left, right) => left.sequence - right.sequence);
  };

  return {
    begin: (threadId) => {
      const token = nextToken++;
      const previous = activeByThreadId.get(threadId);
      activeByThreadId.set(threadId, {
        token,
        eventsBySequence: previous?.eventsBySequence ?? new Map(),
      });
      return token;
    },
    bufferEvent: (event) => {
      const primaryThreadId = eventThreadId(event);
      let bufferedPrimaryEvent = false;
      for (const threadId of eventThreadIds(event)) {
        const active = activeByThreadId.get(threadId);
        if (!active) {
          continue;
        }
        active.eventsBySequence.set(event.sequence, event);
        if (threadId === primaryThreadId) {
          bufferedPrimaryEvent = true;
        }
      }
      return bufferedPrimaryEvent;
    },
    finish: (threadId, token, projectionSequence) => take(threadId, token, projectionSequence),
    fail: (threadId, token) => take(threadId, token, -1),
    clear: () => activeByThreadId.clear(),
  };
}

export const threadHydrationEventBuffer = createThreadHydrationEventBuffer();

let applyReleasedEvents: (events: ReadonlyArray<OrchestrationEvent>) => void = (events) => {
  useStore.getState().applyOrchestrationEvents(events);
};

export function setThreadHydrationEventApplier(
  applier: ((events: ReadonlyArray<OrchestrationEvent>) => void) | null,
): void {
  applyReleasedEvents =
    applier ??
    ((events) => {
      useStore.getState().applyOrchestrationEvents(events);
    });
}

export function applyReleasedThreadHydrationEvents(
  events: ReadonlyArray<OrchestrationEvent> | null,
): void {
  if (events !== null && events.length > 0) {
    applyReleasedEvents(events);
  }
}
