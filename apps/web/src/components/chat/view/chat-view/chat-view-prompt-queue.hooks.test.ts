import { describe, expect, it } from "vitest";

import { shouldQueuePromptWhileWorking } from "./chat-view-prompt-queue.hooks";

describe("shouldQueuePromptWhileWorking", () => {
  it("queues prompts while the agent is working", () => {
    expect(
      shouldQueuePromptWhileWorking({
        isWorking: true,
        forceSendQueuedPrompt: false,
      }),
    ).toBe(true);
  });

  it("does not queue prompts on idle threads", () => {
    expect(
      shouldQueuePromptWhileWorking({
        isWorking: false,
        forceSendQueuedPrompt: false,
      }),
    ).toBe(false);
  });

  it("bypasses queueing during force-send flushes", () => {
    expect(
      shouldQueuePromptWhileWorking({
        isWorking: true,
        forceSendQueuedPrompt: true,
      }),
    ).toBe(false);
  });
});
