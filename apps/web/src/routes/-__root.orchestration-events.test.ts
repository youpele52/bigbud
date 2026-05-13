import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  coalesceOrchestrationUiEvents,
  shouldFlushOrchestrationEventImmediately,
} from "./-__root.orchestration-events";

function makeThreadMessageSentEvent(input: {
  text: string;
  streaming: boolean;
}): OrchestrationEvent {
  return {
    eventId: EventId.makeUnsafe("event-1"),
    sequence: 1,
    aggregateKind: "thread",
    aggregateId: ThreadId.makeUnsafe("thread-1"),
    occurredAt: "2026-05-12T12:00:00.000Z",
    commandId: CommandId.makeUnsafe("command-1"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.message-sent",
    payload: {
      threadId: ThreadId.makeUnsafe("thread-1"),
      messageId: MessageId.makeUnsafe("assistant-1"),
      role: "assistant",
      text: input.text,
      turnId: null,
      streaming: input.streaming,
      createdAt: "2026-05-12T12:00:00.000Z",
      updatedAt: "2026-05-12T12:00:00.000Z",
    },
  };
}

describe("__root orchestration event helpers", () => {
  it("marks streaming assistant messages for immediate flush", () => {
    expect(
      shouldFlushOrchestrationEventImmediately(
        makeThreadMessageSentEvent({ text: "hello", streaming: true }),
      ),
    ).toBe(true);
    expect(
      shouldFlushOrchestrationEventImmediately(
        makeThreadMessageSentEvent({ text: "hello", streaming: false }),
      ),
    ).toBe(false);
  });

  it("coalesces consecutive assistant deltas for the same message", () => {
    const events = coalesceOrchestrationUiEvents([
      makeThreadMessageSentEvent({ text: "hello", streaming: true }),
      {
        ...makeThreadMessageSentEvent({ text: " world", streaming: true }),
        eventId: EventId.makeUnsafe("event-2"),
        sequence: 2,
        occurredAt: "2026-05-12T12:00:01.000Z",
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("thread.message-sent");
    if (events[0]?.type !== "thread.message-sent") {
      return;
    }
    expect(events[0].payload.text).toBe("hello world");
    expect(events[0].payload.streaming).toBe(true);
  });
});
