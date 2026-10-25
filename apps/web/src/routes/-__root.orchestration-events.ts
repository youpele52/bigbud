import { type OrchestrationEvent } from "@bigbud/contracts";

export function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    // Empty completions carry no authoritative text. Keep them separate so the
    // preceding streaming text remains an append delta before completion is applied.
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId &&
      !(previous.payload.streaming && !event.payload.streaming && event.payload.text.length === 0)
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}

export function shouldFlushOrchestrationEventImmediately(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.message-sent" &&
    event.payload.role === "assistant" &&
    event.payload.streaming
  );
}
