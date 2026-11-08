import {
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type GetSelectedThreadDetailResult,
  type ThreadDetailMessage,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { MAX_THREAD_ACTIVITIES, MAX_THREAD_MESSAGES } from "./helpers.store";
import { mergeThreadDetail } from "./mappers.lazy.store";
import { makeThread } from "./main.store.test.helpers";

const threadId = ThreadId.makeUnsafe("thread-1");

function iso(index: number): string {
  return new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
}

function detailMessage(index: number, overrides: Partial<ThreadDetailMessage> = {}) {
  return {
    id: MessageId.makeUnsafe(`message-${String(index).padStart(5, "0")}`),
    role: "user",
    text: `message ${index}`,
    attachments: [],
    attachmentsTruncated: false,
    turnId: null,
    streaming: false,
    createdAt: iso(index),
    updatedAt: iso(index),
    ...overrides,
  } satisfies ThreadDetailMessage;
}

function detail(overrides: Partial<GetSelectedThreadDetailResult>): GetSelectedThreadDetailResult {
  return {
    projectionSequence: 1,
    threadId,
    projectId: ProjectId.makeUnsafe("project-1"),
    activityTurnId: null,
    messages: [],
    messageWindow: {
      order: "newest-first",
      requestedCursor: null,
      newestCursor: null,
      oldestCursor: null,
      nextCursor: null,
      hasOlder: false,
    },
    activities: [],
    activitiesTruncated: false,
    pendingApprovals: [],
    pendingApprovalsTruncated: false,
    pendingUserInputs: [],
    pendingUserInputsTruncated: false,
    activePlan: null,
    activeTasks: [],
    activeTasksTruncated: false,
    checkpoints: [],
    checkpointsTruncated: false,
    ...overrides,
  };
}

describe("mergeThreadDetail caps", () => {
  it("keeps the newest MAX_THREAD_MESSAGES messages, deduplicated by id", () => {
    const existing = Array.from({ length: MAX_THREAD_MESSAGES }, (_, index) =>
      detailMessage(index + 10),
    ).map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      turnId: null,
      createdAt: message.createdAt,
      streaming: false,
    }));
    const thread = makeThread({ id: threadId, messages: existing });
    // One overlapping message (index 10) and ten genuinely newer ones.
    const page = [10, ...Array.from({ length: 10 }, (_, index) => MAX_THREAD_MESSAGES + 20 + index)]
      .map((index) => detailMessage(index))
      .toReversed();

    const merged = mergeThreadDetail(thread, detail({ messages: page }), false);

    expect(merged.messages).toHaveLength(MAX_THREAD_MESSAGES);
    expect(new Set(merged.messages.map((message) => message.id)).size).toBe(MAX_THREAD_MESSAGES);
    expect(merged.messages.at(-1)?.id).toBe(page[0]!.id);
    expect(merged.messages.some((message) => message.id === "message-00010")).toBe(false);
  });

  it("caps activities like live events while keeping question history", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const activities = Array.from({ length: MAX_THREAD_ACTIVITIES + 50 }, (_, index) => ({
      id: EventId.makeUnsafe(`activity-${String(index).padStart(5, "0")}`),
      tone: "tool" as const,
      kind: "tool.completed",
      summary: "Tool",
      payload: {},
      turnId,
      createdAt: iso(index),
    }));
    const question = {
      id: EventId.makeUnsafe("question-0"),
      tone: "info" as const,
      kind: "user-input.requested",
      summary: "Question",
      payload: { requestId: "request-1", questions: [] },
      turnId,
      createdAt: iso(-1),
    };

    const merged = mergeThreadDetail(
      makeThread({ id: threadId }),
      detail({ activities: [question, ...activities] }),
      false,
    );

    expect(merged.activities.length).toBe(MAX_THREAD_ACTIVITIES + 1);
    expect(merged.activities[0]?.id).toBe("question-0");
    expect(merged.activities.at(-1)?.id).toBe(activities.at(-1)!.id);
  });

  it("carries the server's truncation flags onto the stored message", () => {
    const merged = mergeThreadDetail(
      makeThread({ id: threadId }),
      detail({
        messages: [detailMessage(1, { text: "preview", textTruncated: true, textLength: 400_000 })],
      }),
      false,
    );

    expect(merged.messages[0]).toMatchObject({
      text: "preview",
      textTruncated: true,
      textLength: 400_000,
    });
  });
});
