import { EventId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type {
  GetSelectedThreadDetailResult,
  ThreadDetailMessage,
} from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import type {
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { describe, expect, it } from "vitest";

import { withMobileTooLargeNotice } from "./mobileRecordBounds.ts";
import { buildBoundedMobileThread } from "./mobileThread.bounded.ts";

const KB = 1024;
const AT = "2026-09-09T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("legacy-mobile-thread");

const shell = {
  id: threadId,
  projectId: ProjectId.makeUnsafe("legacy-mobile-project"),
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
} as unknown as OrchestrationThread;

function message(text: string, overrides: Partial<ThreadDetailMessage> = {}): ThreadDetailMessage {
  return {
    id: MessageId.makeUnsafe(`legacy-${text.slice(0, 8)}`),
    role: "assistant",
    text,
    attachments: [],
    attachmentsTruncated: false,
    turnId: null,
    streaming: false,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

const truncatedActivity: OrchestrationThreadActivity = {
  id: EventId.makeUnsafe("legacy-activity"),
  tone: "tool",
  kind: "tool.completed",
  summary: "Tool output",
  payload: {},
  turnId: null,
  sequence: 1,
  createdAt: AT,
  payloadTruncated: true,
  payloadLength: 300 * KB,
};

describe("buildBoundedMobileThread", () => {
  it("appends the too-large notice to truncated detail messages and keeps activity flags", () => {
    const preview = "p".repeat(64 * KB);
    const detail = {
      messages: [message(preview, { textTruncated: true, textLength: 400 * KB }), message("ok")],
      activities: [truncatedActivity],
      activePlan: null,
      checkpoints: [],
    } as unknown as GetSelectedThreadDetailResult;

    const thread = buildBoundedMobileThread(shell, detail);

    expect(thread.messages.map((entry) => entry.text)).toEqual([
      "ok",
      withMobileTooLargeNotice(preview, 400 * KB),
    ]);
    expect(thread.messages[1]?.text).toContain("(400 KB)");
    expect(thread.activities).toEqual([truncatedActivity]);
  });
});
