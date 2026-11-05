import { EventId, MessageId, type OrchestrationEvent, type ThreadId } from "@bigbud/contracts";
import { THREAD_ID, createSnapshotForTargetUser } from "./fixtures";

export function makeThreadDeletedEvent(
  threadId: ThreadId,
  sequence: number,
): Extract<OrchestrationEvent, { type: "thread.deleted" }> {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-thread-deleted-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: `2026-03-04T12:00:0${sequence}.000Z`,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.deleted",
    payload: {
      threadId,
      deletedAt: `2026-03-04T12:00:0${sequence}.000Z`,
    },
  };
}

export function createProjectSnapshotWithThreadCount(threadCount: number) {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-project-overflow-target" as never,
    targetText: "project overflow test",
  });

  return {
    ...snapshot,
    threads: Array.from({ length: threadCount }, (_, index) => ({
      ...snapshot.threads[0]!,
      id: `thread-project-overflow-${index + 1}` as ThreadId,
      title: `Project thread ${index + 1}`,
      createdAt: `2026-03-04T12:00:${String(index).padStart(2, "0")}.000Z`,
      updatedAt: `2026-03-04T12:00:${String(index).padStart(2, "0")}.000Z`,
      messages: [],
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      latestTurn: null,
      session: null,
    })),
  };
}

export function createPlaceholderThreadSnapshot() {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-placeholder-thread-target" as never,
    targetText: "placeholder thread test",
  });
  const threads = [...snapshot.threads];
  const threadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
  if (threadIndex >= 0) {
    threads[threadIndex] = {
      ...threads[threadIndex]!,
      title: "New thread",
      messages: [],
      activities: [],
      proposedPlans: [],
      latestTurn: null,
      session: null,
    };
  }

  return {
    ...snapshot,
    threads,
  };
}

export function createReplyThreadSnapshot() {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-reply-bootstrap" as MessageId,
    targetText: "reply bootstrap",
  });
  const thread = snapshot.threads[0]!;
  const messages: typeof thread.messages = [
    {
      id: "msg-user-reply-source" as MessageId,
      role: "user",
      text: "Original user message",
      turnId: null,
      streaming: false,
      createdAt: "2026-03-04T12:00:00.000Z",
      updatedAt: "2026-03-04T12:00:01.000Z",
    },
    {
      id: "msg-assistant-reply-source" as MessageId,
      role: "assistant",
      text: "Original assistant answer",
      turnId: null,
      streaming: false,
      createdAt: "2026-03-04T12:00:02.000Z",
      updatedAt: "2026-03-04T12:00:03.000Z",
    },
  ];

  return {
    ...snapshot,
    threads: [
      {
        ...thread,
        messages,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        latestTurn: null,
        session: null,
      },
    ],
  };
}
