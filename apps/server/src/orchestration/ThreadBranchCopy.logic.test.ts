import { MessageId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  BRANCH_COPY_BATCH,
  branchCopyBatchSize,
  branchCopyMessageId,
  failedBranchTitle,
  toBranchMessage,
} from "./ThreadBranchCopy.logic.ts";

const branch = ThreadId.makeUnsafe("branch");

describe("branch copy logic", () => {
  it("bounds a batch by count and text, but always takes one message", () => {
    expect(branchCopyBatchSize(Array(40).fill(10))).toBe(BRANCH_COPY_BATCH.maxMessages);
    expect(branchCopyBatchSize([BRANCH_COPY_BATCH.maxTextChars * 3, 1])).toBe(1);
    expect(branchCopyBatchSize([100_000, 100_000, 100_000])).toBe(2);
    expect(branchCopyBatchSize([])).toBe(0);
  });

  it("derives stable ids that keep the source order among equal timestamps", () => {
    const a = branchCopyMessageId(branch, "source-a");
    expect(branchCopyMessageId(branch, "source-a")).toBe(a);
    expect(a < branchCopyMessageId(branch, "source-b")).toBe(true);
    expect(branchCopyMessageId(ThreadId.makeUnsafe("other"), "source-a")).not.toBe(a);
  });

  it("copies the full message, points replies at the copy and drops the source turn", () => {
    const copied = toBranchMessage(branch, {
      messageId: MessageId.makeUnsafe("source-2"),
      threadId: ThreadId.makeUnsafe("source"),
      turnId: null,
      role: "assistant",
      text: "full text",
      replyTo: {
        messageId: MessageId.makeUnsafe("source-1"),
        role: "user",
        createdAt: "2026-01-01T00:00:00.000Z",
        excerpt: "question",
      },
      isStreaming: false,
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
    expect(copied).toMatchObject({
      id: branchCopyMessageId(branch, "source-2"),
      text: "full text",
      turnId: null,
      streaming: false,
      replyTo: { messageId: branchCopyMessageId(branch, "source-1") },
    });
  });

  it("marks a failed branch title once", () => {
    expect(failedBranchTitle(failedBranchTitle("Thread (A)"))).toBe("Thread (A) (incomplete copy)");
  });
});
