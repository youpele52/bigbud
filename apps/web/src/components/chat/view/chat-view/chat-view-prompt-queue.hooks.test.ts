import { describe, expect, it } from "vitest";

import {
  isPromptQueueTurnInProgress,
  shouldQueuePromptWhileWorking,
} from "./chat-view-prompt-queue.hooks";

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

describe("isPromptQueueTurnInProgress", () => {
  it("treats an active session turn as active even when the latest turn appears settled", () => {
    expect(
      isPromptQueueTurnInProgress({
        activeSessionTurnRunning: true,
        isSendBusy: false,
        isRevertingCheckpoint: false,
        latestTurnSettled: true,
      }),
    ).toBe(true);
  });

  it("does not treat connection setup alone as an active turn", () => {
    expect(
      isPromptQueueTurnInProgress({
        activeSessionTurnRunning: false,
        isSendBusy: false,
        isRevertingCheckpoint: false,
        latestTurnSettled: true,
      }),
    ).toBe(false);
  });

  it("does not treat an inactive session turn as active when the latest turn is settled", () => {
    expect(
      isPromptQueueTurnInProgress({
        activeSessionTurnRunning: false,
        isSendBusy: false,
        isRevertingCheckpoint: false,
        latestTurnSettled: true,
      }),
    ).toBe(false);
  });
});
