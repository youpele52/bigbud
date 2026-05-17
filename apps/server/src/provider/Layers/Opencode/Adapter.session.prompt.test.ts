import { afterEach, describe, expect, it, vi } from "vitest";

import { sendPromptAsyncAndWaitForCompletion } from "./Adapter.session.prompt.ts";

describe("sendPromptAsyncAndWaitForCompletion", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not fail long-running turns solely because they exceed ten minutes", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-05-17T10:00:00.000Z");
    vi.setSystemTime(startedAt);

    let promptDispatched = false;
    const client = {
      session: {
        promptAsync: vi.fn(async () => {
          promptDispatched = true;
          return {
            data: {},
            error: undefined,
          };
        }),
        messages: vi.fn(async () => {
          if (!promptDispatched) {
            return {
              data: [],
              error: undefined,
            };
          }

          if (Date.now() - startedAt.getTime() < 11 * 60_000) {
            return {
              data: [],
              error: undefined,
            };
          }

          return {
            data: [
              {
                info: {
                  id: "assistant-message-1",
                  role: "assistant",
                  time: {
                    completed: Date.now(),
                  },
                },
                parts: [
                  {
                    id: "text-part-1",
                    type: "text",
                    text: "done",
                  },
                ],
              },
            ],
            error: undefined,
          };
        }),
      },
    } as never;

    const replyPromise = sendPromptAsyncAndWaitForCompletion({
      client,
      sessionID: "session-1",
      parts: [{ type: "text", text: "Run the full test suite and wait for it to finish." }],
      system: "system",
      turnStillActive: () => true,
    });

    await vi.advanceTimersByTimeAsync(11 * 60_000 + 1_000);

    await expect(replyPromise).resolves.toMatchObject({
      info: {
        id: "assistant-message-1",
        role: "assistant",
      },
      parts: [
        {
          id: "text-part-1",
          type: "text",
          text: "done",
        },
      ],
    });
  });
});
