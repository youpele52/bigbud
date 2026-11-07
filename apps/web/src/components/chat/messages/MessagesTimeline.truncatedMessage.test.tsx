import { MessageId, ThreadId, TurnId } from "@bigbud/contracts";
import {
  THREAD_DETAIL_TEXT_PREVIEW_LENGTH,
  THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD,
} from "@bigbud/contracts/orchestration/orchestration.detail.ts";
import {
  MESSAGE_TEXT_CHUNK_MAX_LENGTH,
  type GetMessageTextChunkInput,
} from "@bigbud/contracts/orchestration/orchestration.detail.paging.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { applyOrchestrationEvent } from "~/stores/main/events.store";
import { makeEvent, makeState, makeThread } from "~/stores/main/main.store.test.helpers";
import {
  loadNextMessageTextChunk,
  readFullMessageText,
  TimelineThreadIdContext,
} from "./MessagesTimeline.truncatedMessage";
import { TruncatedMessageNotice } from "./MessagesTimeline.truncatedMessageNotice";

const threadId = ThreadId.makeUnsafe("thread-1");
const messageId = MessageId.makeUnsafe("message-long");
const fullText = "x".repeat(MESSAGE_TEXT_CHUNK_MAX_LENGTH * 2 + 10);

function chunkApi() {
  return {
    getMessageTextChunk: vi.fn(async (input: GetMessageTextChunkInput) => {
      const end = Math.min(fullText.length, input.offset + (input.limit ?? 0));
      return {
        threadId,
        messageId,
        offset: input.offset,
        text: fullText.slice(input.offset, end),
        textLength: fullText.length,
        nextOffset: end < fullText.length ? end : null,
      };
    }),
  };
}

describe("truncated messages", () => {
  it("offers Show full message for a truncated message only", () => {
    const render = (textTruncated: boolean) =>
      renderToStaticMarkup(
        <TimelineThreadIdContext.Provider value={threadId}>
          <TruncatedMessageNotice
            message={{
              id: messageId,
              role: "assistant",
              text: "preview",
              createdAt: "2026-01-01T00:00:00.000Z",
              streaming: false,
              ...(textTruncated ? { textTruncated: true, textLength: 2 * 1024 * 1024 } : {}),
            }}
          />
        </TimelineThreadIdContext.Provider>,
      );

    expect(render(true)).toContain("Show full message");
    expect(render(true)).toContain("Showing part of a 2.0 MB message.");
    expect(render(false)).toBe("");
  });

  it("loads the rest one bounded chunk at a time, starting over from offset 0", async () => {
    const api = chunkApi();
    const first = await loadNextMessageTextChunk({ api, threadId, messageId, loaded: null });
    const second = await loadNextMessageTextChunk({ api, threadId, messageId, loaded: first });

    expect(api.getMessageTextChunk.mock.calls.map(([input]) => input)).toEqual([
      { threadId, messageId, offset: 0, limit: MESSAGE_TEXT_CHUNK_MAX_LENGTH },
      {
        threadId,
        messageId,
        offset: MESSAGE_TEXT_CHUNK_MAX_LENGTH,
        limit: MESSAGE_TEXT_CHUNK_MAX_LENGTH,
      },
    ]);
    expect(second.text).toBe(fullText.slice(0, MESSAGE_TEXT_CHUNK_MAX_LENGTH * 2));
    expect(second.nextOffset).toBe(MESSAGE_TEXT_CHUNK_MAX_LENGTH * 2);
  });

  it("copies the full text through the chunk RPC", async () => {
    const api = chunkApi();
    await expect(readFullMessageText({ api, threadId, messageId })).resolves.toBe(fullText);
    expect(api.getMessageTextChunk).toHaveBeenCalledTimes(3);
  });

  it("truncates a streaming message in the store once it passes 256 KB", () => {
    const turnId = TurnId.makeUnsafe("turn-1");
    const delta = (text: string, streaming = true) =>
      makeEvent("thread.message-sent", {
        threadId,
        messageId,
        role: "assistant",
        text,
        turnId,
        streaming,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    const half = "y".repeat(THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD / 2);
    let state = makeState(makeThread({ id: threadId }));
    state = applyOrchestrationEvent(state, delta(half));
    state = applyOrchestrationEvent(state, delta(half));
    expect(state.threads[0]?.messages[0]?.textTruncated).toBeUndefined();

    state = applyOrchestrationEvent(state, delta("z"));
    const truncated = state.threads[0]?.messages[0];
    expect(truncated?.textTruncated).toBe(true);
    expect(truncated?.text).toHaveLength(THREAD_DETAIL_TEXT_PREVIEW_LENGTH);
    expect(truncated?.textLength).toBe(THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD + 1);

    state = applyOrchestrationEvent(state, delta("more"));
    expect(state.threads[0]?.messages[0]?.text).toHaveLength(THREAD_DETAIL_TEXT_PREVIEW_LENGTH);
    expect(state.threads[0]?.messages[0]?.textLength).toBe(
      THREAD_DETAIL_TEXT_TRUNCATE_THRESHOLD + 5,
    );

    // A short final replacement clears the flag again.
    state = applyOrchestrationEvent(state, delta("final answer", false));
    expect(state.threads[0]?.messages[0]).toMatchObject({ text: "final answer", streaming: false });
    expect(state.threads[0]?.messages[0]?.textTruncated).toBeUndefined();
  });
});
