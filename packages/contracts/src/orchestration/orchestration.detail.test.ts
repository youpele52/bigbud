import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  GetSelectedThreadDetailInput,
  GetSelectedThreadDetailResult,
} from "./orchestration.detail";

it.effect("decodes the structured older-message cursor", () =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(GetSelectedThreadDetailInput)({
      threadId: "thread-1",
      messageLimit: 25,
      messageCursor: { createdAt: "2026-01-02", messageId: "message-2" },
    });
    assert.deepEqual(input.messageCursor, {
      createdAt: "2026-01-02",
      messageId: "message-2",
    });
  }),
);

it.effect("decodes explicit newest-first thread detail window bounds", () =>
  Effect.gen(function* () {
    const result = yield* Schema.decodeUnknownEffect(GetSelectedThreadDetailResult)({
      projectionSequence: 12,
      threadId: "thread-1",
      projectId: "project-1",
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
      pendingUserInputs: [
        {
          requestId: "input-1",
          turnId: null,
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Continue?",
              options: [{ label: "Yes", description: "Continue" }],
              multiSelect: false,
            },
          ],
          questionsTruncated: false,
          createdAt: "2026-01-01",
        },
      ],
      pendingUserInputsTruncated: false,
      activePlan: null,
      activeTasks: [],
      activeTasksTruncated: false,
      checkpoints: [],
      checkpointsTruncated: false,
    });
    assert.equal(result.messageWindow.order, "newest-first");
    assert.equal(result.threadId, "thread-1");
    assert.equal(result.pendingUserInputs[0]?.questions[0]?.id, "choice");
  }),
);
