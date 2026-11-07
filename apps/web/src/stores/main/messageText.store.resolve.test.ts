import { MessageId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { resolveFullMessageText } from "./messageText.store";

const threadId = ThreadId.makeUnsafe("thread-1");
const id = MessageId.makeUnsafe("message-1");

describe("resolveFullMessageText", () => {
  it("returns the stored text without a request when it is complete", async () => {
    const getMessageTextChunk = vi.fn();
    await expect(
      resolveFullMessageText(
        threadId,
        { id, text: "whole" },
        { orchestration: { getMessageTextChunk } },
      ),
    ).resolves.toBe("whole");
    expect(getMessageTextChunk).not.toHaveBeenCalled();
  });

  it("reads a truncated message from the server", async () => {
    const getMessageTextChunk = vi.fn(async () => ({
      threadId,
      messageId: id,
      offset: 0,
      text: "the full text",
      textLength: 13,
      nextOffset: null,
    }));
    await expect(
      resolveFullMessageText(
        threadId,
        { id, text: "the", textTruncated: true },
        { orchestration: { getMessageTextChunk } },
      ),
    ).resolves.toBe("the full text");
  });

  it("rejects when a text never finishes rather than returning part of it", async () => {
    const getMessageTextChunk = vi.fn(async () => ({
      threadId,
      messageId: id,
      offset: 0,
      text: "x",
      textLength: 1,
      nextOffset: 1,
    }));
    await expect(
      resolveFullMessageText(
        threadId,
        { id, text: "x", textTruncated: true },
        { orchestration: { getMessageTextChunk } },
      ),
    ).rejects.toThrow("kept growing");
  });
});
