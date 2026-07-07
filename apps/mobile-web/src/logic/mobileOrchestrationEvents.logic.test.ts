import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  applyOrchestrationEventToSnapshot,
  applyOrchestrationEventToThread,
} from "./mobileOrchestrationEvents.logic";

const threadId = ThreadId.makeUnsafe("thread-1");
const projectId = ProjectId.makeUnsafe("project-1");
const turnId = TurnId.makeUnsafe("turn-1");
const messageId = MessageId.makeUnsafe("message-1");

function makeThread(): OrchestrationThread {
  return {
    id: threadId,
    projectId,
    title: "Thread",
    elevatorSummary: "Thread",
    elevatorSummaryMessageCount: 0,
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    deletingAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    watchingThreads: [],
  };
}

function makeMessageSentEvent(
  text: string,
  streaming: boolean,
): Extract<OrchestrationEvent, { type: "thread.message-sent" }> {
  return {
    type: "thread.message-sent",
    sequence: 1,
    occurredAt: "2026-01-01T00:00:01.000Z",
    commandId: CommandId.makeUnsafe("command-1"),
    eventId: EventId.makeUnsafe("event-1"),
    aggregateKind: "thread",
    aggregateId: threadId,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      messageId,
      role: "assistant",
      text,
      turnId,
      streaming,
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    },
  };
}

describe("mobileOrchestrationEvents.logic", () => {
  it("appends streaming assistant deltas to the same message", () => {
    const thread = makeThread();
    const first = applyOrchestrationEventToThread(thread, makeMessageSentEvent("Hel", true));
    const second = applyOrchestrationEventToThread(first!, makeMessageSentEvent("lo", true));

    expect(second?.messages).toHaveLength(1);
    expect(second?.messages[0]?.text).toBe("Hello");
    expect(second?.messages[0]?.streaming).toBe(true);
  });

  it("updates snapshot threads incrementally", () => {
    const snapshot: OrchestrationReadModel = {
      snapshotSequence: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      projects: [],
      threads: [makeThread()],
    };
    const next = applyOrchestrationEventToSnapshot(snapshot, makeMessageSentEvent("Done", false));

    expect(next.changed).toBe(true);
    expect(next.snapshot.threads[0]?.messages[0]?.text).toBe("Done");
    expect(next.snapshot.threads[0]?.messages[0]?.streaming).toBe(false);
  });

  it("replaces the final assistant message content when the event requests replacement", () => {
    const thread = applyOrchestrationEventToThread(makeThread(), makeMessageSentEvent("Hel", true));
    const finalEvent = makeMessageSentEvent("Hello", false);
    const next = applyOrchestrationEventToThread(thread!, {
      ...finalEvent,
      payload: {
        ...finalEvent.payload,
        replace: true,
      },
    });

    expect(next?.messages).toHaveLength(1);
    expect(next?.messages[0]?.text).toBe("Hello");
    expect(next?.messages[0]?.streaming).toBe(false);
  });

  it("normalizes stale running session updates back to ready once the assistant message completed", () => {
    const thread = applyOrchestrationEventToThread(
      makeThread(),
      makeMessageSentEvent("Done", false),
    );
    const next = applyOrchestrationEventToThread(thread!, {
      type: "thread.session-set",
      sequence: 2,
      occurredAt: "2026-01-01T00:00:02.000Z",
      commandId: CommandId.makeUnsafe("command-2"),
      eventId: EventId.makeUnsafe("event-2"),
      aggregateKind: "thread",
      aggregateId: threadId,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: turnId,
          lastError: null,
          reason: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
      },
    });

    expect(next?.session?.status).toBe("ready");
    expect(next?.session?.activeTurnId).toBeNull();
  });
});
